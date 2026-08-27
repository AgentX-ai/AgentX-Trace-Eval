import { nanoid } from "nanoid";
import { z } from "zod";
import { desc, lt, and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { resolveAgentId } from "../monitor/agents.js";
import { listPortabilityModels, estimateCostUSD } from "../evaluate/models.js";
import { getClassificationForTrace } from "../monitor/topics.js";
import { unixNanosToDate } from "../shared/unixNano.js";
import { logger } from "../../log.js";
import { normalizeSpanKind, resolveSpanKind } from "./spanKind.js";
import { EVAL_RUN_SOURCE, normalizeTraceSource, productionTracesOnly } from "./evalTraffic.js";

// Mirrors the wire payload agentx.tracing.tracer.Tracer._send builds in the Python SDK
// (agentx/tracing/tracer.py); see AgentX-Python for the exact field list this was checked
// against. Deliberately permissive (most fields optional) since the SDK only ever sends what
// it actually captured.
//
// Casing: the project's wire convention is camelCase (every read endpoint already is), and this
// write path historically spoke snake_case - the one seam. Both are accepted here: camelCase is
// canonical, the snake_case keys stay as legacy aliases for the existing SDKs and the hosted
// platform's payload shape. The preprocess below folds camelCase twins onto the snake_case
// schema keys so nothing downstream changes.
const INGEST_CAMEL_ALIASES: Record<string, string> = {
  latencyMs: "latency_ms",
  toolCalls: "tool_calls",
  sessionId: "session_id",
  performanceSummary: "performance_summary",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheWriteTokens: "cache_write_tokens",
  spanId: "span_id",
  spanKind: "span_kind",
  parentSpanId: "parent_span_id",
  startedAtUnixNano: "started_at_unix_nano",
  patternIds: "pattern_ids",
  agentId: "agent_id",
};

function foldCamelAliases(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  let folded: Record<string, unknown> | null = null;
  for (const [camel, snake] of Object.entries(INGEST_CAMEL_ALIASES)) {
    if (record[camel] !== undefined && record[snake] === undefined) {
      folded = folded ?? { ...record };
      folded[snake] = record[camel];
    }
  }
  return folded ?? record;
}

export const ingestTraceSchema = z.preprocess(foldCamelAliases, z.object({
  name: z.string().min(1),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  latency_ms: z.number().optional(),
  framework: z.string().optional(),
  model: z.string().optional(),
  tool_calls: z.array(z.record(z.unknown())).optional(),
  // What kind of step this is, stated by the producer: "llm" | "tool" | "retrieval" | "agent" |
  // ... Other vocabularies (OpenInference, OTel GenAI, Langfuse, MLflow) are folded onto ours by
  // normalizeSpanKind, so an already-instrumented span does not need the producer to change.
  // Unrecognized values are stored as null rather than as a fact nobody stated.
  span_kind: z.string().optional(),
  // Where this trace came from. "eval-run" marks traffic produced inside an offline evaluation
  // run (the SDK's execute() stamps it); the monitor surfaces exclude it. Unknown words store as
  // null rather than as a category nobody defined.
  source: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  session_id: z.string().optional(),
  performance_summary: z.record(z.unknown()).optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  // Subsets of input_tokens (not additional tokens) - a prompt-caching write/read, when the
  // provider reports one (Anthropic's cache_creation/cache_read_input_tokens, OpenAI's
  // prompt_tokens_details.cached_tokens, Gemini's cached_content_token_count - see AgentX-Python's
  // per-integration usage extraction). Priced separately by estimateCostUSD (core/evaluate/
  // models.ts) when the model's catalog row has its own cache rate configured, otherwise falls
  // back to the regular input rate - same $ as before this field existed.
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  // Real span hierarchy - sent by the OTel ingestion path (routes/otlp.ts via
  // otel/mapping.ts's otelSpanToIngestInput) unconditionally, and by the Python SDK's own
  // tracer.trace() when a caller opts into span_tree=True (see AgentX-Python's tracer.py) so
  // nested spans link to a real parent instead of folding into one row's performance_summary.
  // started_at_unix_nano is a string (matches how OTel's own nano timestamps arrive on the wire,
  // see otel/normalize.ts) since it exceeds safe-integer precision as a JS number - the SDK sends
  // the same string shape for consistency, even though Python's own precision would fit a number.
  span_id: z.string().optional(),
  parent_span_id: z.string().optional(),
  started_at_unix_nano: z.string().optional(),
  // Accepted for wire compatibility with the hosted SaaS's SDK payload shape; self-host is
  // single-tenant so these don't gate anything here. Monitor's own trace-time check
  // (monitor/pattern_ids) is ported alongside Monitor's core logic, plan task #110.
  workspaceId: z.string().optional(),
  monitor: z.boolean().optional(),
  pattern_ids: z.array(z.string()).optional(),
  // Optional disambiguator (client.tracer.trace(name, agent_id=...)) for when `name` alone isn't
  // enough - e.g. two deliberately-registered agents sharing a display name (core/monitor/
  // agents.ts). Omitted (the default, and every pre-registry caller's only option): resolved from
  // `name` alone via resolveAgentId, identical to this engine's behavior before agent ids existed.
  agent_id: z.string().optional(),
}));

export type IngestTraceInput = z.infer<typeof ingestTraceSchema>;

export async function ingestTrace(
  db: Db,
  payload: IngestTraceInput
): Promise<{ traceId: string; agentId: string | null; deduped: boolean }> {
  // Idempotent re-ingest: a client-supplied span_id is a stable identity (OTel span ids, and
  // importers like the SDK's Moveworks Data API sync use deterministic ids), so replaying the
  // same span updates nothing and returns the existing row instead of inserting a duplicate.
  // `deduped: true` also tells the route to SKIP the background monitor/evaluator passes - a
  // replayed span was already checked and judged when it first arrived, and re-running them
  // double-bills every judge call and double-counts every event.
  if (payload.span_id) {
    const existing = await findTraceBySpanId(db, payload.span_id);
    if (existing) {
      return { traceId: existing.id, agentId: existing.agentId, deduped: true };
    }
  }
  const id = nanoid();
  // Root spans only: a span_tree=True SDK trace or a multi-span OTel session sends one row per
  // LLM call/tool call too (e.g. "LLM Call 1", "policy_lookup", each its own parentSpanId-linked
  // trace) - resolving/creating a real agent from a *child* span's own name would register each
  // of those as its own fake agent, flooding the Agents tab with tool/LLM-call names instead of
  // real agents. Same "child spans are sub-detail, not top-level entities" rule
  // listTracesPaginated already applies to the Observe tab's trace list (isNull(parentSpanId)) -
  // applied here too. Root traces are unaffected; the vast majority of ingested traces (anything
  // not using span_tree=True/OTel multi-span) have no parent_span_id at all.
  const agentId = payload.parent_span_id ? null : await resolveAgentId(db, payload.agent_id || payload.name);
  // Dropped, not fatal: losing a whole span over one bad field hides exactly the traffic an
  // operator is trying to debug. The warning is what surfaces the client-side bug.
  const startedAt = unixNanosToDate(payload.started_at_unix_nano);
  if (payload.started_at_unix_nano && !startedAt) {
    logger.warn(`Ignoring unparseable started_at_unix_nano "${payload.started_at_unix_nano}" on trace "${payload.name}"`);
  }
  const row = {
    id,
    name: payload.name,
    input: payload.input ?? null,
    output: payload.output ?? null,
    error: payload.error ?? null,
    latencyMs: payload.latency_ms ?? null,
    framework: payload.framework ?? null,
    model: payload.model ?? null,
    toolCalls: payload.tool_calls ?? null,
    spanKind: normalizeSpanKind(payload.span_kind),
    source: normalizeTraceSource(payload.source),
    metadata: payload.metadata ?? null,
    sessionId: payload.session_id ?? null,
    performanceSummary: payload.performance_summary ?? null,
    inputTokens: payload.input_tokens ?? null,
    outputTokens: payload.output_tokens ?? null,
    cacheReadTokens: payload.cache_read_tokens ?? null,
    cacheWriteTokens: payload.cache_write_tokens ?? null,
    spanId: payload.span_id ?? null,
    parentSpanId: payload.parent_span_id ?? null,
    startedAt,
    // Historical imports (Moveworks Data API sync and any future backfill) send real past
    // start times; createdAt drives every window-based view (cost chart, sessions, top failing),
    // so it must reflect when the traffic HAPPENED, not when it was imported. Live traffic's
    // startedAt is "now" anyway, so this is byte-identical for the normal path.
    createdAt: startedAt ?? new Date(),
    agentId,
    projectId: db.projectId,
  };

  // The check above is a fast path, not a guarantee: on Postgres concurrent replays of one span -
  // the exact traffic it exists for - all get past it. ON CONFLICT against the
  // traces(project_id, span_id) index decides the winner; an empty RETURNING means this call lost,
  // so report the row the winner wrote. Traces with no span_id never conflict.
  const inserted = (
    db.kind === "sqlite"
      ? db.db.insert(db.schema.traces).values(row).onConflictDoNothing().returning({ id: db.schema.traces.id }).all()
      : await db.db.insert(db.schema.traces).values(row).onConflictDoNothing().returning({ id: db.schema.traces.id })
  ) as { id: string }[];

  if (!inserted[0] && payload.span_id) {
    const winner = await findTraceBySpanId(db, payload.span_id);
    if (winner) {
      return { traceId: winner.id, agentId: winner.agentId, deduped: true };
    }
  }

  return { traceId: id, agentId, deduped: false };
}

async function findTraceBySpanId(db: Db, spanId: string): Promise<{ id: string; agentId: string | null } | null> {
  const cond = and(eq(db.schema.traces.spanId, spanId), eq(db.schema.traces.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.traces.id, agentId: db.schema.traces.agentId }).from(db.schema.traces).where(cond).limit(1).all()
      : await db.db.select({ id: db.schema.traces.id, agentId: db.schema.traces.agentId }).from(db.schema.traces).where(cond).limit(1)
  ) as { id: string; agentId: string | null }[];
  return rows[0] ?? null;
}

export type TraceRow = {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
  latencyMs: number | null;
  framework: string | null;
  model: string | null;
  toolCalls: unknown;
  metadata: unknown;
  sessionId: string | null;
  performanceSummary: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  spanId: string | null;
  spanKind: string | null;
  source: string | null;
  parentSpanId: string | null;
  startedAt: Date | null;
  createdAt: Date;
  agentId: string | null;
  projectId: string | null;
};

// Matches AgentX-web-front's ProductionTrace type (src/types/evaluate.ts): _id not id, no
// workspaceId/performanceSummary/metadata on the wire (the dashboard's trace list doesn't need
// them), source is always "sdk" here since self-host has no native-agent concept to distinguish.
function toWire(row: TraceRow) {
  return {
    _id: row.id,
    name: row.name,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    latencyMs: row.latencyMs ?? undefined,
    error: row.error ?? undefined,
    framework: row.framework ?? undefined,
    model: row.model ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    sessionId: row.sessionId ?? undefined,
    spanId: row.spanId ?? undefined,
    // Always resolved, never the raw column: the engine classifies once, so no reader has to
    // re-derive it and disagree (see core/trace/spanKind.ts).
    spanKind: resolveSpanKind(row),
    parentSpanId: row.parentSpanId ?? undefined,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    // "eval-run" for traces produced inside an offline evaluation; absent for production.
    trafficSource: row.source ?? undefined,
    source: "sdk" as const,
    createdAt: row.createdAt.toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

// Full single-trace detail for the self-host TraceDialog (routes/ingest.ts's GET /traces/:id) -
// unlike toWire() above (list view, deliberately lean), this includes performanceSummary and
// metadata, the fields the detail view actually needs. Same field-naming convention as toWire()
// (inputTokens not inputTokenSize, etc.) rather than matching AgentX-web-front's IPromptTrace
// type's hosted-platform-era field names directly - useGetSelfHostTrace.ts on the frontend maps
// this into that shape, keeping this wire contract independent of one frontend type's naming.
export function toTraceDetailWire(row: TraceRow) {
  return {
    _id: row.id,
    name: row.name,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    latencyMs: row.latencyMs ?? undefined,
    error: row.error ?? undefined,
    framework: row.framework ?? undefined,
    model: row.model ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    sessionId: row.sessionId ?? undefined,
    spanId: row.spanId ?? undefined,
    spanKind: resolveSpanKind(row),
    parentSpanId: row.parentSpanId ?? undefined,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    trafficSource: row.source ?? undefined,
    metadata: row.metadata ?? undefined,
    performanceSummary: row.performanceSummary ?? undefined,
    source: "sdk" as const,
    createdAt: row.createdAt.toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens ?? undefined,
    cacheWriteTokens: row.cacheWriteTokens ?? undefined,
  };
}

// Single-trace detail only (GET /traces/:traceId) - not listTracesPaginated's list view (toWire
// above), which is kept lookup-free to avoid an N-model-lookup cost per page. Reuses the exact
// same pricing source and estimateCostUSD math as Overview's "Total LLM cost" chart (core/monitor/
// cost.ts), so a trace's estimated cost here always agrees with what it contributed there.
// Unpriced (model missing from the catalog) or token-less rows (e.g. a tool-call child span)
// return null, not 0 - "no cost data," not "free."
export async function toTraceDetailWireWithCost(db: Db, row: TraceRow) {
  const wire = toTraceDetailWire(row);
  // Topics classification (core/monitor/topics.ts) - opt-in per agent and still sampled even when
  // on, so most traces have none; toWire's own field stays undefined rather than null in that
  // case, matching every other optional field on this wire object.
  const classification = await getClassificationForTrace(db, row.id);
  const topic = classification
    ? { intent: classification.intent, sentiment: classification.sentiment, issueType: classification.issueType }
    : undefined;
  if (!row.model || row.inputTokens == null || row.outputTokens == null) {
    return { ...wire, estimatedCostUSD: null, topic };
  }
  const pricingModels = await listPortabilityModels(db);
  const pricing = pricingModels.find(m => m.id === row.model) ?? null;
  return {
    ...wire,
    estimatedCostUSD: estimateCostUSD(pricing, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens),
    topic,
  };
}

// Cursor-paginated for AgentX-web-front's useGetProductionTraces (src/data/queries/evaluate/
// useGetProductionTraces.ts): newest first, cursor is the last-seen trace id, page size `limit`.
// Not part of the SDK-compatible surface (the SDK only ever POSTs to this path, never GETs), so
// evolving this GET response shape for the dashboard doesn't risk SDK compatibility.
export async function listTracesPaginated(
  db: Db,
  {
    limit = 50,
    cursor,
    framework,
    search,
    source,
  }: { limit?: number; cursor?: string; framework?: string; search?: string; source?: "production" | "eval" | "all" }
) {
  const pageSize = Math.min(Math.max(limit, 1), 100);

  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    const cursorRow = await getTraceRow(db, cursor);
    cursorCreatedAt = cursorRow?.createdAt ?? null;
    cursorId = cursorRow?.id ?? null;
  }

  // Root spans only: a span_tree=True SDK trace or a multi-span OTel session otherwise floods
  // this list with one row per LLM call/tool call (e.g. "LLM Call 1", "policy_lookup") instead of
  // one row per actual interaction, which reads as noise, not a trace list. A row with siblings
  // (parentSpanId set) is still fully reachable - opening the root's trace dialog fetches every
  // spanId/parentSpanId-linked row via GET /sessions/:sessionId/spans (TraceSpanTreePanel), this
  // only changes what the top-level list itself enumerates.
  const conditions: SQL[] = [isNull(db.schema.traces.parentSpanId), eq(db.schema.traces.projectId, db.projectId)];
  if (framework) conditions.push(eq(db.schema.traces.framework, framework));
  // "production" (the Live Traces default) hides eval-run traffic; "eval" shows only it; "all"
  // (and absent, for SDK/API compatibility) filters nothing.
  if (source === "production") conditions.push(productionTracesOnly(db));
  if (source === "eval") conditions.push(eq(db.schema.traces.source, EVAL_RUN_SOURCE));
  // Database-side search (the dashboard's Live Traces box) - a LIKE across the columns a person
  // actually greps traffic by: agent name, input/output text, model, error, and the trace/session
  // ids (so a pasted id resolves). SQLite LIKE is already case-insensitive for ASCII; Postgres
  // needs ILIKE. Wildcards in the term are escaped, so searching "100%" matches literally.
  // The keyset cursor below composes with this - the frontend keys its infinite query on the
  // term, so a changed term restarts pagination from the top.
  const term = search?.trim();
  if (term) {
    const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const t = db.schema.traces;
    const columns = [t.name, t.input, t.output, t.model, t.error, t.id, t.sessionId];
    // Explicit ESCAPE: SQLite's LIKE has no default escape character, so the backslash escaping
    // above would otherwise be matched literally there.
    const searchCond = or(
      ...columns.map(column =>
        db.kind === "sqlite"
          ? sql`${column} LIKE ${pattern} ESCAPE '\\'`
          : sql`${column} ILIKE ${pattern} ESCAPE '\\'`
      )
    );
    if (searchCond) conditions.push(searchCond);
  }
  // Keyset with an id tiebreak, matching the (createdAt DESC, id DESC) sort below. The old
  // createdAt-only predicate silently skipped every row that shared the page-boundary row's
  // millisecond (3 of 2000 lost in a realistic burst - deep-dive round 3, bug #6), because
  // "strictly older than the boundary" excludes its same-timestamp siblings.
  if (cursorCreatedAt && cursorId) {
    const next = or(
      lt(db.schema.traces.createdAt, cursorCreatedAt),
      and(eq(db.schema.traces.createdAt, cursorCreatedAt), lt(db.schema.traces.id, cursorId))
    );
    if (next) conditions.push(next);
  }
  const where = and(...conditions);

  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select()
          .from(db.schema.traces)
          .where(where)
          .orderBy(desc(db.schema.traces.createdAt), desc(db.schema.traces.id))
          .limit(pageSize + 1)
          .all()
      : await db.db
          .select()
          .from(db.schema.traces)
          .where(where)
          .orderBy(desc(db.schema.traces.createdAt), desc(db.schema.traces.id))
          .limit(pageSize + 1)
  ) as TraceRow[];

  const hasNextPage = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  return {
    traces: page.map(toWire),
    hasNextPage,
    nextCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// Exported for core/evaluate/portability.ts's model-portability check, which needs the raw
// input/metadata/model/tokens a single trace actually captured - everything listTracesPaginated's
// own use of this (cursor resolution) doesn't need.
export async function getTraceRow(db: Db, id: string): Promise<TraceRow | undefined> {
  const cond = and(eq(db.schema.traces.id, id), eq(db.schema.traces.projectId, db.projectId));
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.traces).where(cond).all()[0] as TraceRow | undefined;
  }
  return (await db.db.select().from(db.schema.traces).where(cond))[0] as TraceRow | undefined;
}

// Every span belonging to one OTel trace (sessionId = the OTel traceId, see otel/mapping.ts's
// otelSpanToIngestInput) - deliberately not part of listTracesPaginated's cursor pagination (capped
// at 100/page, no sessionId filter): a session's spans need one unbounded fetch to assemble a tree
// from, not a page. Ordered by startedAt (real span start) where available, falling back to
// createdAt for any row that predates this column or came from a non-OTel source - irrelevant in
// practice since a session only ever contains OTel-ingested rows, but keeps the ordering total
// rather than undefined for a row with a null startedAt.
export async function listSessionSpans(db: Db, sessionId: string) {
  const cond = and(eq(db.schema.traces.sessionId, sessionId), eq(db.schema.traces.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond)
  ) as TraceRow[];
  rows.sort((a, b) => (a.startedAt ?? a.createdAt).getTime() - (b.startedAt ?? b.createdAt).getTime());
  return rows.map(toTraceDetailWire);
}

// Kept for the debug listing used before pagination existed; still handy for quick local checks.
export async function listTraces(db: Db, limit = 50) {
  const cond = eq(db.schema.traces.projectId, db.projectId);
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.traces).where(cond).limit(limit).all();
  }
  return db.db.select().from(db.schema.traces).where(cond).limit(limit);
}
