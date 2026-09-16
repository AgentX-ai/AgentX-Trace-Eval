import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import { getVersionComparison } from "../core/evaluate/runs.js";

// Version comparison buckets runs by their subject version. A single-trace evaluation
// (runSource "trace-eval") shares the dataset id but is one score, not a run: it must be
// excluded from the buckets entirely. Before this was pinned, the bucket loop walked the
// UNFILTERED run list, so a trace-eval run created a phantom bucket keyed `undefined` that could
// occupy one of the two headline comparison slots and blank the verdict.

let test: TestDb;
let db: Db;

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("version-comparison"));
});

afterAll(async () => {
  await test?.close();
});

async function insertRun(id: string, version: string | null, createdAt: Date, runSource: string | null) {
  const row = { id, datasetId: "ds-1", projectId: db.projectId, version, runSource, status: "completed", createdAt };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationRuns).values(row as never);
  } else {
    await db.db.insert(db.schema.evaluationRuns).values(row as never);
  }
}

async function insertResult(id: string, runId: string, rating: number) {
  const row = { id, runId, idempotencyKey: id, projectId: db.projectId, rating, status: "scored", createdAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationRunResults).values(row as never);
  } else {
    await db.db.insert(db.schema.evaluationRunResults).values(row as never);
  }
}

describe("getVersionComparison", () => {
  it("ignores trace-eval runs instead of bucketing them under an undefined version", async () => {
    const t0 = new Date("2026-09-01T00:00:00Z");
    await insertRun("run-v1", "v1", t0, "sdk");
    await insertResult("r1", "run-v1", 6);
    await insertResult("r2", "run-v1", 8);
    await insertRun("run-v2", "v2", new Date(t0.getTime() + 60_000), "sdk");
    await insertResult("r3", "run-v2", 9);
    // The newest row on the dataset is a single-trace evaluation with no version.
    await insertRun("run-trace", null, new Date(t0.getTime() + 120_000), "trace-eval");
    await insertResult("r4", "run-trace", 1);

    const result = await getVersionComparison(db, "ds-1");
    const versions = result.versions.map(v => v.version);
    expect(versions).not.toContain(undefined);
    expect(versions).not.toContain("(unversioned)");
    expect(versions.sort()).toEqual(["v1", "v2"]);
    const v1 = result.versions.find(v => v.version === "v1")!;
    expect(v1.ratedCount).toBe(2);
    expect(v1.averageRating).toBe(7);
    // The headline comparison is v2 (newest) against v1, not against the phantom.
    expect(result.comparison).not.toBeNull();
    expect([result.comparison!.candidateVersion, result.comparison!.baselineVersion].sort()).toEqual(["v1", "v2"]);
  });
});
