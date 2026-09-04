import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listEventsSince, windowConfig, type MonitoringWindow, type EventRow } from "./events.js";
import { getOnlineEvaluatorRow } from "./onlineEvaluators.js";
import { krippendorffAlpha, alphaBand, MIN_ALPHA_ITEMS } from "./agreement.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";
import { listEvaluationSettingsVersions } from "../evaluate/versions.js";
import { getTraceRow } from "../trace/ingest.js";
import { extractText } from "./events.js";
import {
  scoreAgainstCriteria,
  callJudgeJson,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_PROMPT,
  DEFAULT_REFERENCE_FREE_JUDGE_PROMPT,
} from "../evaluate/judge.js";

// Judge tuning: measure one online evaluator's verdicts against recorded reality, then improve
// the JUDGE'S OWN CRITERIA from the disagreements - the same evidence -> propose -> validate ->
// human-approved publish loop prompts and tool schemas already have, pointed at the evaluator.
//
// Ground truth comes from three streams, in priority order (richest first):
//   1. Signal-triage corrections (monitor_signal_feedback.correctedScore + rationale, attributed
//      to this evaluator via the event the human was correcting) - a human explicitly re-scoring
//      this judge's verdict, with reasoning. A row queued for autotune without a numeric
//      re-score counts too: queuing a specific verdict IS disputing it.
//   2. Human review labels (review_queue_items: good|bad + optional correctedScore + note) -
//      the deliberate label-and-calibrate stream, keyed by trace. This is what catches the
//      judge quietly PASSING bad answers, which signal triage structurally cannot see.
//   3. Outcome reports by trace (isNegative), which already include end-user feedback votes via
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
  source: "correction" | "confirmed" | "review" | "outcome" | "feedback";
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

// The windows calibration/tuning accept: the shared Monitor windows, plus "rubric" - verdicts
// produced by the CURRENT rubric, i.e. since this scorer's criteria were last edited/published
// (its latest evaluation-settings version), clamped to 30 days. That is the semantically right
// evidence set for tuning: older disagreements are complaints about criteria that no longer
// exist, and tuning from them re-litigates already-fixed issues. A scorer whose rubric was
// never edited has no version boundary and simply gets the full 30-day clamp.
export type TuningWindow = MonitoringWindow | "rubric";

export type EvaluatorCalibration = {
  evaluatorId: string;
  evaluatorName: string;
  threshold: number;
  // The window actually applied and its resolved start - so a UI can say "since the rubric was
  // published on <date>" instead of leaving the boundary invisible.
  window: TuningWindow;
  since: string;
  scoredEvents: number;
  withGroundTruth: number;
  agreements: number;
  overFlagged: number; // judge said bad, reality said fine - criteria too strict
  missed: number; // judge said fine, reality said bad - criteria too generous
  agreementRate: number | null;
  // Chance-corrected agreement (Krippendorff's alpha over the binary verdict pair - see
  // agreement.ts for the model and why it can be null). agreementRate alone is inflated by
  // class imbalance; alpha is the "is this judge better than a weighted coin" number.
  alpha: number | null;
  alphaBand: string | null;
  alphaMinItems: number; // the floor below which alpha is withheld, so UIs can explain a null
  // Mean absolute error between the judge's 0-10 rating and the human's re-score, over the
  // pairs where a correction actually carries a number - the magnitude story alpha can't tell.
  ratingMae: number | null;
  withCorrectedScore: number;
  disagreementCases: CalibrationCase[];
  agreementCases: CalibrationCase[];
};

type FeedbackCorrectionRow = {
  eventId: string | null;
  metric: string;
  correctedScore: number | null;
  rationale: string;
  queuedForAutotune: boolean | null;
  createdAt: Date;
};

type ReviewLabelRow = {
  traceId: string;
  label: string | null;
  correctedScore: number | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
};

type OutcomeRow = { traceId: string | null; isNegative: boolean; reason: string | null; reportedBy: string | null; reportedAt: Date };

export async function getEvaluatorCalibration(
  db: Db,
  evaluatorId: string,
  window: TuningWindow = "7d"
): Promise<EvaluatorCalibration | null> {
  const evaluator = await getOnlineEvaluatorRow(db, evaluatorId);
  if (!evaluator) return null;
  const threshold = evaluator.alertThreshold ?? DEFAULT_BAD_THRESHOLD;

  let since: Date;
  if (window === "rubric") {
    const clamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const versions = evaluator.evaluationSettingsId
      ? await listEvaluationSettingsVersions(db, evaluator.evaluationSettingsId)
      : [];
    const lastEdit = versions[0]?.createdAt ?? null; // newest first
    since = lastEdit && lastEdit.getTime() > clamp.getTime() ? lastEdit : clamp;
  } else {
    const { days } = windowConfig(window);
    since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
  const events = (await listEventsSince(db, since)).filter(
    (e): e is EventRow & { rating: number; traceId: string } =>
      e.onlineEvaluatorId === evaluatorId && e.rating !== null && e.traceId !== null
  );

  // Corrections keyed by the event the human was re-scoring; review labels and outcomes keyed
  // by trace. Three shapes count as a correction: an explicit re-score (correctedScore set, from
  // the Feedback dialog), a "false-positive" resolution from the Signal inbox (no score - the
  // human said "this flag was wrong", which is a verdict, not a number, so none is fabricated
  // for it), and a row queued for autotune (queuing a specific verdict disputes it). Corrections
  // are windowed on createdAt like every other stream - an ancient correction must not count
  // against this window's events just because the event happens to fall inside it.
  const feedbackCond = and(
    eq(db.schema.monitorSignalFeedback.projectId, db.projectId),
    gte(db.schema.monitorSignalFeedback.createdAt, since)
  );
  const corrections = (
    (db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorSignalFeedback).where(feedbackCond).all()
      : await db.db.select().from(db.schema.monitorSignalFeedback).where(feedbackCond)) as FeedbackCorrectionRow[]
  ).filter(
    c =>
      c.correctedScore !== null || c.metric === "false-positive" || c.metric === "confirmed" || c.queuedForAutotune === true
  );
  const correctionByEvent = new Map<string, FeedbackCorrectionRow>();
  const confirmationByEvent = new Map<string, FeedbackCorrectionRow>();
  for (const c of corrections) {
    if (!c.eventId) continue;
    // Confirms ("the flag was right", written by the Review queue's Confirm - signals.ts) are the
    // agreement half of the labeling. Kept in their own map so a bare confirm never outranks an
    // explicit re-score/false-positive on the same event in this latest-wins keying.
    if (c.metric === "confirmed" && c.correctedScore === null && !c.queuedForAutotune) {
      confirmationByEvent.set(c.eventId, c);
    } else {
      correctionByEvent.set(c.eventId, c); // later rows overwrite: latest correction wins
    }
  }

  // Labeled human-review rows, windowed on reviewedAt: the calibration pair the review queue
  // exists to produce (this stream was previously collected and displayed but fed nothing).
  const reviewCond = and(
    eq(db.schema.reviewQueueItems.projectId, db.projectId),
    eq(db.schema.reviewQueueItems.status, "labeled")
  );
  const reviewRows = (
    (db.kind === "sqlite"
      ? db.db.select().from(db.schema.reviewQueueItems).where(reviewCond).all()
      : await db.db.select().from(db.schema.reviewQueueItems).where(reviewCond)) as ReviewLabelRow[]
  ).filter(r => r.label && r.traceId && r.reviewedAt && r.reviewedAt.getTime() >= since.getTime());
  const reviewByTrace = new Map<string, ReviewLabelRow>();
  for (const r of reviewRows) {
    const existing = reviewByTrace.get(r.traceId);
    if (!existing || (r.reviewedAt?.getTime() ?? 0) > (existing.reviewedAt?.getTime() ?? 0)) {
      reviewByTrace.set(r.traceId, r);
    }
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
  let agreedBad = 0;
  let overFlagged = 0;
  let missed = 0;
  let withGroundTruth = 0;
  let withCorrectedScore = 0;
  let scoreErrorSum = 0;

  for (const event of events) {
    const correction = correctionByEvent.get(event.id);
    const confirmation = confirmationByEvent.get(event.id);
    const review = reviewByTrace.get(event.traceId);
    const outcome = outcomeByTrace.get(event.traceId);
    const judgedBad = event.rating < threshold;
    let groundTruth: GroundTruth | null = null;
    if (correction && correction.correctedScore !== null) {
      groundTruth = {
        source: "correction",
        isBad: correction.correctedScore < threshold,
        detail: correction.rationale,
        correctedScore: correction.correctedScore,
        reportedBy: null,
      };
    } else if (correction && correction.metric === "false-positive") {
      // A false-positive resolution asserts "the flagged response was actually fine" - a hard
      // not-bad verdict with no re-score attached.
      groundTruth = {
        source: "correction",
        isBad: false,
        detail: correction.rationale,
        correctedScore: null,
        reportedBy: null,
      };
    } else if (correction && correction.queuedForAutotune) {
      // Queued-for-autotune without a re-score: the human disputed THIS verdict, so ground
      // truth is its inverse.
      groundTruth = {
        source: "correction",
        isBad: !judgedBad,
        detail: correction.rationale,
        correctedScore: null,
        reportedBy: null,
      };
    } else if (confirmation) {
      // "Confirm" in signal review: event-specific human agreement that the flagged response was
      // genuinely bad. Ranked above the trace-level streams (review/outcome) because it labels
      // exactly this verdict, below explicit corrections which carry more information.
      groundTruth = {
        source: "confirmed",
        isBad: true,
        detail: confirmation.rationale,
        correctedScore: null,
        reportedBy: null,
      };
    } else if (review) {
      groundTruth = {
        source: "review",
        isBad: review.label === "bad",
        detail: review.note,
        correctedScore: review.correctedScore,
        reportedBy: review.reviewedBy,
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
    const agree = judgedBad === groundTruth.isBad;
    if (agree) {
      agreements++;
      if (judgedBad) agreedBad++;
    } else if (judgedBad) overFlagged++;
    else missed++;
    if (groundTruth.correctedScore !== null) {
      withCorrectedScore++;
      scoreErrorSum += Math.abs(event.rating - groundTruth.correctedScore);
    }

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

  const alpha = krippendorffAlpha({
    bothBad: agreedBad,
    bothFine: agreements - agreedBad,
    judgeOnlyBad: overFlagged,
    humanOnlyBad: missed,
  });

  return {
    evaluatorId,
    evaluatorName: evaluator.name,
    threshold,
    window,
    since: since.toISOString(),
    scoredEvents: events.length,
    withGroundTruth,
    agreements,
    overFlagged,
    missed,
    agreementRate: withGroundTruth > 0 ? Math.round((agreements / withGroundTruth) * 1000) / 1000 : null,
    alpha,
    alphaBand: alpha === null ? null : alphaBand(alpha),
    alphaMinItems: MIN_ALPHA_ITEMS,
    ratingMae: withCorrectedScore > 0 ? Math.round((scoreErrorSum / withCorrectedScore) * 100) / 100 : null,
    withCorrectedScore,
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
    judgePrompt: { type: "string" },
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
  required: ["acceptanceCriteria", "rejectionCriteria", "evaluationCriteria", "judgePrompt", "reasoning", "changes"],
  additionalProperties: false,
} as const;

export type JudgeTuningProposal = {
  acceptanceCriteria: string;
  rejectionCriteria: string;
  evaluationCriteria: string;
  judgePrompt: string;
  reasoning: string;
  changes: { tag: string; text: string }[];
  judgeModel: string;
  evidenceCount: number;
  evaluationSettingsId: string;
  current: { acceptanceCriteria: string; rejectionCriteria: string; evaluationCriteria: string; judgePrompt: string };
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
  opts: { window?: TuningWindow; caseEventIds?: string[]; judgeModel?: string } = {}
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

  // The RESOLVED prompt (empty config means the engine default) so the tuner sees what actually
  // runs. Which default depends on scope: this evaluator judges live traffic with no reference
  // answer, so the reference-free variant is the real runtime prompt.
  const currentJudgePrompt = (settings.judgePrompt ?? "").trim() || DEFAULT_REFERENCE_FREE_JUDGE_PROMPT;
  const current = {
    acceptanceCriteria: settings.acceptanceCriteria ?? "",
    rejectionCriteria: settings.rejectionCriteria ?? "",
    evaluationCriteria: settings.evaluationCriteria ?? "",
    judgePrompt: currentJudgePrompt,
  };
  const userMessage = `You are tuning an LLM-as-judge that continuously scores an AI agent's production responses 0-10 (below ${calibration.threshold} counts as "bad" and raises an alert). Its verdicts have been compared against recorded reality (human re-scores with rationales, real-world outcomes, end-user votes) and the cases below are where the judge got it WRONG.

You may revise both its grading CRITERIA and its JUDGE PROMPT (the framing instructions the criteria are appended to).

Current criteria:
- Acceptance criteria (what makes a response good): ${current.acceptanceCriteria || "(empty)"}
- Rejection criteria (what makes a response bad): ${current.rejectionCriteria || "(empty)"}
- Evaluation criteria (what to weigh): ${current.evaluationCriteria || "(empty)"}

Current judge prompt (a TEMPLATE - the literal placeholders {input} and {output} are substituted at scoring time and MUST both appear verbatim in any revision; {expected} is optional and is absent at runtime for this evaluator, so do not add instructions that depend on a reference answer):
---
${currentJudgePrompt}
---

Disagreement cases:

${cases.map(describeCase).join("\n\n")}

Rewrite so the judge would agree with the recorded ground truth on these cases. Human rationales are the strongest signal - encode the PRINCIPLE behind them, not the individual case. Do not overfit: no references to specific case content, and keep everything that was already working. Prefer criteria changes; only revise the judge prompt when the failure is in its framing (e.g. what it tells the judge to prioritize) rather than in the criteria. Return the complete revised text for all three criteria AND the judge prompt (return current text unchanged for anything that needs no change), a short reasoning, and an itemized change list tagged "added"/"tightened"/"removed".`;

  const judgeModel = opts.judgeModel || settings.judgeModel || DEFAULT_JUDGE_MODEL;
  const result = await callJudgeJson({ userMessage, model: judgeModel, jsonSchema: TUNING_SCHEMA, maxTokens: 3000 });
  const payload = result.payload as {
    acceptanceCriteria?: unknown;
    rejectionCriteria?: unknown;
    evaluationCriteria?: unknown;
    judgePrompt?: unknown;
    reasoning?: unknown;
    changes?: unknown;
  } | null;
  if (!payload || typeof payload.acceptanceCriteria !== "string") {
    throw new Error("The judge did not return a usable tuning proposal");
  }
  const changes = Array.isArray(payload.changes) ? (payload.changes as { tag: string; text: string }[]) : [];

  // Structural guard on the prompt template: a revision that drops {input} or {output} would
  // break every future substitution, so it falls back to the current prompt (noted in the change
  // list) rather than ever publishing a broken template. The criteria have no placeholders, so
  // they need no equivalent check.
  // Models sometimes echo the --- fences that delimit the current prompt in the meta-prompt;
  // strip them so they never accrete into the stored template across tuning rounds.
  const stripFences = (text: string) =>
    text
      .replace(/^\s*-{3,}\s*\n/, "")
      .replace(/\n\s*-{3,}\s*$/, "")
      .trim();
  let proposedJudgePrompt =
    typeof payload.judgePrompt === "string" && stripFences(payload.judgePrompt) ? stripFences(payload.judgePrompt) : currentJudgePrompt;
  if (!proposedJudgePrompt.includes("{input}") || !proposedJudgePrompt.includes("{output}")) {
    proposedJudgePrompt = currentJudgePrompt;
    changes.push({
      tag: "removed",
      text: "A proposed judge-prompt revision was discarded because it dropped the required {input}/{output} placeholders - the current prompt is kept unchanged.",
    });
  }

  return {
    acceptanceCriteria: payload.acceptanceCriteria,
    rejectionCriteria: typeof payload.rejectionCriteria === "string" ? payload.rejectionCriteria : current.rejectionCriteria,
    evaluationCriteria: typeof payload.evaluationCriteria === "string" ? payload.evaluationCriteria : current.evaluationCriteria,
    judgePrompt: proposedJudgePrompt,
    reasoning: typeof payload.reasoning === "string" ? payload.reasoning : "",
    changes,
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
  candidate: { acceptanceCriteria: string; rejectionCriteria: string; evaluationCriteria: string; judgePrompt?: string },
  opts: { window?: TuningWindow } = {}
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

  // Candidate judge prompt (when the proposal revised it) so validation measures the full
  // candidate package - prompt + criteria together, exactly what a publish would ship. Falls
  // back to the config's own prompt; scoreAgainstCriteria's reference-free selection still
  // applies when that resolves to the default.
  const criteria = {
    acceptanceCriteria: candidate.acceptanceCriteria,
    rejectionCriteria: candidate.rejectionCriteria,
    evaluationCriteria: candidate.evaluationCriteria,
    judgePrompt: candidate.judgePrompt?.trim() || (settings.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
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
