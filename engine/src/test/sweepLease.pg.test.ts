import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { acquireSweepLease as AcquireFn } from "../core/shared/sweepLease.js";

// The lease exists for the multi-replica deployment, which means Postgres. On SQLite every
// acquire serialises inside better-sqlite3 whether the lease works or not, so "exactly one winner"
// there proves very little - here the statements genuinely interleave, which is the case the
// atomic upsert is written for.

const postgresAvailable = Boolean(process.env.AGENTX_TEST_DB_URL);

let test: TestDb;

async function replica(): Promise<typeof AcquireFn> {
  vi.resetModules();
  const module = await import("../core/shared/sweepLease.js");
  return module.acquireSweepLease;
}

describe.skipIf(!postgresAvailable)("acquireSweepLease on Postgres", () => {
  beforeAll(async () => {
    test = await openTestDb({ postgres: true });
  }, 90_000);

  afterAll(async () => {
    await test?.close();
  });

  it("gives the lease to exactly one of many replicas racing the same tick", async () => {
    const replicas: Array<typeof AcquireFn> = [];
    for (let i = 0; i < 8; i++) {
      replicas.push(await replica());
    }
    const results = await Promise.all(replicas.map(acquire => acquire(test.db, "pg-raced-sweep", 60_000)));
    const winners = results.filter(Boolean).length;
    expect(winners, `${winners} replicas all believed they held the lease`).toBe(1);
  }, 60_000);

  it("still admits exactly one replica when they race a takeover of an expired lease", async () => {
    const first = await replica();
    expect(await first(test.db, "pg-expired-sweep", -1)).toBe(true);

    const contenders: Array<typeof AcquireFn> = [];
    for (let i = 0; i < 6; i++) {
      contenders.push(await replica());
    }
    const results = await Promise.all(contenders.map(acquire => acquire(test.db, "pg-expired-sweep", 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  }, 60_000);

  it("keeps refusing the losers for as long as the winner holds it", async () => {
    const holder = await replica();
    expect(await holder(test.db, "pg-held-sweep", 60_000)).toBe(true);
    const loser = await replica();
    for (let i = 0; i < 3; i++) {
      expect(await loser(test.db, "pg-held-sweep", 60_000)).toBe(false);
    }
    // ...while the holder renews freely.
    expect(await holder(test.db, "pg-held-sweep", 60_000)).toBe(true);
  }, 60_000);
});
