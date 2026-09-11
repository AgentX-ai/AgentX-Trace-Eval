import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { maskSecret, isMaskedSecret } from "../shared/maskSecret.js";
import { outboundUrlProblem } from "../shared/urlGuard.js";

// "How to invoke my deployed agent" - modeled directly on core/monitor/customEvaluators.ts's CRUD
// shape (same webhook-config idea, different contract: a connector returns an agent's answer to
// a question, not a boolean verdict). Lets an offline eval run be driven end to end from the
// dashboard (core/evaluate/connectorRun.ts's runDatasetAgainstConnector) instead of requiring a
// human to manually run the agent and push results via the SDK first.
export type CreateAgentConnectorInput = {
  name: string;
  url: string;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
};

export type UpdateAgentConnectorInput = Partial<CreateAgentConnectorInput>;

export type AgentConnectorRow = {
  id: string;
  projectId: string | null;
  name: string;
  url: string;
  headers: unknown;
  timeoutMs: number;
  createdAt: Date;
};

function toWire(row: AgentConnectorRow) {
  // Header VALUES are where bearer tokens live - the one purpose of the field. Every other
  // stored secret masks on read (provider keys, per-model keys); echoing these verbatim put a
  // production credential in every GET, and the NDJSON export redacts the values outright (core/export/exportData.ts). Keys stay readable so the
  // editor can list what's set; a masked value sent back on PUT means "unchanged".
  const headers = (row.headers as Record<string, string> | null) ?? {};
  return {
    _id: row.id,
    name: row.name,
    url: row.url,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, maskSecret(String(v))])),
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
  };
}


// PUT round-trips: a value that still carries the read-side mask means "keep what's stored".
function unmaskHeaders(incoming: Record<string, string> | null, stored: unknown): Record<string, string> | null {
  if (!incoming) return incoming;
  const previous = (stored as Record<string, string> | null) ?? {};
  return Object.fromEntries(
    Object.entries(incoming).map(([k, v]) => [k, isMaskedSecret(v) && previous[k] !== undefined ? previous[k]! : v])
  );
}

export async function createAgentConnector(db: Db, input: CreateAgentConnectorInput) {
  const row: AgentConnectorRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    url: input.url,
    headers: input.headers ?? null,
    // A real agent call is heavier than Custom Evaluators' verdict check (retrieval, tool use,
    // multiple LLM calls) - 30s default instead of that 8s, still overridable per connector.
    timeoutMs: input.timeoutMs ?? 30000,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.agentConnectors).values(row);
  } else {
    await db.db.insert(db.schema.agentConnectors).values(row);
  }
  return toWire(row);
}

export async function getAgentConnectorRow(db: Db, id: string): Promise<AgentConnectorRow | null> {
  const cond = and(eq(db.schema.agentConnectors.id, id), eq(db.schema.agentConnectors.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.agentConnectors).where(cond).all()[0] as AgentConnectorRow | undefined)
      : ((await db.db.select().from(db.schema.agentConnectors).where(cond))[0] as AgentConnectorRow | undefined);
  return row ?? null;
}

export async function getAgentConnector(db: Db, id: string) {
  const row = await getAgentConnectorRow(db, id);
  return row ? toWire(row) : null;
}

export async function listAgentConnectorRows(db: Db): Promise<AgentConnectorRow[]> {
  const cond = eq(db.schema.agentConnectors.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.agentConnectors).where(cond).all()
      : await db.db.select().from(db.schema.agentConnectors).where(cond);
  return rows as AgentConnectorRow[];
}

export async function listAgentConnectorsWire(db: Db) {
  return (await listAgentConnectorRows(db)).map(toWire);
}

export async function updateAgentConnector(db: Db, id: string, input: UpdateAgentConnectorInput) {
  const existing = await getAgentConnectorRow(db, id);
  if (!existing) {
    return null;
  }
  const updated: AgentConnectorRow = {
    ...existing,
    name: input.name ?? existing.name,
    url: input.url ?? existing.url,
    headers: input.headers !== undefined ? unmaskHeaders(input.headers, existing.headers) : existing.headers,
    timeoutMs: input.timeoutMs ?? existing.timeoutMs,
  };
  const setValues = { name: updated.name, url: updated.url, headers: updated.headers, timeoutMs: updated.timeoutMs };
  const updateCond = and(eq(db.schema.agentConnectors.id, id), eq(db.schema.agentConnectors.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.agentConnectors).set(setValues).where(updateCond);
  } else {
    await db.db.update(db.schema.agentConnectors).set(setValues).where(updateCond);
  }
  return toWire(updated);
}

export async function deleteAgentConnector(db: Db, id: string): Promise<boolean> {
  const existing = await getAgentConnectorRow(db, id);
  if (!existing) {
    return false;
  }
  const deleteCond = and(eq(db.schema.agentConnectors.id, id), eq(db.schema.agentConnectors.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.agentConnectors).where(deleteCond);
  } else {
    await db.db.delete(db.schema.agentConnectors).where(deleteCond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The HTTP call itself - same fetch/timeout/response-validation shape as
// customEvaluators.ts's callCustomEvaluator, different contract: this returns the agent's answer
// text, not a match verdict.
// ---------------------------------------------------------------------------

export type AgentConnectorRequest = {
  query: string;
  // Threaded turns before the final question, for multi-turn dataset cases - empty/omitted for a
  // single-turn question. The connector is expected to return only the final turn's answer.
  conversationHistory?: { role: "user" | "assistant"; content: string }[];
};

// `traceId` and the token counts are optional, and everything works without them - but a
// connector that returns them gets the same result rows an SDK-pushed run produces. Without a
// traceId the engine cannot render the agent's execution path into the judge prompt
// (core/evaluate/runs.ts) or link the result to its trace in the dashboard, so a connector-driven
// run was judged blind to tool use and showed blank latency/token columns, purely because the
// contract had nowhere to put values the caller already had.
export type AgentConnectorResponse = {
  output: string;
  toolCalls?: unknown;
  error?: string;
  traceId?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
};

// One agent answer plus metadata - 2MB is far beyond any real one, and without a cap a hostile
// or misconfigured endpoint streams unbounded bytes into this process's memory.
const MAX_CONNECTOR_RESPONSE_BYTES = 2 * 1024 * 1024;

// Reads up to the cap, then cancels the transfer - checking content-length alone would miss
// chunked responses, and res.text() would have buffered everything before any length check ran.
async function readConnectorBody(res: Response, url: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CONNECTOR_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`Agent connector ${url} response exceeded ${MAX_CONNECTOR_RESPONSE_BYTES / (1024 * 1024)}MB - aborted`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Throws on any failure (refused URL, network error, timeout, non-2xx, oversized body, missing
// string `output`) - same posture as callCustomEvaluator; callers (runDatasetAgainstConnector,
// the dashboard's test-connection route) decide how to present/isolate a failure.
export async function callAgentConnector(
  connector: Pick<AgentConnectorRow, "url" | "headers" | "timeoutMs">,
  payload: AgentConnectorRequest
): Promise<AgentConnectorResponse> {
  // Checked per call, not only at write time: a stored URL outlives any posture change, and the
  // error string lands in the run result where the operator can see WHY the case failed.
  const urlProblem = outboundUrlProblem(connector.url);
  if (urlProblem) {
    throw new Error(`Agent connector URL refused (${connector.url}): ${urlProblem}`);
  }
  const res = await fetch(connector.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...((connector.headers as Record<string, string> | null) ?? {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(connector.timeoutMs),
    // The URL was vetted, a redirect target was not - never follow one (same posture as
    // core/monitor/webhooks.ts). A 3xx surfaces below as a non-2xx failure.
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`Agent connector ${connector.url} responded ${res.status}`);
  }
  const raw = await readConnectorBody(res, connector.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Agent connector ${connector.url} did not return a JSON object`);
  }
  const body = parsed as {
    output?: unknown;
    toolCalls?: unknown;
    error?: unknown;
    traceId?: unknown;
    trace_id?: unknown;
    inputTokens?: unknown;
    input_tokens?: unknown;
    outputTokens?: unknown;
    output_tokens?: unknown;
    latencyMs?: unknown;
    latency_ms?: unknown;
  };
  if (typeof body.output !== "string") {
    throw new Error(`Agent connector ${connector.url} response missing a string "output" field`);
  }
  // snake_case accepted alongside camelCase: a connector is usually somebody's Python or Go
  // service, and rejecting `trace_id` would make the field unusable for exactly the callers most
  // likely to send it.
  const num = (a: unknown, b: unknown): number | undefined => {
    const v = typeof a === "number" ? a : typeof b === "number" ? b : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const str = (a: unknown, b: unknown): string | undefined =>
    typeof a === "string" && a ? a : typeof b === "string" && b ? b : undefined;
  return {
    output: body.output,
    toolCalls: body.toolCalls,
    error: typeof body.error === "string" ? body.error : undefined,
    traceId: str(body.traceId, body.trace_id),
    inputTokens: num(body.inputTokens, body.input_tokens),
    outputTokens: num(body.outputTokens, body.output_tokens),
    latencyMs: num(body.latencyMs, body.latency_ms),
  };
}

export type TestAgentConnectorResult = { live: boolean; output?: string; error?: string };

// "Test connection" (the dashboard's connector form) - a synthetic ping before the connector is
// ever used in a real run. Never throws: any failure becomes {live: false, error}, same "always
// 200, always renderable" posture as core/evaluate/models.ts's testCustomModelConnection.
export async function testAgentConnectorConnection(
  connector: Pick<AgentConnectorRow, "url" | "headers" | "timeoutMs">
): Promise<TestAgentConnectorResult> {
  try {
    const result = await callAgentConnector(connector, { query: "Hello - this is a connection test from AgentX." });
    return { live: true, output: result.output };
  } catch (err) {
    return { live: false, error: err instanceof Error ? err.message : "Connection failed" };
  }
}
