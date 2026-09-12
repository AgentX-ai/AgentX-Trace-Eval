import { desc, eq, gte, and, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { MonitoringWindow } from "./events.js";
import type { OutcomeReportRow } from "../outcomes/outcomeReports.js";
import { krippendorffAlpha, alphaBand, MIN_ALPHA_ITEMS } from "./agreement.js";

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

type VerdictEventRow = {
  traceId: string | null;
  signalId: string | null;
  patternKey: string;
  polarity: string;
  onlineEvaluatorId: string | null;
  customEvaluatorId: string | null;
};

// The same join surface as listEventsForTrace (events.ts), generalized to a batch: ONE inArray
// query for every trace the calibration pass compares, grouped in JS, instead of a sequential
// round trip per report.
async function listEventsByTrace(db: Db, traceIds: string[]): Promise<Map<string, VerdictEventRow[]>> {
  const byTrace = new Map<string, VerdictEventRow[]>();
  if (traceIds.length === 0) {
    return byTrace;
  }
  const cond = and(inArray(db.schema.monitorEvents.traceId, traceIds), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond)
  ) as VerdictEventRow[];
  for (const row of rows) {
    if (!row.traceId) continue;
    const list = byTrace.get(row.traceId) ?? [];
    list.push(row);
    byTrace.set(row.traceId, list);
  }
  return byTrace;
}

// null = AgentX has no verdict to compare against at all (no monitor_events row for that trace,
// or an unscored eval result) - excluded from agreement math entirely rather than silently
// counted as "not flagged", which would inflate agreement with a report that isn't actually
// falsifiable against anything AgentX did.
async function resolveAgentxVerdict(
  db: Db,
  report: OutcomeReportRow,
  eventsByTrace: Map<string, VerdictEventRow[]>
): Promise<boolean | null> {
  if (report.traceId) {
    const events = eventsByTrace.get(report.traceId) ?? [];
    if (events.length === 0) {
      return null;
    }
    // Two ways AgentX can have "flagged" a trace: (a) a raised Signal - the funnel every scorer
    // kind (pattern/online-evaluator/custom-evaluator) goes through, so signalId stays in sync
    // with however each kind decides to raise one; (b) an operational failure classification
    // (trace error / failed tool call / empty response, detect.ts's classifyOperational) - a
    // failure-polarity event with NO signal, since operational outcomes live outside the scorer
    // system. Evaluator rows are excluded from (b): their events carry failure-agnostic ratings/
    // verdicts and only count via their signalId. "healthy-response" is excluded the same way
    // tallyEvent (events.ts) already excludes it - its aggregate signal isn't a flag.
    return events.some(
      e =>
        e.patternKey !== "healthy-response" &&
        (e.signalId !== null || (!e.onlineEvaluatorId && !e.customEvaluatorId && e.polarity === "failure"))
    );
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
  // Labeled review-queue items (core/monitor/reviewQueue.ts) actually tallied in the window -
  // good/bad labels on traces no outcome report already covered. Structurally the same evidence
  // as an outcome report - a human calling one trace good or bad - so they feed the same
  // confusion matrix. Reported separately so the UI can say how much of the agreement number
  // came from sampled human labels rather than production outcomes.
  reviewLabelCount: number;
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
  // Chance-corrected agreement (Krippendorff's alpha, agreement.ts) - agreementRate corrected
  // for what a weighted coin would score on this label mix. Null below the sample floor.
  alpha: number | null;
  alphaBand: string | null;
  alphaMinItems: number;
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
      ? db.db.select().from(db.schema.outcomeReports).where(cond).orderBy(desc(db.schema.outcomeReports.reportedAt)).limit(50_000).all()
      : await db.db.select().from(db.schema.outcomeReports).where(cond).orderBy(desc(db.schema.outcomeReports.reportedAt)).limit(50_000)
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

  const tally = (agentxFlagged: boolean | null, isNegative: boolean) => {
    if (agentxFlagged === null) {
      noVerdict++;
      return;
    }
    if (agentxFlagged && isNegative) {
      truePositive++;
    } else if (!agentxFlagged && !isNegative) {
      trueNegative++;
    } else if (agentxFlagged && !isNegative) {
      falsePositive++;
    } else {
      falseNegative++;
    }
  };

  // Sampled human labels: the same math, windowed on when the verdict was given. This is what
  // makes a review queue over ordinary traffic worth staffing - a judge quietly scoring bad
  // answers as good never produces an outcome report, but a sampled label catches it.
  const reviewCond = and(
    gte(db.schema.reviewQueueItems.reviewedAt, since),
    eq(db.schema.reviewQueueItems.projectId, db.projectId),
    eq(db.schema.reviewQueueItems.status, "labeled")
  );
  const reviewLabels = (
    db.kind === "sqlite"
      // Newest first, THEN capped: an unordered LIMIT keeps arbitrary rows, so the newest
      // re-review could fall outside the fetched set and a superseded label would win.
      ? db.db.select().from(db.schema.reviewQueueItems).where(reviewCond).orderBy(desc(db.schema.reviewQueueItems.reviewedAt)).limit(50_000).all()
      : await db.db.select().from(db.schema.reviewQueueItems).where(reviewCond).orderBy(desc(db.schema.reviewQueueItems.reviewedAt)).limit(50_000)
  ) as { traceId: string; label: string | null; reviewedAt: Date | null }[];
  // Deterministic order: a bare SELECT's row order is unspecified, and "whichever row happened
  // to come back first" used to decide which of two labels on the same trace was tallied.
  // Sorted ascending so the per-trace loop below lands on the LATEST label - the same
  // latest-reviewedAt-wins keying judgeTuning's calibration evidence uses.
  reviewLabels.sort((a, b) => (a.reviewedAt?.getTime() ?? 0) - (b.reviewedAt?.getTime() ?? 0));

  const eventsByTrace = await listEventsByTrace(db, [
    ...new Set([
      ...reports.map(r => r.traceId).filter((id): id is string => id !== null),
      ...reviewLabels.map(r => r.traceId),
    ]),
  ]);

  // One ground truth per trace: a trace with several outcome reports (or a report AND a review
  // label) used to contribute multiple rows to the same confusion matrix - inflating agreement
  // on exactly the traces that got the most attention. First report per trace wins, and outcome
  // reports outrank sampled labels (the ordering judgeTuning's evidence chain already uses).
  // Deterministic: a bare SELECT's row order is unspecified (Postgres after vacuum
  // especially) - sort by reportedAt so "first" means first in time, every request.
  reports.sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime());
  const talliedTraces = new Set<string>();
  for (const report of reports) {
    // Run-result-keyed reports dedupe too: 5 retries of one ServiceNow POST against one eval
    // result must contribute one matrix row, exactly like trace-keyed ground truth.
    const dedupeKey = report.traceId ?? (report.evaluationRunResultId ? `rr:${report.evaluationRunResultId}` : null);
    if (dedupeKey) {
      if (talliedTraces.has(dedupeKey)) continue;
      talliedTraces.add(dedupeKey);
    }
    tally(await resolveAgentxVerdict(db, report, eventsByTrace), report.isNegative);
  }

  // One label per trace, LATEST reviewedAt wins (the ascending sort above makes the last write
  // the newest) - a re-review supersedes the earlier verdict, matching judgeTuning.ts's
  // latest-wins keying. Outcome reports still outrank sampled labels: talliedTraces already
  // holds every report-covered trace by the time this runs.
  const latestLabelByTrace = new Map<string, "good" | "bad">();
  for (const item of reviewLabels) {
    if (item.label !== "good" && item.label !== "bad") continue;
    latestLabelByTrace.set(item.traceId, item.label);
  }
  let reviewLabelCount = 0;
  for (const [traceId, label] of latestLabelByTrace) {
    if (talliedTraces.has(traceId)) continue;
    talliedTraces.add(traceId);
    reviewLabelCount++;
    tally(await resolveAgentxVerdict(db, { traceId } as OutcomeReportRow, eventsByTrace), label === "bad");
  }

  const comparedCount = truePositive + trueNegative + falsePositive + falseNegative;
  const alpha = krippendorffAlpha({
    bothBad: truePositive,
    bothFine: trueNegative,
    judgeOnlyBad: falsePositive,
    humanOnlyBad: falseNegative,
  });
  const flaggedCount = truePositive + falsePositive; // everything AgentX said was "bad"
  const healthyCount = trueNegative + falseNegative; // everything AgentX said was "healthy"

  return {
    window,
    reportedCount: reports.length,
    reviewLabelCount,
    noVerdictCount: noVerdict,
    comparedCount,
    agreementRate: comparedCount > 0 ? (truePositive + trueNegative) / comparedCount : null,
    falsePositiveRate: flaggedCount > 0 ? falsePositive / flaggedCount : null,
    falseNegativeRate: healthyCount > 0 ? falseNegative / healthyCount : null,
    alpha,
    alphaBand: alpha === null ? null : alphaBand(alpha),
    alphaMinItems: MIN_ALPHA_ITEMS,
  };
}
