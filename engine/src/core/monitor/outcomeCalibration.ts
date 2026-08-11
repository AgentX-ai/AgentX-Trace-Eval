import { eq, gte, and } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { MonitoringWindow } from "./events.js";
import { listEventsForTrace } from "./events.js";
import { listOutcomeReportRows, type OutcomeReportRow } from "../outcomes/outcomeReports.js";

// Turns "trust the LLM judge" into a measured, falsifiable number: for every reported real-world
// outcome (core/outcomes/outcomeReports.ts), compare it against whatever verdict AgentX had
// already recorded for the same trace/result at the time, and report the agreement rate - the
// answer to "how often does AgentX's detection actually match reality" instead of a qualitative
// "we use multiple judges so it's probably fine."
//
// A rating threshold below which an offline eval result counts as "AgentX flagged it" - matches
// monitor_online_evaluators.alertThreshold's own default (core/monitor/onlineEvaluators.ts), the
// only other place this codebase already draws a "below this rating is a failure" line, rather
// than inventing a second, different default.
const LOW_RATING_THRESHOLD = 5;

// null = AgentX has no verdict to compare against at all (no monitor_events row for that trace,
// or an unscored eval result) - excluded from agreement math entirely rather than silently
// counted as "not flagged", which would inflate agreement with a report that isn't actually
// falsifiable against anything AgentX did.
async function resolveAgentxVerdict(db: Db, report: OutcomeReportRow): Promise<boolean | null> {
  if (report.traceId) {
    const events = await listEventsForTrace(db, report.traceId);
    if (events.length === 0) {
      return null;
    }
    // Same "a raised Signal is the one thing pattern/online-evaluator/custom-evaluator detection
    // all funnel through" primitive core/monitor/events.ts's own getKpis-adjacent code relies on -
    // reusing signalId here instead of re-deriving polarity/threshold logic per evaluator type
    // keeps this in sync with however each evaluator kind decides to raise one. The one carve-out:
    // detect.ts's "healthy-response" tally *also* goes through upsertSignal (one aggregate signal
    // per agent, see its own comment), so signalId alone can't distinguish "flagged" from "counted
    // as healthy" - excluded the same way tallyEvent (events.ts) already excludes it.
    return events.some(e => e.signalId !== null && e.patternKey !== "healthy-response");
  }
  if (report.evaluationRunResultId) {
    const cond = and(
      eq(db.schema.evaluationRunResults.id, report.evaluationRunResultId),
      eq(db.schema.evaluationRunResults.projectId, db.projectId)
    );
    const row = (
      db.kind === "sqlite"
        ? db.db.select({ rating: db.schema.evaluationRunResults.rating }).from(db.schema.evaluationRunResults).where(cond).all()
        : await db.db.select({ rating: db.schema.evaluationRunResults.rating }).from(db.schema.evaluationRunResults).where(cond)
    )[0] as { rating: number | null } | undefined;
    if (!row || row.rating == null) {
      return null;
    }
    return row.rating < LOW_RATING_THRESHOLD;
  }
  return null;
}

export type CalibrationResult = {
  window: MonitoringWindow;
  reportedCount: number;
  // Reports whose traceId/evaluationRunResultId has no corresponding AgentX verdict yet - not an
  // error, just not (yet) usable for calibration math.
  noVerdictCount: number;
  comparedCount: number;
  agreementRate: number | null;
  // Of everything AgentX flagged as bad, the fraction later reported as actually fine.
  falsePositiveRate: number | null;
  // Of everything AgentX called healthy, the fraction later reported as actually bad - the
  // sharper number, since this is a real miss, not over-caution.
  falseNegativeRate: number | null;
};

function windowDays(window: MonitoringWindow): number {
  switch (window) {
    case "24h":
      return 1;
    case "30d":
      return 30;
    case "7d":
    default:
      return 7;
  }
}

// Windowed on reportedAt (when the ground truth arrived), not the original trace's own createdAt
// - calibration is about how recently-arrived outcomes are tracking, regardless of how old the
// underlying trace/run was when it happened.
export async function getJudgeCalibration(db: Db, window: MonitoringWindow): Promise<CalibrationResult> {
  const since = new Date(Date.now() - windowDays(window) * 24 * 60 * 60 * 1000);
  const cond = and(gte(db.schema.outcomeReports.reportedAt, since), eq(db.schema.outcomeReports.projectId, db.projectId));
  const reports = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.outcomeReports).where(cond).all()
      : await db.db.select().from(db.schema.outcomeReports).where(cond)
  ) as OutcomeReportRow[];

  let noVerdict = 0;
  // truePositive: AgentX flagged it, report confirms it really was bad.
  // trueNegative: AgentX called it healthy, report confirms it really was fine.
  // falsePositive: AgentX flagged it, but report says it was actually fine (over-caution).
  // falseNegative: AgentX called it healthy, but report says it was actually bad (a real miss).
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const report of reports) {
    const agentxFlagged = await resolveAgentxVerdict(db, report);
    if (agentxFlagged === null) {
      noVerdict++;
      continue;
    }
    if (agentxFlagged && report.isNegative) {
      truePositive++;
    } else if (!agentxFlagged && !report.isNegative) {
      trueNegative++;
    } else if (agentxFlagged && !report.isNegative) {
      falsePositive++;
    } else {
      falseNegative++;
    }
  }

  const comparedCount = truePositive + trueNegative + falsePositive + falseNegative;
  const flaggedCount = truePositive + falsePositive; // everything AgentX said was "bad"
  const healthyCount = trueNegative + falseNegative; // everything AgentX said was "healthy"

  return {
    window,
    reportedCount: reports.length,
    noVerdictCount: noVerdict,
    comparedCount,
    agreementRate: comparedCount > 0 ? (truePositive + trueNegative) / comparedCount : null,
    falsePositiveRate: flaggedCount > 0 ? falsePositive / flaggedCount : null,
    falseNegativeRate: healthyCount > 0 ? falseNegative / healthyCount : null,
  };
}
