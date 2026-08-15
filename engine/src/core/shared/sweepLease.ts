import { nanoid } from "nanoid";
import { eq, lt, or } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Multi-replica guard for the background sweeps (session + improvement): several engine replicas
// sharing one Postgres would otherwise each run the same sweep every tick and double- or
// triple-judge the same sessions/targets. The lease is one row per sweep name; a replica may run
// the sweep only while it holds the row. Acquisition is a single atomic upsert (insert, or update
// when the current lease is expired or already ours), so two replicas racing the same tick can't
// both win. Expiry-based rather than release-based on purpose: a crashed replica's lease simply
// times out, no cleanup required. A sweep overrunning its TTL can in principle overlap the next
// holder - acceptable, since every sweep's own freshness checks make double work a no-op, the
// lease exists to stop the systematic N-replicas-every-tick multiplication, not to be a mutex.
//
// The manual /sweep/run routes deliberately DON'T take the lease: an explicit human trigger
// (demos, tests) should always run.

// One id per process lifetime - what marks a lease row as "ours" across ticks, letting the same
// replica renew without waiting out its own TTL.
const HOLDER_ID = nanoid();

export type LeaseRow = {
  name: string;
  holder: string;
  expiresAt: Date;
};

export async function acquireSweepLease(db: Db, name: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const row: LeaseRow = { name, holder: HOLDER_ID, expiresAt: new Date(now.getTime() + ttlMs) };
  const takeoverAllowed = or(lt(db.schema.sweepLeases.expiresAt, now), eq(db.schema.sweepLeases.holder, HOLDER_ID));
  if (db.kind === "sqlite") {
    const updated = db.db
      .insert(db.schema.sweepLeases)
      .values(row)
      .onConflictDoUpdate({
        target: db.schema.sweepLeases.name,
        set: { holder: row.holder, expiresAt: row.expiresAt },
        setWhere: takeoverAllowed,
      })
      .returning()
      .all();
    return updated.length > 0;
  }
  const updated = await db.db
    .insert(db.schema.sweepLeases)
    .values(row)
    .onConflictDoUpdate({
      target: db.schema.sweepLeases.name,
      set: { holder: row.holder, expiresAt: row.expiresAt },
      setWhere: takeoverAllowed,
    })
    .returning();
  return updated.length > 0;
}
