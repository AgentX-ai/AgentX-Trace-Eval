import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { getJudgeCalibration } from "../core/monitor/outcomeCalibration.js";
import type { Db } from "../storage/db.js";

// Regression: a trace labeled twice in the review queue (a re-review) used to contribute
// whichever row the database happened to return first - the agreement rate changed between
// identical requests. The contract now: the LATEST reviewedAt label per trace wins, matching
// judgeTuning's own latest-wins keying, regardless of row/insert order.

let test: TestDb;
let db: Db;

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

async function insertRow(scoped: Db, table: unknown, values: Record<string, unknown>): Promise<void> {
  if (scoped.kind === "sqlite") {
    await scoped.db.insert(table as Parameters<typeof scoped.db.insert>[0]).values(values as never);
  } else {
    await scoped.db.insert(table as Parameters<typeof scoped.db.insert>[0]).values(values as never);
  }
}

/** A failure-polarity monitor event with no evaluator ids: AgentX "flagged" this trace. */
async function insertFlagEvent(scoped: Db, traceId: string): Promise<void> {
  await insertRow(scoped, scoped.schema.monitorEvents, {
    id: nanoid(),
    projectId: scoped.projectId,
    signalId: null,
    patternKey: "trace-error",
    type: "trace_error",
    severity: "high",
    polarity: "failure",
    agentId: null,
    traceId,
    createdAt: hoursAgo(5),
    onlineEvaluatorId: null,
    rating: null,
    justification: null,
    customEvaluatorId: null,
    matched: null,
    score: null,
    sessionId: null,
  });
}

async function insertLabel(scoped: Db, traceId: string, label: "good" | "bad", reviewedAt: Date): Promise<void> {
  await insertRow(scoped, scoped.schema.reviewQueueItems, {
    id: nanoid(),
    projectId: scoped.projectId,
    traceId,
    sessionId: null,
    source: "manual",
    status: "labeled",
    label,
    correctedScore: null,
    judgeScoreAtQueue: null,
    note: null,
    reviewedBy: "tester",
    reviewedAt,
    createdAt: hoursAgo(6),
  });
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("Calibration latest-label project"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("review-label calibration keying", () => {
  it("tallies the LATEST label per trace, whatever order the rows were written in", async () => {
    // Trace A: the stale "good" row is inserted FIRST (the order a first-row-wins bug tallies),
    // then re-reviewed to "bad" later. AgentX flagged the trace, so the latest label agrees.
    const traceA = nanoid();
    await insertFlagEvent(db, traceA);
    await insertLabel(db, traceA, "good", hoursAgo(4));
    await insertLabel(db, traceA, "bad", hoursAgo(2));

    // Trace B: same history, opposite insertion order - the result must be identical.
    const traceB = nanoid();
    await insertFlagEvent(db, traceB);
    await insertLabel(db, traceB, "bad", hoursAgo(2));
    await insertLabel(db, traceB, "good", hoursAgo(4));

    const result = await getJudgeCalibration(db, "7d");
    expect(result.reviewLabelCount).toBe(2);
    expect(result.comparedCount).toBe(2);
    // Both traces: flagged + latest label "bad" = agreement (true positive), deterministically.
    expect(result.agreementRate).toBe(1);
    expect(result.falsePositiveRate).toBe(0);
  });
});
