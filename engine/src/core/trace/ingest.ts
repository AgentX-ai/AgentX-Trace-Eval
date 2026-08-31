import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "./store/index.js";
import { enqueueSpan } from "./ingestQueue.js";
import { resolveAgentId } from "../monitor/agents.js";
import { listPortabilityModels, estimateCostUSD } from "../evaluate/models.js";
import { getClassificationForTrace } from "../monitor/topics.js";
import { unixNanosToDate } from "../shared/unixNano.js";
import { logger } from "../../log.js";
import { normalizeSpanKind, resolveSpanKind } from "./spanKind.js";
import { normalizeTraceSource } from "./evalTraffic.js";

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

// Payload cap (ADR-0005): unbounded inputs/outputs are what actually make the span table
// huge. Oversized fields are truncated with an explicit marker - the cap is configuration,
// the marker is not. Applied to the serialized form so nested objects count fully.
// NaN-safe: a typo'd value ("100k") must fall back to the default - Math.max(1000, NaN) is NaN,
// and slice(0, NaN) would silently replace EVERY capped field with just the truncation marker.
const fieldCharsRaw = Number(process.env.AGENTX_INGEST_MAX_FIELD_CHARS ?? 100_000);
const MAX_FIELD_CHARS = Number.isFinite(fieldCharsRaw) ? Math.max(1_000, Math.floor(fieldCharsRaw)) : 100_000;

export function capPayloadField(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_FIELD_CHARS) return value;
    return `${value.slice(0, MAX_FIELD_CHARS)}\n[agentx.truncated: field exceeded ${MAX_FIELD_CHARS} chars]`;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return value;
  }
  if (serialized.length <= MAX_FIELD_CHARS) return value;
  return { "agentx.truncated": true, preview: serialized.slice(0, MAX_FIELD_CHARS) };
}

// Builds the storable row (agent resolution, timestamps, caps) without touching storage - the
// shared half of the synchronous path below and the queued path (ingestTraceQueued).
async function prepareSpanRow(
  db: Db,
  payload: IngestTraceInput
): Promise<{ row: TraceRow; agentId: string | null }> {
  const id = nanoid();
  // Root spans only - see the agent-resolution comment in ingestTrace's original body: a child
  // span's own name must not register as its own fake agent.
  const agentId = payload.parent_span_id ? null : await resolveAgentId(db, payload.agent_id || payload.name);
  const startedAt = unixNanosToDate(payload.started_at_unix_nano);
  if (payload.started_at_unix_nano && !startedAt) {
    logger.warn(`Ignoring unparseable started_at_unix_nano "${payload.started_at_unix_nano}" on trace "${payload.name}"`);
  }
  const row: TraceRow = {
    id,
    name: payload.name,
    input: capPayloadField(payload.input ?? null),
    output: capPayloadField(payload.output ?? null),
    error: payload.error ?? null,
    latencyMs: payload.latency_ms ?? null,
    framework: payload.framework ?? null,
    model: payload.model ?? null,
    toolCalls: capPayloadField(payload.tool_calls ?? null),
    spanKind: normalizeSpanKind(payload.span_kind),
    source: normalizeTraceSource(payload.source),
    metadata: capPayloadField(payload.metadata ?? null),
    sessionId: payload.session_id ?? null,
    performanceSummary: payload.performance_summary ?? null,
    inputTokens: payload.input_tokens ?? null,
    outputTokens: payload.output_tokens ?? null,
    cacheReadTokens: payload.cache_read_tokens ?? null,
    cacheWriteTokens: payload.cache_write_tokens ?? null,
    spanId: payload.span_id ?? null,
    parentSpanId: payload.parent_span_id ?? null,
    startedAt,
    // Historical imports send real past start times; createdAt drives every window-based view,
    // so it reflects when the traffic HAPPENED, not when it was imported.
    createdAt: startedAt ?? new Date(),
    agentId,
    projectId: db.projectId,
  };
  return { row, agentId };
}

// The queued ingest path (ADR-0005): fast-path dedupe, then enqueue. `deduped: true` means the
// span was already stored (replay); `accepted: false` means the queue is full and the caller
// must answer 429. The post-ingest pipeline is the ROUTE's job, gated on the settled outcome:
// it runs only for "stored" - never for a replay, so judges cannot double-run on a replay race.
export type QueuedIngestResult = {
  traceId: string;
  agentId: string | null;
  deduped: boolean;
  accepted: boolean;
  dropped: boolean;
};

/**
 * Two-phase variant for bulk callers (OTLP): enqueue now, settle later. Awaiting `settle`
 * between enqueues would serialize one flush per span - a whole OTLP export must be IN the
 * queue before anyone waits, so its spans coalesce into shared micro-batches (ADR-0005).
 */
export async function beginIngestTraceQueued(
  db: Db,
  payload: IngestTraceInput
): Promise<{ accepted: boolean; settle: Promise<QueuedIngestResult> }> {
  if (payload.span_id) {
    // Fast-path dedupe is an optimization, not a gate: if the telemetry store is unreachable
    // the lookup fails, and the span proceeds into the queue whose flush failure is the one
    // honest, counted, 503-answered path (ADR-0005). Dedupe is still enforced at insert.
    const existing = await findTraceBySpanId(db, payload.span_id).catch(() => null);
    if (existing) {
      const result = { traceId: existing.id, agentId: existing.agentId, deduped: true, accepted: true, dropped: false };
      return { accepted: true, settle: Promise.resolve(result) };
    }
  }
  const { row, agentId } = await prepareSpanRow(db, payload);
  const { accepted, done } = enqueueSpan({ db, row });
  if (!accepted) {
    const result = { traceId: row.id, agentId, deduped: false, accepted: false, dropped: false };
    return { accepted: false, settle: Promise.resolve(result) };
  }
  const settle = done.then(async (outcome): Promise<QueuedIngestResult> => {
    if (outcome === "dropped") {
      // The batch failed its retry (telemetry store down, disk full): the span was NOT stored.
      // Reported as such so the route answers 503 and the client redelivers - never "deduped".
      return { traceId: row.id, agentId, deduped: false, accepted: true, dropped: true };
    }
    if (outcome === "deduped" && payload.span_id) {
      // Lost the idempotency conflict to a concurrent replay - report the winner, exactly as the
      // synchronous path always has.
      const winner = await findTraceBySpanId(db, payload.span_id);
      if (winner) {
        return { traceId: winner.id, agentId: winner.agentId, deduped: true, accepted: true, dropped: false };
      }
    }
    return { traceId: row.id, agentId, deduped: outcome === "deduped", accepted: true, dropped: false };
  });
  return { accepted: true, settle };
}

export async function ingestTraceQueued(db: Db, payload: IngestTraceInput): Promise<QueuedIngestResult> {
  const { settle } = await beginIngestTraceQueued(db, payload);
  return settle;
}

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
  const { row, agentId } = await prepareSpanRow(db, payload);
  const won = await traceStoreFor(db).insertSpan(row);

  if (!won && payload.span_id) {
    const winner = await findTraceBySpanId(db, payload.span_id);
    if (winner) {
      return { traceId: winner.id, agentId: winner.agentId, deduped: true };
    }
  }

  return { traceId: row.id, agentId, deduped: false };
}

async function findTraceBySpanId(db: Db, spanId: string): Promise<{ id: string; agentId: string | null } | null> {
  return (await traceStoreFor(db).findBySpanId(spanId)) ?? null;
}

export type { TraceRow } from "./store/traceStore.js";
import type { TraceRow } from "./store/traceStore.js";

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
  // NaN-safe: ?limit=abc reaches here as NaN via Number(); fall back to the default page size.
  const pageSize = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 50;
  const cursorRow = cursor ? await getTraceRow(db, cursor) : undefined;
  const rows = await traceStoreFor(db).listRootsPage({
    pageSize,
    cursor: cursorRow ? { createdAt: cursorRow.createdAt, id: cursorRow.id } : null,
    framework,
    source,
    searchTerm: search,
  });
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
  return traceStoreFor(db).getById(id);
}

// Every span belonging to one OTel trace (sessionId = the OTel traceId, see otel/mapping.ts's
// otelSpanToIngestInput) - deliberately not part of listTracesPaginated's cursor pagination (capped
// at 100/page, no sessionId filter): a session's spans need one unbounded fetch to assemble a tree
// from, not a page. Ordered by startedAt (real span start) where available, falling back to
// createdAt for any row that predates this column or came from a non-OTel source - irrelevant in
// practice since a session only ever contains OTel-ingested rows, but keeps the ordering total
// rather than undefined for a row with a null startedAt.
export async function listSessionSpans(db: Db, sessionId: string) {
  const rows = await traceStoreFor(db).listBySession(sessionId);
  rows.sort((a, b) => (a.startedAt ?? a.createdAt).getTime() - (b.startedAt ?? b.createdAt).getTime());
  return rows.map(toTraceDetailWire);
}

// Kept for the debug listing used before pagination existed; still handy for quick local checks.
export async function listTraces(db: Db, limit = 50) {
  return traceStoreFor(db).listRecent(limit);
}
