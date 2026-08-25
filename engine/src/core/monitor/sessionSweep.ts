import type { Db } from "../../storage/db.js";
import { getDb, withProjectId } from "../../storage/db.js";
import { runWithTenancy } from "../../auth/requestContext.js";
import { listProjectRows } from "../project/projects.js";
import { listSessions } from "./sessions.js";
import {
  listSessionScores,
  insertSessionScore,
  buildSessionTranscript,
  type SpanWire,
  type SessionFinding,
} from "./sessionScores.js";
import { listOnlineEvaluatorRows, type OnlineEvaluatorRow } from "./onlineEvaluators.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";
import { listSessionSpans } from "../trace/ingest.js";
import { renderSessionUsedToolDefinitions } from "../trace/trajectory.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { upsertSignal } from "./signals.js";
import { recordEvent } from "./events.js";
import { acquireSweepLease } from "../shared/sweepLease.js";
import { SESSION_BASELINE_KEY } from "./builtinEvaluators.js";
import { logger } from "../../log.js";

// The idle-session sweep: session-scoped Online Evaluators' only trigger. Sessions have no end
// event, so "when do we judge a conversation?" is answered the same way Braintrust's trace/group
// scoped online scoring answers it: once the session has been QUIET for the evaluator's
// idleSeconds, judge the assembled transcript; if the session later grows, the next sweep judges
// it again (the "latest score newer than the session's last activity" check below is what makes
// re-scoring automatic without ever re-judging an unchanged session). Langfuse documents the
// gap outright ("Langfuse does not inherently know when a session has concluded") - this is the
// closing of it.
//
// Only sessions with 2+ turns qualify: every SDK trace auto-creates a single-turn session
// (sdk_<uuid>) and OTel groups one interaction's spans under one session id, so sweeping
// single-turn sessions would judge every individual trace a second time at conversation prices.
const SWEEP_INTERVAL_MS = 60_000;
// Bounds one sweep's judge spend on a busy instance - anything left over is picked up next tick.
const MAX_JUDGED_PER_SWEEP = 5;
// How far back the sweep looks for candidate sessions - anything older was either already scored
// or has been idle so long that scoring it now answers no live monitoring question.
const CANDIDATE_WINDOW = "24h" as const;
// Every session judge returns structured FINDINGS alongside the score: per-step citations with a
// short category tag - what the session detail's judge rail renders and uses to flag turns.
const FINDINGS_SCHEMA_PROP = {
  findings: {
    type: "array",
    maxItems: 6,
    description:
      "Concrete failures against the criteria, cited to the numbered step where each occurred. Empty when the session passes cleanly.",
    items: {
      type: "object",
      properties: {
        stepIndex: { type: "number", description: "Index (from the numbered list) of the step this finding is about" },
        text: { type: "string", description: "One sentence describing exactly what went wrong at that step" },
        tag: { type: "string", description: "1-3 word category, e.g. 'Contradiction', 'Lost context', 'Tool misuse', 'Off-task'" },
      },
      required: ["stepIndex", "text", "tag"],
    },
  },
};

const SESSION_SCORE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "number", description: "0-10 rating for the whole session against the criteria" },
    justification: { type: "string", description: "What the session did well or where it failed the criteria" },
    ...FINDINGS_SCHEMA_PROP,
  },
  required: ["rating", "justification", "findings"],
};

// The Session Baseline Judge additionally localizes WHERE the conversation first broke - the
// drift pointer the old built-in coherence check had, kept through the merge into the evaluator
// pipeline because it's what makes a baseline failure actionable in the session view.
const SESSION_SCORE_WITH_DRIFT_SCHEMA = {
  type: "object",
  properties: {
    ...SESSION_SCORE_SCHEMA.properties,
    driftSpanIndex: {
      type: ["number", "null"],
      description:
        "Index (from the numbered list) of the FIRST step where the session broke the criteria, or null if none",
    },
  },
  required: ["rating", "justification", "findings", "driftSpanIndex"],
};

// Shared session-judge message assembly - used by the sweep (stored settings) and by the judge
// scorer editor's "Try it on a real session" (unsaved draft criteria), so the preview is
// byte-identical to what live session scoring sends.
function buildSessionJudgeMessage(input: {
  elidedNote: string;
  criteria: {
    acceptanceCriteria?: string | null;
    rejectionCriteria?: string | null;
    evaluationCriteria?: string | null;
  };
  toolDefinitions: string | null;
  transcript: string;
  withDrift: boolean;
}): string {
  const criteriaBlock = [
    input.criteria.acceptanceCriteria ? `Acceptance criteria: ${input.criteria.acceptanceCriteria}` : "",
    input.criteria.rejectionCriteria ? `Rejection criteria: ${input.criteria.rejectionCriteria}` : "",
    input.criteria.evaluationCriteria ? `Additional guidance: ${input.criteria.evaluationCriteria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `You are evaluating an ENTIRE multi-turn AI agent session against the criteria below - judge the conversation as a whole (consistency across turns, whether the user's need was actually resolved, context retention), not any single reply in isolation. Each numbered entry is one step in chronological order.${input.elidedNote}

${criteriaBlock}${input.toolDefinitions ? `\n\nTool definitions (for the tools used in the transcript):\n${input.toolDefinitions}` : ""}

Session:

${input.transcript}

Rate the whole session 0-10 against the criteria (10 = fully meets them across the conversation). Cite each concrete failure as a finding against the numbered step where it occurred - specific and quotable, never a restatement of the overall rating.${
    input.withDrift ? " If the session broke the criteria, identify the index of the FIRST step where it happened." : ""
  }`;
}

// One draft-rubric session verdict for the editor's "Try it" rail: the same transcript assembly
// and structured session prompt as the sweep, but with UNSAVED criteria and nothing persisted.
// Throws on judge failure (the route maps it to 502); null when the session has no spans.
export async function judgeSessionWithDraftCriteria(
  db: Db,
  sessionId: string,
  draft: {
    acceptanceCriteria?: string;
    rejectionCriteria?: string;
    evaluationCriteria?: string;
    judgeModel?: string;
    toolContext?: string;
  }
): Promise<{ rating: number | null; justification: string | null } | null> {
  const spans = (await listSessionSpans(db, sessionId)) as SpanWire[];
  if (spans.length === 0) {
    return null;
  }
  const toolContext = draft.toolContext === "none" || draft.toolContext === "detailed" ? draft.toolContext : "simple";
  const transcriptSpans = toolContext === "none" ? spans.filter(s => !s.parentSpanId) : spans;
  const { transcript, elidedNote } = buildSessionTranscript(transcriptSpans, {
    includeToolLines: toolContext !== "none",
  });
  const toolDefinitions =
    toolContext === "detailed" ? await renderSessionUsedToolDefinitions(db, sessionId).catch(() => null) : null;
  const result = await callJudgeJson({
    model: (draft.judgeModel ?? "").trim() || DEFAULT_JUDGE_MODEL,
    jsonSchema: SESSION_SCORE_SCHEMA,
    userMessage: buildSessionJudgeMessage({ elidedNote, criteria: draft, toolDefinitions, transcript, withDrift: false }),
    maxTokens: 1600,
  });
  const payload = result.payload as { rating?: unknown; justification?: unknown } | null;
  return {
    rating: typeof payload?.rating === "number" ? Math.max(0, Math.min(10, payload.rating)) : null,
    justification: typeof payload?.justification === "string" ? payload.justification : null,
  };
}

async function judgeSessionAgainstEvaluator(
  db: Db,
  sessionId: string,
  spanCount: number,
  evaluator: OnlineEvaluatorRow
): Promise<{
  rating: number | null;
  justification: string | null;
  judgeModel: string;
  anchorTraceId: string | null;
  driftSpanId: string | null;
  findings: SessionFinding[];
} | null> {
  const settings = evaluator.evaluationSettingsId
    ? await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId)
    : null;
  if (!settings) {
    logger.error(`Session sweep: evaluator "${evaluator.name}" has no valid evaluator config, skipping`);
    return null;
  }
  const spans = (await listSessionSpans(db, sessionId)) as SpanWire[];
  if (spans.length === 0) {
    return null;
  }
  // toolContext gates what the session judge sees, mirroring the per-trace levels:
  // "none" = conversation turns only (root spans, no tools-called lines), "simple" = every
  // step incl. tool spans (the historical behavior and the default), "detailed" = simple +
  // definitions of the tools the conversation actually used.
  const toolContext = settings.toolContext ?? "simple";
  const transcriptSpans = toolContext === "none" ? spans.filter(s => !s.parentSpanId) : spans;
  const { transcript, promptSpans, elidedNote } = buildSessionTranscript(transcriptSpans, {
    includeToolLines: toolContext !== "none",
  });
  const toolDefinitions =
    toolContext === "detailed" ? await renderSessionUsedToolDefinitions(db, sessionId).catch(() => null) : null;
  const judgeModel = settings.judgeModel ?? DEFAULT_JUDGE_MODEL;

  // Deliberate: session scope builds its own structured prompt from the criteria fields and
  // does NOT use settings.judgePrompt. That prompt is {input}/{output}-templated for a single
  // trace and cannot address a numbered multi-turn transcript, and the builtin baseline's
  // drift-index schema depends on this framing. Documented on the LLM Judge Scorer surface:
  // "judge.judgePrompt applies to trace-scope scoring; session scope always uses the structured
  // session prompt built from your criteria."
  const withDrift = evaluator.builtinKey === SESSION_BASELINE_KEY;
  const userMessage = buildSessionJudgeMessage({
    elidedNote,
    criteria: settings,
    toolDefinitions,
    transcript,
    withDrift,
  });
  const result = await callJudgeJson({
    model: judgeModel,
    jsonSchema: withDrift ? SESSION_SCORE_WITH_DRIFT_SCHEMA : SESSION_SCORE_SCHEMA,
    userMessage,
    maxTokens: 1600,
  });
  const payload = result.payload as {
    rating?: unknown;
    justification?: unknown;
    driftSpanIndex?: unknown;
    findings?: unknown;
  } | null;
  const rating = typeof payload?.rating === "number" ? Math.max(0, Math.min(10, payload.rating)) : null;
  const justification = typeof payload?.justification === "string" ? payload.justification : null;
  // Step-index citations -> real span ids, same elision rule as the drift pointer below: the id
  // is only resolved when the transcript wasn't elided, but the finding TEXT is kept either way.
  const findings: SessionFinding[] = (Array.isArray(payload?.findings) ? payload.findings : [])
    .filter(
      (f): f is { stepIndex: number; text: string; tag: string } =>
        !!f &&
        typeof f === "object" &&
        typeof (f as { stepIndex?: unknown }).stepIndex === "number" &&
        typeof (f as { text?: unknown }).text === "string" &&
        typeof (f as { tag?: unknown }).tag === "string"
    )
    .slice(0, 6)
    .map(f => ({
      spanIndex: f.stepIndex,
      spanId:
        !elidedNote && Number.isInteger(f.stepIndex) && f.stepIndex >= 0 && f.stepIndex < promptSpans.length
          ? promptSpans[f.stepIndex]!._id
          : null,
      text: f.text,
      tag: f.tag.slice(0, 40),
    }));
  // Excerpt-index -> real span id, only trustworthy when nothing was elided (with elision the
  // ambiguity isn't worth a wrong span highlight) - same rule the old coherence check applied.
  const driftIndex =
    withDrift && typeof payload?.driftSpanIndex === "number" && Number.isInteger(payload.driftSpanIndex)
      ? payload.driftSpanIndex
      : null;
  const driftSpanId =
    driftIndex !== null && !elidedNote && driftIndex >= 0 && driftIndex < promptSpans.length
      ? promptSpans[driftIndex]!._id
      : null;
  // The session's LAST root trace (spans arrive chronologically sorted from listSessionSpans) -
  // the monitor_events dual-write anchors the session verdict there so trace-keyed ground truth
  // (outcome reports, end-user votes, triage corrections on that final exchange) can join it in
  // calibration and tuning. Fallback: last span of any kind (OTel sessions whose roots folded).
  const roots = spans.filter(s => !s.parentSpanId);
  const anchorTraceId = (roots.length > 0 ? roots[roots.length - 1] : spans[spans.length - 1])?._id ?? null;
  // spanCount recorded via insertSessionScore by the caller; returned shape kept minimal.
  void spanCount;
  return { rating, justification, judgeModel, anchorTraceId, driftSpanId, findings };
}

// The per-session "Re-run now" button's path (POST /sessions/:id/coherence-check, route name
// kept for wire compat): one on-demand Session Baseline Judge verdict, same judging + score
// shape as the sweep's automatic runs. Deliberately ignores `enabled` - an explicit human click
// on a paused built-in should still work, matching how paused patterns still dry-run.
export async function runSessionBaselineCheck(db: Db, sessionId: string) {
  const evaluator = (await listOnlineEvaluatorRows(db)).find(e => e.builtinKey === SESSION_BASELINE_KEY);
  if (!evaluator) {
    return null;
  }
  return runSessionEvaluatorCheck(db, sessionId, evaluator.id);
}

// Whether this evaluator already scored the session after its last activity - the exact
// freshness check the sweep applies before re-judging a grown session. Exposed for the judge
// route's ifStale mode (importers like the SDK's Moveworks sync judge backfilled sessions
// explicitly, and this keeps them from double-judging sessions the 24h sweep will also cover).
export async function isSessionScoreFresh(db: Db, sessionId: string, evaluatorId: string): Promise<boolean> {
  const spans = await listSessionSpans(db, sessionId);
  if (spans.length === 0) {
    return false;
  }
  const lastActivity = Math.max(
    ...spans.map(span => new Date(span.startedAt ?? span.createdAt).getTime())
  );
  const scores = await listSessionScores(db, sessionId);
  const latest = scores.find(score => score.kind === `online-eval:${evaluatorId}`);
  return !!latest && new Date(latest.createdAt).getTime() >= lastActivity;
}

// On-demand verdict from ANY session-scoped evaluator (the session detail's per-judge "Re-run"
// button) - same judging + score shape as the sweep's automatic runs, `enabled` deliberately
// ignored for an explicit human click.
export async function runSessionEvaluatorCheck(db: Db, sessionId: string, evaluatorId: string) {
  const evaluator = (await listOnlineEvaluatorRows(db)).find(e => e.id === evaluatorId && e.scope === "session");
  if (!evaluator) {
    return null;
  }
  const spans = await listSessionSpans(db, sessionId);
  if (spans.length === 0) {
    return null;
  }
  const verdict = await judgeSessionAgainstEvaluator(db, sessionId, spans.length, evaluator);
  if (!verdict) {
    return null;
  }
  return insertSessionScore(db, {
    sessionId,
    kind: `online-eval:${evaluator.id}`,
    rating: verdict.rating,
    justification: verdict.justification,
    driftSpanId: verdict.driftSpanId,
    findings: verdict.findings,
    spanCount: spans.length,
    judgeModel: verdict.judgeModel,
  });
}

// One pass over every project: find idle, unscored (or grown-since-scored) multi-turn sessions
// and judge them against each enabled session-scoped evaluator. Exported for the manual-trigger
// route (used by tests/demos); startSessionSweep below is the production path.
export async function sweepSessionsOnce(): Promise<{ judged: number }> {
  const baseDb = getDb();
  const projects = await listProjectRows(baseDb);
  let judged = 0;

  for (const project of projects) {
    if (judged >= MAX_JUDGED_PER_SWEEP) break;
    const db = withProjectId(baseDb, project.id);
    // Tenancy context for the judge calls below: multi-tenant instances resolve LLM keys from
    // the project's org settings (core/settings/appSettings.ts), and a sweep runs outside any
    // request, so the context has to be set explicitly here.
    await runWithTenancy(
      { projectId: project.id, organizationId: (project as { organizationId?: string | null }).organizationId ?? null },
      async () => {

    // The Session Baseline Judge (builtinEvaluators.ts) is just one of these rows now - its
    // enabled toggle replaced the old project-level coherence switch, and pausing it stops the
    // baseline judging like pausing any evaluator.
    const evaluators = (await listOnlineEvaluatorRows(db)).filter(e => e.enabled && e.scope === "session");
    if (evaluators.length === 0) return;

    const { sessions } = await listSessions(db, CANDIDATE_WINDOW);
    const now = Date.now();

    for (const session of sessions) {
      if (judged >= MAX_JUDGED_PER_SWEEP) break;
      if (session.turnCount < 2) continue;

      const lastActivity = new Date(session.lastAt).getTime();
      const scores = await listSessionScores(db, session.sessionId);

      for (const evaluator of evaluators) {
        if (judged >= MAX_JUDGED_PER_SWEEP) break;
        if (now - lastActivity < evaluator.idleSeconds * 1000) continue;
        if (!matchesAgentScope(evaluator, session.agentId)) continue;

        const kind = `online-eval:${evaluator.id}`;
        const latest = scores.find(s => s.kind === kind);
        // Already scored and nothing new arrived since - the re-score path is exactly this check
        // failing after the session grows (lastAt moves past the score's createdAt).
        if (latest && new Date(latest.createdAt).getTime() >= lastActivity) continue;
        if (!passesSampleRate(evaluator.sampleRate)) continue;

        try {
          const verdict = await judgeSessionAgainstEvaluator(db, session.sessionId, session.spanCount, evaluator);
          if (!verdict) continue;
          judged++;
          await insertSessionScore(db, {
            sessionId: session.sessionId,
            kind,
            rating: verdict.rating,
            justification: verdict.justification,
            driftSpanId: verdict.driftSpanId,
            findings: verdict.findings,
            spanCount: session.spanCount,
            judgeModel: verdict.judgeModel,
          });

          let signalId: string | null = null;
          if (
            evaluator.alertThreshold !== null &&
            verdict.rating !== null &&
            verdict.rating < evaluator.alertThreshold
          ) {
            // Same patternKey prefix as trace-scoped scoring, so the Signals list resolves the
            // evaluator's display name and "view" opens its dialog with zero new frontend
            // plumbing. traceId is the session's last root trace: the finding is about the whole
            // conversation (the summary names the session id for the Sessions view), but anchoring
            // the final exchange gives triage a real "view trace" jump instead of a dead end.
            const signal = await upsertSignal(
              db,
              {
                type: "online_evaluator_low_session_score",
                severity: evaluator.severity,
                polarity: "failure",
                summary: `"${evaluator.name}" rated session ${session.sessionId} ${verdict.rating.toFixed(1)}/10 (below the ${evaluator.alertThreshold} threshold): ${verdict.justification ?? ""}`,
                patternKey: `online-eval:${evaluator.id}`,
                rootCause: evaluator.name,
              },
              { agentId: session.agentId, traceId: verdict.anchorTraceId }
            );
            signalId = signal._id;
          }

          // Dual-write into monitor_events: before this, session verdicts lived only in
          // session_scores, invisible to everything keyed on evaluator events - the ratings
          // dialog, calibration, judge tuning, and per-evaluator trend queries all select on
          // onlineEvaluatorId. The distinct type keeps session rows tellable apart from
          // per-trace "online_eval_score" rows; sessionId is the real subject and traceId is
          // just the anchor (see judgeSessionAgainstEvaluator's comment).
          if (verdict.rating !== null) {
            await recordEvent(db, {
              signalId,
              patternKey: `online-eval:${evaluator.id}`,
              type: "online_eval_session_score",
              severity: "low",
              polarity: "score",
              agentId: session.agentId,
              traceId: verdict.anchorTraceId,
              onlineEvaluatorId: evaluator.id,
              rating: verdict.rating,
              justification: verdict.justification,
              sessionId: session.sessionId,
            });
          }
        } catch (err) {
          // Isolated per session+evaluator, same posture as every other detector loop - one
          // failing judge call (missing key, provider outage) never blocks the rest of the sweep.
          logger.error(
            { err },
            `Session sweep: evaluator "${evaluator.name}" failed on session ${session.sessionId}`
          );
        }
      }
    }
      }
    );
  }
  return { judged };
}

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

// Called once from index.ts after the server is listening. AGENTX_SESSION_SWEEP=false disables
// entirely (e.g. test environments that don't want background judge spend).
export function startSessionSweep(): void {
  if (process.env.AGENTX_SESSION_SWEEP === "false") {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweeping) return; // a slow judge round must not stack a second concurrent sweep
    sweeping = true;
    // The lease is the cross-REPLICA version of the `sweeping` flag above: N engines sharing one
    // database elect one sweeper per tick instead of all judging the same idle sessions. TTL
    // covers a worst-case round (MAX_JUDGED_PER_SWEEP slow judge calls) so a crashed holder's
    // lease times out on its own. The manual /session-sweep/run route bypasses this on purpose.
    acquireSweepLease(getDb(), "session-sweep", 5 * 60_000)
      .then(acquired => (acquired ? sweepSessionsOnce() : null))
      .catch((err: unknown) => logger.error({ err }, "Session sweep failed"))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep - Ctrl+C shuts down cleanly without an
  // explicit clearInterval in the signal handler.
  sweepTimer.unref();
}

export function stopSessionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
