import type { Db } from "../../storage/db.js";
import { getDb, withProjectId } from "../../storage/db.js";
import { listProjectRows } from "../project/projects.js";
import { listSessions } from "./sessions.js";
import { listSessionScores, insertSessionScore, buildSessionTranscript, type SpanWire } from "./sessionScores.js";
import { listOnlineEvaluatorRows, type OnlineEvaluatorRow } from "./onlineEvaluators.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";
import { listSessionSpans } from "../trace/ingest.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { upsertSignal } from "./signals.js";

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

const SESSION_SCORE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "number", description: "0-10 rating for the whole session against the criteria" },
    justification: { type: "string", description: "What the session did well or where it failed the criteria" },
  },
  required: ["rating", "justification"],
};

async function judgeSessionAgainstEvaluator(
  db: Db,
  sessionId: string,
  spanCount: number,
  evaluator: OnlineEvaluatorRow
): Promise<{ rating: number | null; justification: string | null; judgeModel: string } | null> {
  const settings = evaluator.evaluationSettingsId
    ? await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId)
    : null;
  if (!settings) {
    console.error(`Session sweep: evaluator "${evaluator.name}" has no valid evaluator config, skipping`);
    return null;
  }
  const spans = (await listSessionSpans(db, sessionId)) as SpanWire[];
  if (spans.length === 0) {
    return null;
  }
  const { transcript, elidedNote } = buildSessionTranscript(spans);
  const judgeModel = settings.judgeModel ?? DEFAULT_JUDGE_MODEL;

  const criteriaBlock = [
    settings.acceptanceCriteria ? `Acceptance criteria: ${settings.acceptanceCriteria}` : "",
    settings.rejectionCriteria ? `Rejection criteria: ${settings.rejectionCriteria}` : "",
    settings.evaluationCriteria ? `Additional guidance: ${settings.evaluationCriteria}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = `You are evaluating an ENTIRE multi-turn AI agent session against the criteria below - judge the conversation as a whole (consistency across turns, whether the user's need was actually resolved, context retention), not any single reply in isolation. Each numbered entry is one step in chronological order.${elidedNote}

${criteriaBlock}

Session:

${transcript}

Rate the whole session 0-10 against the criteria (10 = fully meets them across the conversation).`;

  const result = await callJudgeJson({
    model: judgeModel,
    jsonSchema: SESSION_SCORE_SCHEMA,
    userMessage,
    maxTokens: 1200,
  });
  const payload = result.payload as { rating?: unknown; justification?: unknown } | null;
  const rating = typeof payload?.rating === "number" ? Math.max(0, Math.min(10, payload.rating)) : null;
  const justification = typeof payload?.justification === "string" ? payload.justification : null;
  // spanCount recorded via insertSessionScore by the caller; returned shape kept minimal.
  void spanCount;
  return { rating, justification, judgeModel };
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

    const evaluators = (await listOnlineEvaluatorRows(db)).filter(e => e.enabled && e.scope === "session");
    if (evaluators.length === 0) continue;

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
            spanCount: session.spanCount,
            judgeModel: verdict.judgeModel,
          });

          if (
            evaluator.alertThreshold !== null &&
            verdict.rating !== null &&
            verdict.rating < evaluator.alertThreshold
          ) {
            // Same patternKey prefix as trace-scoped scoring, so the Signals list resolves the
            // evaluator's display name and "view" opens its dialog with zero new frontend
            // plumbing. traceId deliberately null: the finding is about the conversation, and the
            // summary names the session id for the Sessions view.
            await upsertSignal(
              db,
              {
                type: "online_evaluator_low_session_score",
                severity: evaluator.severity,
                polarity: "failure",
                summary: `"${evaluator.name}" rated session ${session.sessionId} ${verdict.rating.toFixed(1)}/10 (below the ${evaluator.alertThreshold} threshold): ${verdict.justification ?? ""}`,
                patternKey: `online-eval:${evaluator.id}`,
                rootCause: evaluator.name,
              },
              { agentId: session.agentId, traceId: null }
            );
          }
        } catch (err) {
          // Isolated per session+evaluator, same posture as every other detector loop - one
          // failing judge call (missing key, provider outage) never blocks the rest of the sweep.
          console.error(
            `Session sweep: evaluator "${evaluator.name}" failed on session ${session.sessionId}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
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
    sweepSessionsOnce()
      .catch(err => console.error("Session sweep failed:", err instanceof Error ? err.message : err))
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
