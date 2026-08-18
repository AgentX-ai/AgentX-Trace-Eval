import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { pruneRetentionData } from "../core/monitor/events.js";
import type { Db } from "../storage/db.js";

// The only code here that deletes a user's telemetry, run as a side effect of ingest rather than
// on a schedule anyone watches. Too eager and traffic disappears with no record; a scoping mistake
// takes another project's with it. Driven directly, since no route writes rows at chosen times.

let test: TestDb;
let projectA: string;
let projectB: string;
let dbA: Db;
let dbB: Db;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// The Db type is a union of a sqlite-shaped and a pg-shaped handle, so an insert has to be
// narrowed on db.kind before it is callable - the same branch every core module writes.
async function insertRow(db: Db, table: unknown, values: Record<string, unknown>): Promise<void> {
  if (db.kind === "sqlite") {
    await db.db.insert(table as Parameters<typeof db.db.insert>[0]).values(values as never);
  } else {
    await db.db.insert(table as Parameters<typeof db.db.insert>[0]).values(values as never);
  }
}

async function insertTrace(db: Db, opts: { agentId: string | null; createdAt: Date; name?: string }): Promise<string> {
  const id = nanoid();
  await insertRow(db, db.schema.traces, {
    id,
    name: opts.name ?? "retention-agent",
    input: "q",
    output: "a",
    error: null,
    latencyMs: 100,
    framework: null,
    model: null,
    toolCalls: null,
    metadata: null,
    sessionId: null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanId: null,
    parentSpanId: null,
    startedAt: opts.createdAt,
    createdAt: opts.createdAt,
    agentId: opts.agentId,
    projectId: db.projectId,
  });
  return id;
}

async function insertEvent(db: Db, opts: { agentId: string | null; createdAt: Date }): Promise<string> {
  const id = nanoid();
  await insertRow(db, db.schema.monitorEvents, {
    id,
    projectId: db.projectId,
    signalId: null,
    patternKey: "healthy-response",
    type: "healthy_response",
    severity: "low",
    polarity: "proper",
    agentId: opts.agentId,
    traceId: null,
    createdAt: opts.createdAt,
    onlineEvaluatorId: null,
    rating: null,
    justification: null,
    customEvaluatorId: null,
    matched: null,
    score: null,
    sessionId: null,
  });
  return id;
}

async function traceIds(db: Db): Promise<string[]> {
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.traces.id }).from(db.schema.traces).where(eq(db.schema.traces.projectId, db.projectId)).all()
      : await db.db.select({ id: db.schema.traces.id }).from(db.schema.traces).where(eq(db.schema.traces.projectId, db.projectId))
  ) as { id: string }[];
  return rows.map(r => r.id);
}

async function eventIds(db: Db): Promise<string[]> {
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.monitorEvents.id }).from(db.schema.monitorEvents).where(eq(db.schema.monitorEvents.projectId, db.projectId)).all()
      : await db.db.select({ id: db.schema.monitorEvents.id }).from(db.schema.monitorEvents).where(eq(db.schema.monitorEvents.projectId, db.projectId))
  ) as { id: string }[];
  return rows.map(r => r.id);
}

beforeAll(async () => {
  test = await openTestDb();
  projectA = await test.newProject("Retention A");
  projectB = await test.newProject("Retention B");
  dbA = test.scoped(projectA);
  dbB = test.scoped(projectB);
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("pruneRetentionData", () => {
  it("deletes telemetry older than the window and keeps what is inside it", async () => {
    const agentId = "agent-window";
    const old = await insertTrace(dbA, { agentId, createdAt: daysAgo(40) });
    const recent = await insertTrace(dbA, { agentId, createdAt: daysAgo(3) });
    const oldEvent = await insertEvent(dbA, { agentId, createdAt: daysAgo(40) });
    const recentEvent = await insertEvent(dbA, { agentId, createdAt: daysAgo(3) });

    await pruneRetentionData(dbA, agentId, 30);

    const traces = await traceIds(dbA);
    expect(traces).not.toContain(old);
    expect(traces).toContain(recent);
    const events = await eventIds(dbA);
    expect(events).not.toContain(oldEvent);
    expect(events).toContain(recentEvent);
  });

  it("keeps a row sitting just inside the cutoff", async () => {
    const agentId = "agent-boundary";
    const justInside = await insertTrace(dbA, { agentId, createdAt: daysAgo(29.9) });
    await pruneRetentionData(dbA, agentId, 30);
    expect(await traceIds(dbA)).toContain(justInside);
  });

  it("treats retentionDays <= 0 as forever rather than as a cutoff of right now", async () => {
    const agentId = "agent-forever";
    const ancient = await insertTrace(dbA, { agentId, createdAt: daysAgo(3650) });
    const ancientEvent = await insertEvent(dbA, { agentId, createdAt: daysAgo(3650) });

    await pruneRetentionData(dbA, agentId, 0);
    await pruneRetentionData(dbA, agentId, -1);

    expect(await traceIds(dbA)).toContain(ancient);
    expect(await eventIds(dbA)).toContain(ancientEvent);
  });

  it("never touches another project's data, even for the same agent id", async () => {
    // Agent ids are per project, but nothing stops the same string appearing in two - and a
    // missing project filter on a DELETE is silent and unrecoverable.
    const agentId = "shared-agent-id";
    const mine = await insertTrace(dbA, { agentId, createdAt: daysAgo(60) });
    const theirs = await insertTrace(dbB, { agentId, createdAt: daysAgo(60) });
    const theirEvent = await insertEvent(dbB, { agentId, createdAt: daysAgo(60) });

    await pruneRetentionData(dbA, agentId, 30);

    expect(await traceIds(dbA)).not.toContain(mine);
    expect(await traceIds(dbB), "another project's traces were deleted").toContain(theirs);
    expect(await eventIds(dbB), "another project's events were deleted").toContain(theirEvent);
  });

  it("only prunes the agent it was asked about", async () => {
    const target = await insertTrace(dbA, { agentId: "agent-target", createdAt: daysAgo(60) });
    const bystander = await insertTrace(dbA, { agentId: "agent-bystander", createdAt: daysAgo(60) });

    await pruneRetentionData(dbA, "agent-target", 30);

    const traces = await traceIds(dbA);
    expect(traces).not.toContain(target);
    expect(traces, "an unrelated agent's traces were deleted").toContain(bystander);
  });

  it("prunes unattributed rows only when asked about the null agent", async () => {
    const orphan = await insertTrace(dbA, { agentId: null, createdAt: daysAgo(60) });
    const attributed = await insertTrace(dbA, { agentId: "agent-attributed", createdAt: daysAgo(60) });

    // Pruning a named agent must not sweep up rows that belong to no agent...
    await pruneRetentionData(dbA, "agent-attributed", 30);
    expect(await traceIds(dbA)).toContain(orphan);
    expect(await traceIds(dbA)).not.toContain(attributed);

    // ...and asking about the null agent is what reaches them.
    await pruneRetentionData(dbA, null, 30);
    expect(await traceIds(dbA)).not.toContain(orphan);
  });

  it("leaves signals alone - they are curated triage records, not raw traffic", async () => {
    const agentId = "agent-with-signal";
    const signalId = nanoid();
    await insertRow(dbA, dbA.schema.monitorSignals, {
      id: signalId,
      projectId: projectA,
      patternKey: "agent-trace-error",
      type: "agent_trace_error",
      severity: "high",
      polarity: "failure",
      status: "open",
      summary: "old but curated",
      rootCause: null,
      agentId,
      evidence: null,
      occurrenceCount: 1,
      firstSeenAt: daysAgo(90),
      lastSeenAt: daysAgo(90),
      createdAt: daysAgo(90),
      updatedAt: daysAgo(90),
    });

    await pruneRetentionData(dbA, agentId, 30);

    const rows = (
      dbA.kind === "sqlite"
        ? dbA.db.select().from(dbA.schema.monitorSignals).where(and(eq(dbA.schema.monitorSignals.id, signalId))).all()
        : await dbA.db.select().from(dbA.schema.monitorSignals).where(and(eq(dbA.schema.monitorSignals.id, signalId)))
    ) as unknown[];
    expect(rows, "a curated signal was pruned along with the raw telemetry").toHaveLength(1);
  });

  it("is a no-op when there is nothing old enough to prune", async () => {
    const before = (await traceIds(dbA)).length;
    await pruneRetentionData(dbA, "agent-nothing-to-do", 30);
    expect((await traceIds(dbA)).length).toBe(before);
  });
});
