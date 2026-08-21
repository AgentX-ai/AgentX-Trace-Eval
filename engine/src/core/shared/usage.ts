import { and, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, type Db } from "../../storage/db.js";
import { currentTenancy } from "../../auth/requestContext.js";
import { isMultiTenant } from "../../auth/mode.js";

// Judge-spend metering + daily quotas - the operability layer a multi-tenant deployment needs
// before it can face strangers, and the ledger later billing reads. Two knobs, both unset (=
// unlimited) by default so the OSS single-tenant experience is untouched:
//   AGENTX_QUOTA_JUDGE_CALLS_PER_DAY - judge LLM calls, counted per organization in
//     multi-tenant mode (each tenant gets the allowance), per instance otherwise.
//   AGENTX_QUOTA_TRACES_PER_DAY - ingested root traces, counted per project (enforced in
//     routes/ingest.ts against the traces table itself - no ledger row per trace).

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function dayStart(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function judgeQuota(): number | null {
  const raw = Number(process.env.AGENTX_QUOTA_JUDGE_CALLS_PER_DAY || 0);
  return raw > 0 ? raw : null;
}

export function traceQuota(): number | null {
  const raw = Number(process.env.AGENTX_QUOTA_TRACES_PER_DAY || 0);
  return raw > 0 ? raw : null;
}

async function countJudgeCallsToday(db: Db, organizationId: string | null): Promise<number> {
  const conditions = [eq(db.schema.usageEvents.kind, "judge_call"), gte(db.schema.usageEvents.createdAt, dayStart())];
  if (organizationId) {
    conditions.push(eq(db.schema.usageEvents.organizationId, organizationId));
  }
  const cond = and(...conditions);
  const rows =
    db.kind === "sqlite"
      ? db.db.select({ n: sql<number>`count(*)` }).from(db.schema.usageEvents).where(cond).all()
      : await db.db.select({ n: sql<number>`count(*)` }).from(db.schema.usageEvents).where(cond);
  return Number(rows[0]?.n ?? 0);
}

// Called from the judge chokepoint (core/evaluate/judge.ts) before each LLM call. Throws
// QuotaExceededError when the day's allowance is spent - callers already treat judge failures
// as isolated per-item errors, so one tenant hitting its cap degrades exactly like a judge
// outage would: clear message, nothing else affected.
export async function checkAndRecordJudgeCall(model: string | null): Promise<void> {
  const db = getDb();
  const { organizationId = null, projectId = null } = currentTenancy();
  const quota = judgeQuota();
  if (quota !== null) {
    const scopeOrg = isMultiTenant() ? organizationId : null;
    const used = await countJudgeCallsToday(db, scopeOrg);
    if (used >= quota) {
      throw new QuotaExceededError(
        `Daily judge-call quota reached (${quota}/day${isMultiTenant() ? " for this organization" : ""}). ` +
          "Quota resets at midnight; raise AGENTX_QUOTA_JUDGE_CALLS_PER_DAY to change the ceiling."
      );
    }
  }
  const row = {
    id: nanoid(),
    kind: "judge_call",
    model,
    organizationId,
    projectId,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.usageEvents).values(row);
  } else {
    await db.db.insert(db.schema.usageEvents).values(row);
  }
}

// Admin overview helper: per-org judge calls in the trailing 24h.
export async function judgeCallsSince(db: Db, since: Date): Promise<Map<string | null, number>> {
  const cond = and(eq(db.schema.usageEvents.kind, "judge_call"), gte(db.schema.usageEvents.createdAt, since));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.usageEvents).where(cond).all()
      : await db.db.select().from(db.schema.usageEvents).where(cond)
  ) as { organizationId: string | null }[];
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    counts.set(row.organizationId, (counts.get(row.organizationId) ?? 0) + 1);
  }
  return counts;
}
