import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "../trace/store/index.js";

// Serialized daily root-trace reservation, the trace-side sibling of
// onlineEvaluators.ts's reserveOnlineJudgeCall. A bare check-then-act against the store let N
// concurrent exporters all read 9,900/10,000 and land 5,000 roots past the cap - the exact
// burst a per-day quota exists for. The counter is in-process per project, seeded once per
// UTC day from the store's own root count (same UTC boundary as the judge budget, so the two
// caps release together instead of hours apart across timezones).
//
// Deliberate slack, documented rather than hidden: a reservation is spent even if the insert
// later dedupes or fails, and multiple replicas each hold their own counter seeded from the
// shared store - so the cap is enforced per replica between seeds. Both err toward admitting
// slightly FEWER traces than the cap, never more per process.
const rootSpend = new Map<string, { day: string; count: number }>();
let reservationChain: Promise<void> = Promise.resolve();

export async function reserveTraceRoots(db: Db, roots: number, quota: number): Promise<boolean> {
  if (roots <= 0) return true;
  let granted = false;
  const reserve = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const key = db.projectId ?? "";
    let entry = rootSpend.get(key);
    if (!entry || entry.day !== day) {
      const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const used = await traceStoreFor(db).countRoots(utcMidnight);
      entry = { day, count: used };
      rootSpend.set(key, entry);
    }
    if (entry.count + roots > quota) return;
    entry.count += roots;
    granted = true;
  };
  reservationChain = reservationChain.then(reserve, reserve);
  await reservationChain;
  return granted;
}
