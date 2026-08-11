import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

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
  return {
    _id: row.id,
    name: row.name,
    url: row.url,
    headers: (row.headers as Record<string, string> | null) ?? {},
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
  };
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
    headers: input.headers !== undefined ? input.headers : existing.headers,
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

export type AgentConnectorResponse = { output: string; toolCalls?: unknown; error?: string };

// Throws on any failure (network error, timeout, non-2xx, missing string `output`) - same posture
// as callCustomEvaluator; callers (runDatasetAgainstConnector, the dashboard's test-connection
// route) decide how to present/isolate a failure.
export async function callAgentConnector(
  connector: Pick<AgentConnectorRow, "url" | "headers" | "timeoutMs">,
  payload: AgentConnectorRequest
): Promise<AgentConnectorResponse> {
  const res = await fetch(connector.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...((connector.headers as Record<string, string> | null) ?? {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(connector.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Agent connector ${connector.url} responded ${res.status}`);
  }
  const body = (await res.json()) as { output?: unknown; toolCalls?: unknown; error?: unknown };
  if (typeof body.output !== "string") {
    throw new Error(`Agent connector ${connector.url} response missing a string "output" field`);
  }
  return {
    output: body.output,
    toolCalls: body.toolCalls,
    error: typeof body.error === "string" ? body.error : undefined,
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
