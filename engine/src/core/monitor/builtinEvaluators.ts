import type { Db } from "../../storage/db.js";
import { createEvaluationSettings } from "../evaluate/evaluationSettings.js";
import { listOnlineEvaluatorRows, createOnlineEvaluator } from "./onlineEvaluators.js";
import { getProjectRow } from "../project/projects.js";

// System-owned built-in evaluators, ensured per project at startup and on project creation. The
// point (vs the old hardcoded coherence check): the rubric lives in a REAL evaluator config, so
// nothing about how sessions are baseline-judged is frozen in code - judge tuning can rewrite
// the criteria from calibration evidence like any other evaluator, ratings/calibration dialogs
// work, and pausing it is the evaluator's own enabled toggle. The evaluator ROW stays read-only
// through the API except `enabled` (see updateOnlineEvaluator/deleteOnlineEvaluator's builtin
// guards), so the built-in can be paused or tuned but never renamed, rescoped, or deleted.

export const SESSION_BASELINE_KEY = "session-baseline";
export const SESSION_BASELINE_NAME = "Session Baseline Judge";

// The old runSessionCoherenceCheck rubric, expressed as evaluator criteria. This is only the
// SEED - after creation the config is the single source of truth and tuning may rewrite it;
// ensure() never overwrites an existing config.
const SEED_ACCEPTANCE_CRITERIA =
  "Later steps stay consistent with what earlier steps established (goals, facts, constraints, prior answers). " +
  "The agent maintains the thread of the task across turns, retains context it was already given, and the steps " +
  "compose into a sensible trajectory toward resolving the user's need.";
const SEED_REJECTION_CRITERIA =
  "The agent contradicts itself or earlier established facts, loses context it previously had (re-asking for " +
  "information already provided), drifts off-goal, or redoes work it already completed. Any single reply may look " +
  "fine in isolation - these are conversation-level failures.";
const SEED_EVALUATION_CRITERIA =
  "Judge the conversation as a whole, not any single reply: consistency across turns, context retention, and " +
  "whether the user's need was actually resolved by the end. Weigh whole-session trajectory over per-reply polish.";

// Idempotent per project. Existing installs that had turned the old project-level coherence
// toggle off get the built-in created DISABLED, so this migration never re-enables judging
// someone explicitly opted out of.
export async function ensureSessionBaselineJudge(db: Db): Promise<void> {
  const existing = (await listOnlineEvaluatorRows(db)).find(row => row.builtinKey === SESSION_BASELINE_KEY);
  if (existing) {
    return;
  }
  const project = await getProjectRow(db, db.projectId);
  const settings = await createEvaluationSettings(db, {
    name: SESSION_BASELINE_NAME,
    description:
      "Rubric for the built-in Session Baseline Judge (whole-conversation consistency, context retention, goal " +
      "drift). Seeded by the engine; tune or edit it like any evaluator config - the built-in evaluator always " +
      "judges with the current version.",
    acceptanceCriteria: SEED_ACCEPTANCE_CRITERIA,
    rejectionCriteria: SEED_REJECTION_CRITERIA,
    evaluationCriteria: SEED_EVALUATION_CRITERIA,
  });
  await createOnlineEvaluator(db, {
    name: SESSION_BASELINE_NAME,
    evaluationSettingsId: settings._id,
    sampleRate: 1,
    scopeMode: "all",
    // Scorers are opt-in: the baseline judge is created PAUSED and only runs once someone
    // switches it on (it also stays off for installs that had disabled the old coherence toggle).
    enabled: false,
    // Low-severity signal below 5: it's now a real evaluator, so a genuinely incoherent session
    // reaches the Signal inbox instead of only a table cell - at the lowest severity tier since
    // it's a baseline check, not the user's own quality bar.
    alertThreshold: 5,
    severity: "low",
    scope: "session",
    idleSeconds: 120,
    builtinKey: SESSION_BASELINE_KEY,
  });
}
