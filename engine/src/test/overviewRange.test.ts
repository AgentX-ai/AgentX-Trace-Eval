import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { getJudgeCalibration } from "../core/monitor/outcomeCalibration.js";
import { getModelComparison } from "../core/monitor/modelComparison.js";
import type { Db } from "../storage/db.js";

// The dashboard sends every Overview range other than 24h/7d/30d (6h, 14d, 90d, a custom span) as
// explicit from/to bounds. Judge calibration and model comparison used to read only the window
// enum, so those two cards silently answered "7d" while the rest of the page showed the picked
// range. Pinned here: both honour explicit bounds on each side, and still answer the presets.

let test: TestDb;
let db: Db;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

async function insertRow(scoped: Db, table: unknown, values: Record<string, unknown>): Promise<void> {
  if (scoped.kind === "sqlite") {
    await scoped.db.insert(table as Parameters<typeof scoped.db.insert>[0]).values(values as never);
  } else {
    await scoped.db.insert(table as Parameters<typeof scoped.db.insert>[0]).values(values as never);
  }
}

async function insertTrace(model: string, createdAt: Date): Promise<string> {
  const id = nanoid();
  await insertRow(db, db.schema.traces, {
    id,
    name: "range-agent",
    input: "q",
    output: "a",
    error: null,
    latencyMs: 100,
    framework: null,
    model,
    toolCalls: null,
    metadata: null,
    sessionId: null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanKind: null,
    source: null,
    spanId: null,
    parentSpanId: null,
    startedAt: null,
    createdAt,
    agentId: null,
    projectId: db.projectId,
  });
  return id;
}

/** A failure-polarity monitor event with no evaluator ids: AgentX "flagged" this trace. */
async function insertFlagEvent(traceId: string, createdAt: Date): Promise<void> {
  await insertRow(db, db.schema.monitorEvents, {
    id: nanoid(),
    projectId: db.projectId,
    signalId: null,
    patternKey: "trace-error",
    type: "trace_error",
    severity: "high",
    polarity: "failure",
    agentId: null,
    traceId,
    createdAt,
    onlineEvaluatorId: null,
    rating: null,
    justification: null,
    customEvaluatorId: null,
    matched: null,
    score: null,
    sessionId: null,
  });
}

async function insertLabel(traceId: string, reviewedAt: Date): Promise<void> {
  await insertRow(db, db.schema.reviewQueueItems, {
    id: nanoid(),
    projectId: db.projectId,
    traceId,
    sessionId: null,
    source: "manual",
    status: "labeled",
    label: "bad",
    correctedScore: null,
    judgeScoreAtQueue: null,
    note: null,
    reviewedBy: "tester",
    reviewedAt,
    createdAt: reviewedAt,
  });
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("Overview range project"));
  // Five days old: inside 7d, outside 24h, and inside or outside an explicit span depending on
  // which side of it the bounds sit.
  const oldTrace = await insertTrace("gpt-4o-mini", ago(5 * DAY));
  await insertFlagEvent(oldTrace, ago(5 * DAY));
  await insertLabel(oldTrace, ago(5 * DAY));
  // One hour old: inside every preset.
  await insertTrace("claude-haiku", ago(HOUR));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("model comparison range", () => {
  it("counts only the traces inside explicit bounds", async () => {
    const now = Date.now();
    const result = await getModelComparison(db, { fromMs: now - 6 * DAY, toMs: now - 4 * DAY });
    expect(result.window).toBe("custom");
    expect(result.models.map(m => m.model)).toEqual(["gpt-4o-mini"]);
  });

  it("still answers the preset windows", async () => {
    expect((await getModelComparison(db, "24h")).models.map(m => m.model)).toEqual(["claude-haiku"]);
    expect((await getModelComparison(db, "7d")).models.map(m => m.model).sort()).toEqual(["claude-haiku", "gpt-4o-mini"]);
  });
});

describe("judge calibration range", () => {
  it("tallies a label inside explicit bounds and drops one outside them", async () => {
    const now = Date.now();
    const inside = await getJudgeCalibration(db, { fromMs: now - 6 * DAY, toMs: now - 4 * DAY });
    expect(inside.window).toBe("custom");
    expect(inside.reviewLabelCount).toBe(1);
    expect(inside.agreementRate).toBe(1);

    const after = await getJudgeCalibration(db, { fromMs: now - 3 * DAY, toMs: now });
    expect(after.reviewLabelCount).toBe(0);
  });

  it("still answers the preset windows", async () => {
    expect((await getJudgeCalibration(db, "24h")).reviewLabelCount).toBe(0);
    expect((await getJudgeCalibration(db, "7d")).reviewLabelCount).toBe(1);
  });
});
