import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { traceStoreFor } from "../trace/store/index.js";
import { countJudgeSpendSince } from "../monitor/events.js";
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
  // UTC, matching the online-judge budget's boundary (onlineEvaluators.ts) - two daily caps
  // releasing hours apart on non-UTC hosts read as one being stuck.
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function judgeQuota(): number | null {
  const raw = Number(process.env.AGENTX_QUOTA_JUDGE_CALLS_PER_DAY || 0);
  return raw > 0 ? raw : null;
}

function onlineJudgeQuota(): number | null {
  const raw = Number(process.env.AGENTX_QUOTA_ONLINE_JUDGE_CALLS_PER_DAY || 0);
  return raw > 0 ? raw : null;
}

export function traceQuota(): number | null {
  const raw = Number(process.env.AGENTX_QUOTA_TRACES_PER_DAY || 0);
  return raw > 0 ? raw : null;
}

// `scope` null = whole instance (single-tenant); otherwise the count is confined to that
// organization's rows - and an orgless multi-tenant request (a bare project key with no
// organization) counts only the other orgless rows via IS NULL, rather than omitting the
// predicate and metering one project's traffic against every tenant's combined spend.
async function countJudgeCallsToday(db: Db, scope: { organizationId: string | null } | null): Promise<number> {
  const conditions = [eq(db.schema.usageEvents.kind, "judge_call"), gte(db.schema.usageEvents.createdAt, dayStart())];
  if (scope) {
    conditions.push(
      scope.organizationId
        ? eq(db.schema.usageEvents.organizationId, scope.organizationId)
        : isNull(db.schema.usageEvents.organizationId)
    );
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
// Record-only twin of checkAndRecordJudgeCall - for accounting a call that ALREADY happened
// (judge-core's internal retry is a second real provider call). The quota gate must not run
// here: throwing after a successful, billed result would discard it, which is worse than
// letting the day's count land one over the ceiling.
export async function recordJudgeCall(model: string | null): Promise<void> {
  const db = getDb();
  const { organizationId = null, projectId = null } = currentTenancy();
  const row = { id: nanoid(), kind: "judge_call", model, organizationId, projectId, createdAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.usageEvents).values(row);
  } else {
    await db.db.insert(db.schema.usageEvents).values(row);
  }
}

export async function checkAndRecordJudgeCall(model: string | null): Promise<void> {
  const db = getDb();
  const { organizationId = null, projectId = null } = currentTenancy();
  const quota = judgeQuota();
  if (quota !== null) {
    const multiTenant = isMultiTenant();
    const used = await countJudgeCallsToday(db, multiTenant ? { organizationId } : null);
    if (used >= quota) {
      // Orgless multi-tenant requests are counted against the orgless bucket, not the whole
      // instance - so the message says "project", not "organization".
      const scopeNote = multiTenant ? (organizationId ? " for this organization" : " for this project") : "";
      throw new QuotaExceededError(
        `Daily judge-call quota reached (${quota}/day${scopeNote}). ` +
          "Quota resets at midnight UTC; raise AGENTX_QUOTA_JUDGE_CALLS_PER_DAY to change the ceiling."
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
// The read-only "Usage & limits" wire (Platform Settings card + GET /agent-monitoring/usage):
// today's spend against each daily cap, computed by the SAME counters the enforcement paths
// seed from - the card can never disagree with the thing that actually says no. Limits are
// env-configured (unset = unlimited = null); editing them stays a deployment decision on
// purpose - these are cost-control levers, not per-user settings.
export type UsageAndLimits = {
  day: string;
  resetsAt: string;
  traces: { used: number; limit: number | null };
  onlineJudgeCalls: { used: number; limit: number | null };
  judgeCalls: { used: number; limit: number | null };
};

export async function getUsageAndLimits(db: Db): Promise<UsageAndLimits> {
  const start = dayStart();
  const resetsAt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const multiTenant = isMultiTenant();
  const { organizationId = null } = currentTenancy();
  const [tracesUsed, onlineUsed, judgeUsed] = await Promise.all([
    traceStoreFor(db).countRoots(start),
    countJudgeSpendSince(db, start),
    countJudgeCallsToday(db, multiTenant ? { organizationId } : null),
  ]);
  return {
    day: start.toISOString().slice(0, 10),
    resetsAt: resetsAt.toISOString(),
    traces: { used: tracesUsed, limit: traceQuota() },
    onlineJudgeCalls: { used: onlineUsed, limit: onlineJudgeQuota() },
    judgeCalls: { used: judgeUsed, limit: judgeQuota() },
  };
}

export async function judgeCallsSince(db: Db, since: Date): Promise<Map<string | null, number>> {
  const cond = and(eq(db.schema.usageEvents.kind, "judge_call"), gte(db.schema.usageEvents.createdAt, since));
  // Grouped count in SQL: an instance doing millions of judge calls a day must not ship every
  // usage row to the admin overview just to count them.
  const grouped =
    db.kind === "sqlite"
      ? db.db
          .select({ organizationId: db.schema.usageEvents.organizationId, n: sql<number>`count(*)` })
          .from(db.schema.usageEvents)
          .where(cond)
          .groupBy(db.schema.usageEvents.organizationId)
          .all()
      : await db.db
          .select({ organizationId: db.schema.usageEvents.organizationId, n: sql<number>`count(*)` })
          .from(db.schema.usageEvents)
          .where(cond)
          .groupBy(db.schema.usageEvents.organizationId);
  const rows = grouped.map(g => ({ organizationId: g.organizationId, n: Number(g.n) })) as {
    organizationId: string | null;
    n: number;
  }[];
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    counts.set(row.organizationId, row.n);
  }
  return counts;
}
