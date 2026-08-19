import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { acquireSweepLease } from "../core/shared/sweepLease.js";

// Stops N replicas each running the same sweep every tick and N-times-judging the same sessions,
// on the user's own API key. Testing it needs two holders: sweepLease.ts draws one HOLDER_ID per
// module instance, so a second instance from a reset module registry stands in for a replica.

let test: TestDb;

// A second "replica": same database, different HOLDER_ID.
async function otherReplica(): Promise<typeof acquireSweepLease> {
  vi.resetModules();
  const module = await import("../core/shared/sweepLease.js");
  return module.acquireSweepLease;
}

beforeAll(async () => {
  test = await openTestDb();
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("acquireSweepLease", () => {
  it("grants the lease to a first caller", async () => {
    expect(await acquireSweepLease(test.db, "first-sweep", 60_000)).toBe(true);
  });

  it("lets the same holder renew on its next tick without waiting out its own TTL", async () => {
    expect(await acquireSweepLease(test.db, "renewing-sweep", 60_000)).toBe(true);
    expect(await acquireSweepLease(test.db, "renewing-sweep", 60_000)).toBe(true);
  });

  it("refuses a second replica while the lease is live", async () => {
    expect(await acquireSweepLease(test.db, "contested-sweep", 60_000)).toBe(true);
    const otherAcquire = await otherReplica();
    expect(await otherAcquire(test.db, "contested-sweep", 60_000)).toBe(false);
  });

  it("hands the lease over once it has expired, so a crashed replica needs no cleanup", async () => {
    // Negative TTL: acquired already expired, which is what a dead holder's row looks like.
    expect(await acquireSweepLease(test.db, "expiring-sweep", -1)).toBe(true);
    const otherAcquire = await otherReplica();
    expect(await otherAcquire(test.db, "expiring-sweep", 60_000)).toBe(true);
  });

  it("keeps the lease with the new holder after a takeover", async () => {
    expect(await acquireSweepLease(test.db, "handover-sweep", -1)).toBe(true);
    const otherAcquire = await otherReplica();
    expect(await otherAcquire(test.db, "handover-sweep", 60_000)).toBe(true);
    // The original replica must not be able to take it straight back.
    expect(await acquireSweepLease(test.db, "handover-sweep", 60_000)).toBe(false);
  });

  it("gives the lease to exactly one of many replicas racing the same tick", async () => {
    // Loaded one at a time: vi.resetModules() mutates a shared registry, so building them
    // concurrently hands several "replicas" the same module instance - and therefore the same
    // HOLDER_ID, which legitimately renews rather than contending.
    const replicas: Array<typeof acquireSweepLease> = [];
    for (let i = 0; i < 6; i++) {
      replicas.push(await otherReplica());
    }
    const results = await Promise.all(replicas.map(acquire => acquire(test.db, "raced-sweep", 60_000)));
    expect(results.filter(Boolean), `winners: ${results.filter(Boolean).length}`).toHaveLength(1);
  });

  it("keeps separate sweeps independent of each other", async () => {
    expect(await acquireSweepLease(test.db, "sweep-a", 60_000)).toBe(true);
    const otherAcquire = await otherReplica();
    expect(await otherAcquire(test.db, "sweep-a", 60_000)).toBe(false);
    // A different sweep name is a different lease row entirely.
    expect(await otherAcquire(test.db, "sweep-b", 60_000)).toBe(true);
  });
});
