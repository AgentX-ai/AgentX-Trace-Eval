import { nanoid } from "nanoid";
import { z } from "zod";
import { desc, lt, and, eq, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { resolveAgentId } from "../monitor/agents.js";
import { listPortabilityModels, estimateCostUSD } from "../evaluate/models.js";
import { getClassificationForTrace } from "../monitor/topics.js";

// Mirrors the wire payload agentx.tracing.tracer.Tracer._send builds in the Python SDK
// (agentx/tracing/tracer.py); see AgentX-Python for the exact field list this was checked
// against. Deliberately permissive (most fields optional) since the SDK only ever sends what
// it actually captured.
export const ingestTraceSchema = z.object({
  name: z.string().min(1),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  latency_ms: z.number().optional(),
  framework: z.string().optional(),
  model: z.string().optional(),
  tool_calls: z.array(z.record(z.unknown())).optional(),
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
});

export type IngestTraceInput = z.infer<typeof ingestTraceSchema>;

export async function ingestTrace(db: Db, payload: IngestTraceInput): Promise<{ traceId: string; agentId: string | null }> {
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
    metadata: payload.metadata ?? null,
    sessionId: payload.session_id ?? null,
    performanceSummary: payload.performance_summary ?? null,
    inputTokens: payload.input_tokens ?? null,
    outputTokens: payload.output_tokens ?? null,
    cacheReadTokens: payload.cache_read_tokens ?? null,
    cacheWriteTokens: payload.cache_write_tokens ?? null,
    spanId: payload.span_id ?? null,
    parentSpanId: payload.parent_span_id ?? null,
    startedAt: payload.started_at_unix_nano ? new Date(Number(BigInt(payload.started_at_unix_nano) / 1_000_000n)) : null,
    createdAt: new Date(),
    agentId,
    projectId: db.projectId,
  };

  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.traces).values(row);
  } else {
    await db.db.insert(db.schema.traces).values(row);
  }

  return { traceId: id, agentId };
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
    parentSpanId: row.parentSpanId ?? undefined,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
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
    parentSpanId: row.parentSpanId ?? undefined,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
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
  { limit = 50, cursor, framework }: { limit?: number; cursor?: string; framework?: string }
) {
  const pageSize = Math.min(Math.max(limit, 1), 100);

  let cursorCreatedAt: Date | null = null;
  if (cursor) {
    const cursorRow = await getTraceRow(db, cursor);
    cursorCreatedAt = cursorRow?.createdAt ?? null;
  }

  // Root spans only: a span_tree=True SDK trace or a multi-span OTel session otherwise floods
  // this list with one row per LLM call/tool call (e.g. "LLM Call 1", "policy_lookup") instead of
  // one row per actual interaction, which reads as noise, not a trace list. A row with siblings
  // (parentSpanId set) is still fully reachable - opening the root's trace dialog fetches every
  // spanId/parentSpanId-linked row via GET /sessions/:sessionId/spans (TraceSpanTreePanel), this
  // only changes what the top-level list itself enumerates.
  const conditions: SQL[] = [isNull(db.schema.traces.parentSpanId), eq(db.schema.traces.projectId, db.projectId)];
  if (framework) conditions.push(eq(db.schema.traces.framework, framework));
  if (cursorCreatedAt) conditions.push(lt(db.schema.traces.createdAt, cursorCreatedAt));
  const where = and(...conditions);

  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select()
          .from(db.schema.traces)
          .where(where)
          .orderBy(desc(db.schema.traces.createdAt))
          .limit(pageSize + 1)
          .all()
      : await db.db
          .select()
          .from(db.schema.traces)
          .where(where)
          .orderBy(desc(db.schema.traces.createdAt))
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
