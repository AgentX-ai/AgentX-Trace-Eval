import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Ground truth reported back after the fact from a system AgentX doesn't own (e.g. a ServiceNow
// incident an agent "resolved" gets reopened three days later). Closes the "who evaluates the
// judge" gap a pure LLM-as-judge verdict can't answer on its own - see
// core/monitor/outcomeCalibration.ts, which joins these back to whatever verdict AgentX already
// recorded at the time and measures agreement. A plain create+list module, not a full CRUD
// resource: an outcome report is an append-only fact someone observed, not something the
// reporting system is expected to come back and edit or delete later (unlike, say, a Custom
// Evaluator config).
export type CreateOutcomeReportInput = {
  traceId?: string | null;
  evaluationRunResultId?: string | null;
  // Free string ("reopened", "confirmed_bad", "confirmed_good", ...), not a rigid enum - every
  // customer's real-world outcome taxonomy differs, same "typed but extensible string" posture as
  // monitor_profiles.channels. Purely a human-readable label - see isNegative for the actual
  // calibration signal.
  outcome: string;
  // The reporter states polarity explicitly rather than AgentX guessing it from the `outcome`
  // string (string-matching "reopened" as bad is guessable but wrong for plenty of real
  // taxonomies) - this is the field outcomeCalibration.ts actually compares against AgentX's own
  // verdict.
  isNegative: boolean;
  reason?: string | null;
  reportedBy?: string | null;
};

export type OutcomeReportRow = {
  id: string;
  projectId: string | null;
  traceId: string | null;
  evaluationRunResultId: string | null;
  outcome: string;
  isNegative: boolean;
  reason: string | null;
  reportedBy: string | null;
  reportedAt: Date;
};

function toWire(row: OutcomeReportRow) {
  return {
    _id: row.id,
    traceId: row.traceId,
    evaluationRunResultId: row.evaluationRunResultId,
    outcome: row.outcome,
    isNegative: row.isNegative,
    reason: row.reason,
    reportedBy: row.reportedBy,
    reportedAt: row.reportedAt.toISOString(),
  };
}

export async function createOutcomeReport(db: Db, input: CreateOutcomeReportInput) {
  const row: OutcomeReportRow = {
    id: nanoid(),
    projectId: db.projectId,
    traceId: input.traceId ?? null,
    evaluationRunResultId: input.evaluationRunResultId ?? null,
    // Capped like the sibling feedback path's comment cap: a misconfigured integration
    // pasting a whole incident body as `reason` must not write megabytes per report into a
    // table with no retention and full export exposure.
    outcome: input.outcome.slice(0, 200),
    isNegative: input.isNegative,
    reason: input.reason ? input.reason.slice(0, 4000) : null,
    reportedBy: input.reportedBy ? input.reportedBy.slice(0, 200) : null,
    reportedAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.outcomeReports).values(row);
  } else {
    await db.db.insert(db.schema.outcomeReports).values(row);
  }
  return toWire(row);
}

export async function listOutcomeReportsForTrace(db: Db, traceId: string): Promise<OutcomeReportRow[]> {
  const cond = and(eq(db.schema.outcomeReports.projectId, db.projectId), eq(db.schema.outcomeReports.traceId, traceId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.outcomeReports).where(cond).all()
      : await db.db.select().from(db.schema.outcomeReports).where(cond);
  return rows as OutcomeReportRow[];
}
