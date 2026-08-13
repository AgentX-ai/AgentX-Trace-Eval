import { and, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listEventsSince, windowConfig, type MonitoringWindow, type EventRow } from "./events.js";
import { getOnlineEvaluatorRow } from "./onlineEvaluators.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";
import { getTraceRow } from "../trace/ingest.js";
import { extractText } from "./events.js";
import { scoreAgainstCriteria, callJudgeJson, DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_PROMPT } from "../evaluate/judge.js";

// Judge tuning: measure one online evaluator's verdicts against recorded reality, then improve
// the JUDGE'S OWN CRITERIA from the disagreements - the same evidence -> propose -> validate ->
// human-approved publish loop prompts and tool schemas already have, pointed at the evaluator.
//
// Ground truth comes from two streams, in priority order:
//   1. Signal-triage corrections (monitor_signal_feedback.correctedScore + rationale, attributed
//      to this evaluator via the event the human was correcting) - a human explicitly re-scoring
//      this judge's verdict, with reasoning. The richest label there is, previously write-only.
//   2. Outcome reports by trace (isNegative), which already include end-user feedback votes via
//      the feedback API's dual-write.
//
// What makes THIS loop stronger than the prompt/tool ones: judging is exactly reproducible
// offline, so validation isn't an approximation - candidate criteria re-judge the very cases the
// current criteria got wrong (plus a control set of cases they got right, the anti-overfit
// guard) and agreement with recorded reality is measured directly.

const MAX_CASES_PER_BUCKET = 20;
const VALIDATE_DISAGREEMENT_CAP = 8;
const VALIDATE_CONTROL_CAP = 6;
const DEFAULT_BAD_THRESHOLD = 5;

export type GroundTruth = {
  source: "correction" | "outcome" | "feedback";
  isBad: boolean;
  // The human's own words: a correction's rationale, or an outcome/feedback reason.
  detail: string | null;
  correctedScore: number | null;
  reportedBy: string | null;
};

export type CalibrationCase = {
  eventId: string;
  traceId: string;
  input: string;
  output: string;
  rating: number;
  justification: string | null;
  judgedBad: boolean;
  groundTruth: GroundTruth;
  createdAt: string;
};

export type EvaluatorCalibration = {
  evaluatorId: string;
  evaluatorName: string;
  threshold: number;
  scoredEvents: number;
  withGroundTruth: number;
  agreements: number;
  overFlagged: number; // judge said bad, reality said fine - criteria too strict
  missed: number; // judge said fine, reality said bad - criteria too generous
  agreementRate: number | null;
  disagreementCases: CalibrationCase[];
  agreementCases: CalibrationCase[];
};

type FeedbackCorrectionRow = {
  eventId: string | null;
  correctedScore: number | null;
  rationale: string;
  createdAt: Date;
};

type OutcomeRow = { traceId: string | null; isNegative: boolean; reason: string | null; reportedBy: string | null; reportedAt: Date };

export async function getEvaluatorCalibration(
  db: Db,
  evaluatorId: string,
  window: MonitoringWindow = "7d"
): Promise<EvaluatorCalibration | null> {
  const evaluator = await getOnlineEvaluatorRow(db, evaluatorId);
  if (!evaluator) return null;
  const threshold = evaluator.alertThreshold ?? DEFAULT_BAD_THRESHOLD;

  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const events = (await listEventsSince(db, since)).filter(
    (e): e is EventRow & { rating: number; traceId: string } =>
      e.onlineEvaluatorId === evaluatorId && e.rating !== null && e.traceId !== null
  );

  // Corrections keyed by the event the human was re-scoring; outcomes keyed by trace.
  const feedbackCond = and(
    eq(db.schema.monitorSignalFeedback.projectId, db.projectId),
    isNotNull(db.schema.monitorSignalFeedback.correctedScore)
  );
  const corrections = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorSignalFeedback).where(feedbackCond).all()
      : await db.db.select().from(db.schema.monitorSignalFeedback).where(feedbackCond)
  ) as FeedbackCorrectionRow[];
  const correctionByEvent = new Map<string, FeedbackCorrectionRow>();
  for (const c of corrections) {
    if (c.eventId) correctionByEvent.set(c.eventId, c); // later rows overwrite: latest correction wins
  }

  const outcomesCond = and(eq(db.schema.outcomeReports.projectId, db.projectId), gte(db.schema.outcomeReports.reportedAt, since));
  const outcomes = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.outcomeReports).where(outcomesCond).all()
      : await db.db.select().from(db.schema.outcomeReports).where(outcomesCond)
  ) as OutcomeRow[];
  const outcomeByTrace = new Map<string, OutcomeRow>();
  for (const o of outcomes) {
    if (!o.traceId) continue;
    const existing = outcomeByTrace.get(o.traceId);
    if (!existing || o.reportedAt.getTime() > existing.reportedAt.getTime()) outcomeByTrace.set(o.traceId, o);
  }

  const disagreementCases: CalibrationCase[] = [];
  const agreementCases: CalibrationCase[] = [];
  let agreements = 0;
  let overFlagged = 0;
  let missed = 0;
  let withGroundTruth = 0;

  for (const event of events) {
    const correction = correctionByEvent.get(event.id);
    const outcome = outcomeByTrace.get(event.traceId);
    let groundTruth: GroundTruth | null = null;
    if (correction && correction.correctedScore !== null) {
      groundTruth = {
        source: "correction",
        isBad: correction.correctedScore < threshold,
        detail: correction.rationale,
        correctedScore: correction.correctedScore,
        reportedBy: null,
      };
    } else if (outcome) {
      groundTruth = {
        source: outcome.reportedBy?.startsWith("end-user") ? "feedback" : "outcome",
        isBad: outcome.isNegative,
        detail: outcome.reason,
        correctedScore: null,
        reportedBy: outcome.reportedBy,
      };
    }
    if (!groundTruth) continue;
    withGroundTruth++;

    const judgedBad = event.rating < threshold;
    const agree = judgedBad === groundTruth.isBad;
    if (agree) agreements++;
    else if (judgedBad) overFlagged++;
    else missed++;

    const bucket = agree ? agreementCases : disagreementCases;
    if (bucket.length < MAX_CASES_PER_BUCKET) {
      const trace = await getTraceRow(db, event.traceId);
      bucket.push({
        eventId: event.id,
        traceId: event.traceId,
        input: extractText(trace?.input).slice(0, 1500),
        output: extractText(trace?.output).slice(0, 1500),
        rating: event.rating,
        justification: event.justification,
        judgedBad,
        groundTruth,
        createdAt: event.createdAt.toISOString(),
      });
    }
  }

  return {
    evaluatorId,
    evaluatorName: evaluator.name,
    threshold,
    scoredEvents: events.length,
    withGroundTruth,
    agreements,
    overFlagged,
    missed,
    agreementRate: withGroundTruth > 0 ? Math.round((agreements / withGroundTruth) * 1000) / 1000 : null,
    disagreementCases,
    agreementCases,
  };
}

// ---------------------------------------------------------------------------
// Propose: rewrite the evaluator config's criteria from the disagreement cases.
// ---------------------------------------------------------------------------

const TUNING_SCHEMA = {
  type: "object",
  properties: {
    acceptanceCriteria: { type: "string" },
    rejectionCriteria: { type: "string" },
    evaluationCriteria: { type: "string" },
    reasoning: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: { tag: { type: "string", enum: ["added", "tightened", "removed"] }, text: { type: "string" } },
        required: ["tag", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["acceptanceCriteria", "rejectionCriteria", "evaluationCriteria", "reasoning", "changes"],
  additionalProperties: false,
} as const;

export type JudgeTuningProposal = {
  acceptanceCriteria: string;
  rejectionCriteria: string;
  evaluationCriteria: string;
  reasoning: string;
  changes: { tag: string; text: string }[];
  judgeModel: string;
  evidenceCount: number;
  evaluationSettingsId: string;
  current: { acceptanceCriteria: string; rejectionCriteria: string; evaluationCriteria: string };
};

function describeCase(c: CalibrationCase, i: number): string {
  const truth = c.groundTruth;
  const truthLabel =
    truth.source === "correction"
      ? `a human re-scored it to ${truth.correctedScore}/10 with rationale: "${truth.detail ?? ""}"`
      : `${truth.source === "feedback" ? "the end user" : "a real-world outcome"} said it was ${truth.isBad ? "BAD" : "FINE"}${truth.detail ? ` ("${truth.detail}")` : ""}`;
  return `Case ${i + 1}: the judge rated ${c.rating}/10 (${c.judgedBad ? "flagged as bad" : "passed as fine"}) saying "${(c.justification ?? "").slice(0, 300)}", but ${truthLabel}.
  User input: ${c.input.slice(0, 600)}
  Agent output: ${c.output.slice(0, 600)}`;
}

export async function proposeJudgeTuning(
  db: Db,
  evaluatorId: string,
  opts: { window?: MonitoringWindow; caseEventIds?: string[]; judgeModel?: string } = {}
): Promise<JudgeTuningProposal | { error: string } | null> {
  const evaluator = await getOnlineEvaluatorRow(db, evaluatorId);
  if (!evaluator?.evaluationSettingsId) return null;
  const settings = await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId);
  if (!settings) return null;

  const calibration = await getEvaluatorCalibration(db, evaluatorId, opts.window ?? "7d");
  if (!calibration) return null;
  let cases = calibration.disagreementCases;
  if (opts.caseEventIds?.length) {
    const wanted = new Set(opts.caseEventIds);
    cases = cases.filter(c => wanted.has(c.eventId));
  }
  cases = cases.slice(0, 10);
  if (cases.length === 0) {
    return { error: "No disagreement cases to tune from - the judge currently agrees with all recorded ground truth" };
  }

  const current = {
    acceptanceCriteria: settings.acceptanceCriteria ?? "",
    rejectionCriteria: settings.rejectionCriteria ?? "",
    evaluationCriteria: settings.evaluationCriteria ?? "",
  };
  const userMessage = `You are tuning the grading criteria of an LLM-as-judge that continuously scores an AI agent's production responses 0-10 (below ${calibration.threshold} counts as "bad" and raises an alert). Its verdicts have been compared against recorded reality (human re-scores with rationales, real-world outcomes, end-user votes) and the cases below are where the judge got it WRONG.

Current criteria:
- Acceptance criteria (what makes a response good): ${current.acceptanceCriteria || "(empty)"}
- Rejection criteria (what makes a response bad): ${current.rejectionCriteria || "(empty)"}
- Evaluation criteria (what to weigh): ${current.evaluationCriteria || "(empty)"}

Disagreement cases:

${cases.map(describeCase).join("\n\n")}

Rewrite all three criteria so the judge would agree with the recorded ground truth on these cases. Human rationales are the strongest signal - encode the PRINCIPLE behind them, not the individual case. Do not overfit: no references to specific case content, and keep everything that was already working. Return the complete revised text for all three criteria (return the current text unchanged for any criterion that needs no change), a short reasoning, and an itemized change list tagged "added"/"tightened"/"removed".`;

  const judgeModel = opts.judgeModel || settings.judgeModel || DEFAULT_JUDGE_MODEL;
  const result = await callJudgeJson({ userMessage, model: judgeModel, jsonSchema: TUNING_SCHEMA, maxTokens: 3000 });
  const payload = result.payload as {
    acceptanceCriteria?: unknown;
    rejectionCriteria?: unknown;
    evaluationCriteria?: unknown;
    reasoning?: unknown;
    changes?: unknown;
  } | null;
  if (!payload || typeof payload.acceptanceCriteria !== "string") {
    throw new Error("The judge did not return a usable tuning proposal");
  }
  return {
    acceptanceCriteria: payload.acceptanceCriteria,
    rejectionCriteria: typeof payload.rejectionCriteria === "string" ? payload.rejectionCriteria : current.rejectionCriteria,
    evaluationCriteria: typeof payload.evaluationCriteria === "string" ? payload.evaluationCriteria : current.evaluationCriteria,
    reasoning: typeof payload.reasoning === "string" ? payload.reasoning : "",
    changes: Array.isArray(payload.changes) ? (payload.changes as { tag: string; text: string }[]) : [],
    judgeModel,
    evidenceCount: cases.length,
    evaluationSettingsId: evaluator.evaluationSettingsId,
    current,
  };
}

// ---------------------------------------------------------------------------
// Validate: exact re-judging. The "current" side is the evaluator's real production verdict
// (that IS the current criteria's output); only the candidate needs fresh judge calls.
// ---------------------------------------------------------------------------

export type JudgeTuningValidation = {
  threshold: number;
  disagreements: { total: number; fixed: number };
  controls: { total: number; preserved: number };
  netAgreementGain: number;
  verdict: "improved" | "regressed" | "tie" | "insufficient";
  summary: string;
  cases: {
    eventId: string;
    kind: "disagreement" | "control";
    originalRating: number;
    candidateRating: number | null;
    groundTruthBad: boolean;
    candidateAgrees: boolean | null;
    error: string | null;
  }[];
};

export async function validateJudgeTuning(
  db: Db,
  evaluatorId: string,
  candidate: { acceptanceCriteria: string; rejectionCriteria: string; evaluationCriteria: string },
  opts: { window?: MonitoringWindow } = {}
): Promise<JudgeTuningValidation | { error: string } | null> {
  const evaluator = await getOnlineEvaluatorRow(db, evaluatorId);
  if (!evaluator?.evaluationSettingsId) return null;
  const settings = await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId);
  if (!settings) return null;

  const calibration = await getEvaluatorCalibration(db, evaluatorId, opts.window ?? "7d");
  if (!calibration) return null;
  const disagreements = calibration.disagreementCases.slice(0, VALIDATE_DISAGREEMENT_CAP);
  const controls = calibration.agreementCases.slice(0, VALIDATE_CONTROL_CAP);
  if (disagreements.length === 0) {
    return { error: "Nothing to validate against - no recorded disagreements in the window" };
  }

  const criteria = {
    acceptanceCriteria: candidate.acceptanceCriteria,
    rejectionCriteria: candidate.rejectionCriteria,
    evaluationCriteria: candidate.evaluationCriteria,
    judgePrompt: (settings.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
    judgeModel: settings.judgeModel ?? DEFAULT_JUDGE_MODEL,
  };
  const threshold = calibration.threshold;

  const cases: JudgeTuningValidation["cases"] = [];
  for (const [kind, list] of [["disagreement", disagreements], ["control", controls]] as const) {
    for (const c of list) {
      try {
        const scored = await scoreAgainstCriteria(criteria, { input: c.input, output: c.output });
        const candidateBad = scored.rating < threshold;
        cases.push({
          eventId: c.eventId,
          kind,
          originalRating: c.rating,
          candidateRating: scored.rating,
          groundTruthBad: c.groundTruth.isBad,
          candidateAgrees: candidateBad === c.groundTruth.isBad,
          error: null,
        });
      } catch (err) {
        cases.push({
          eventId: c.eventId,
          kind,
          originalRating: c.rating,
          candidateRating: null,
          groundTruthBad: c.groundTruth.isBad,
          candidateAgrees: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const scoredDisagreements = cases.filter(c => c.kind === "disagreement" && c.candidateAgrees !== null);
  const scoredControls = cases.filter(c => c.kind === "control" && c.candidateAgrees !== null);
  if (scoredDisagreements.length === 0) {
    return {
      threshold,
      disagreements: { total: disagreements.length, fixed: 0 },
      controls: { total: scoredControls.length, preserved: scoredControls.filter(c => c.candidateAgrees).length },
      netAgreementGain: 0,
      verdict: "insufficient",
      summary: "Every disagreement case errored during re-judging - check the judge model key.",
      cases,
    };
  }
  const fixed = scoredDisagreements.filter(c => c.candidateAgrees).length;
  const preserved = scoredControls.filter(c => c.candidateAgrees).length;
  const broken = scoredControls.length - preserved;
  // Current criteria by construction: agree on 0 disagreements, all controls. Net gain is fixed
  // disagreements minus newly-broken controls.
  const netAgreementGain = fixed - broken;
  const verdict: JudgeTuningValidation["verdict"] = netAgreementGain > 0 ? "improved" : netAgreementGain < 0 ? "regressed" : "tie";
  const summary = `Candidate criteria agree with recorded reality on ${fixed}/${scoredDisagreements.length} cases the current criteria got wrong, and preserve ${preserved}/${scoredControls.length} cases they got right (net ${netAgreementGain >= 0 ? "+" : ""}${netAgreementGain}).`;

  return {
    threshold,
    disagreements: { total: scoredDisagreements.length, fixed },
    controls: { total: scoredControls.length, preserved },
    netAgreementGain,
    verdict,
    summary,
    cases,
  };
}
