import { nanoid } from "nanoid";
import { z } from "zod";
import { desc, lt, and, eq, type SQL } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

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
  // Accepted for wire compatibility with the hosted SaaS's SDK payload shape; self-host is
  // single-tenant so these don't gate anything here. Monitor's own trace-time check
  // (monitor/pattern_ids) is ported alongside Monitor's core logic, plan task #110.
  workspaceId: z.string().optional(),
  monitor: z.boolean().optional(),
  pattern_ids: z.array(z.string()).optional(),
});

export type IngestTraceInput = z.infer<typeof ingestTraceSchema>;

export async function ingestTrace(db: Db, payload: IngestTraceInput): Promise<{ traceId: string }> {
  const id = nanoid();
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
    createdAt: new Date(),
  };

  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.traces).values(row);
  } else {
    await db.db.insert(db.schema.traces).values(row);
  }

  return { traceId: id };
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
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
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
    source: "sdk" as const,
    createdAt: row.createdAt.toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
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

  const conditions: SQL[] = [];
  if (framework) conditions.push(eq(db.schema.traces.framework, framework));
  if (cursorCreatedAt) conditions.push(lt(db.schema.traces.createdAt, cursorCreatedAt));
  const where = conditions.length ? and(...conditions) : undefined;

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

async function getTraceRow(db: Db, id: string): Promise<TraceRow | undefined> {
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.traces).where(eq(db.schema.traces.id, id)).all()[0] as
      | TraceRow
      | undefined;
  }
  return (await db.db.select().from(db.schema.traces).where(eq(db.schema.traces.id, id)))[0] as
    | TraceRow
    | undefined;
}

// Kept for the debug listing used before pagination existed; still handy for quick local checks.
export async function listTraces(db: Db, limit = 50) {
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.traces).limit(limit).all();
  }
  return db.db.select().from(db.schema.traces).limit(limit);
}
