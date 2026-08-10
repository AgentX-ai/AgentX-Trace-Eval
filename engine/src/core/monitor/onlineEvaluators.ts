import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { scoreAgainstCriteria, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { recordEvent } from "./events.js";
import { upsertSignal } from "./signals.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";

// LangSmith's actual "online evals": a real judge scoring sampled live traffic continuously,
// producing a rating over time — distinct from core/monitor/detect.ts's pattern-matching (a
// binary signal). References an evaluationSettingsId (an "Evaluator" config, core/evaluate/
// evaluationSettings.ts) for its criteria/judge prompt/judge model rather than storing its own
// copy — that used to be inline before the standalone-config creation UI existed; it does now, so
// the config is the single source of truth, shared with Runs via EvaluationConfigSelector on the
// frontend.
export type CreateOnlineEvaluatorInput = {
  name: string;
  evaluationSettingsId: string;
  sampleRate?: number;
  scopeMode?: string;
  agentIds?: string[];
  enabled?: boolean;
  // A score below this raises/updates a Signal (see runOnlineEvaluators below), same triage
  // surface a failing Pattern match already lands on. Pass null to score without ever raising a
  // Signal, e.g. an evaluator being run purely to populate the ratings chart.
  alertThreshold?: number | null;
  severity?: string;
};

export type UpdateOnlineEvaluatorInput = Partial<CreateOnlineEvaluatorInput>;

export type OnlineEvaluatorRow = {
  id: string;
  projectId: string | null;
  name: string;
  evaluationSettingsId: string | null;
  sampleRate: number;
  scopeMode: string;
  agentIds: unknown;
  enabled: boolean;
  alertThreshold: number | null;
  severity: string;
  createdAt: Date;
};

function toWire(row: OnlineEvaluatorRow) {
  return {
    _id: row.id,
    name: row.name,
    evaluationSettingsId: row.evaluationSettingsId ?? undefined,
    sampleRate: row.sampleRate,
    scopeMode: row.scopeMode,
    agentIds: (row.agentIds as string[] | null) ?? [],
    enabled: row.enabled,
    alertThreshold: row.alertThreshold,
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
  };
}

// Thrown by create/update when evaluationSettingsId doesn't resolve to a real config — the route
// layer (routes/agentMonitoringDashboard.ts) turns this into a 400, same shape as the existing
// "name is required" validation error.
export class InvalidEvaluationSettingsIdError extends Error {}

async function assertEvaluationSettingsExists(db: Db, evaluationSettingsId: string): Promise<void> {
  const row = await getEvaluationSettingsRow(db, evaluationSettingsId);
  if (!row) {
    throw new InvalidEvaluationSettingsIdError(`evaluationSettingsId "${evaluationSettingsId}" does not refer to an existing evaluator config`);
  }
}

export async function createOnlineEvaluator(db: Db, input: CreateOnlineEvaluatorInput) {
  await assertEvaluationSettingsExists(db, input.evaluationSettingsId);
  const row: OnlineEvaluatorRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    evaluationSettingsId: input.evaluationSettingsId,
    // Every check here is a real LLM call against the user's own API key — default meaningfully
    // lower than a pattern's (1), sampling isn't optional the way it arguably is for pattern-
    // matching (usually free string/regex work).
    sampleRate: input.sampleRate ?? 0.1,
    scopeMode: input.scopeMode ?? "all",
    agentIds: input.agentIds ?? null,
    enabled: input.enabled ?? true,
    alertThreshold: input.alertThreshold !== undefined ? input.alertThreshold : 5,
    severity: input.severity ?? "medium",
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorOnlineEvaluators).values(row);
  } else {
    await db.db.insert(db.schema.monitorOnlineEvaluators).values(row);
  }
  return toWire(row);
}

export async function getOnlineEvaluatorRow(db: Db, id: string): Promise<OnlineEvaluatorRow | null> {
  const cond = and(eq(db.schema.monitorOnlineEvaluators.id, id), eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond).all()[0] as OnlineEvaluatorRow | undefined)
      : ((await db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond))[0] as OnlineEvaluatorRow | undefined);
  return row ?? null;
}

export async function getOnlineEvaluator(db: Db, id: string) {
  const row = await getOnlineEvaluatorRow(db, id);
  return row ? toWire(row) : null;
}

export async function listOnlineEvaluatorRows(db: Db): Promise<OnlineEvaluatorRow[]> {
  const cond = eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond).all()
      : await db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond);
  return rows as OnlineEvaluatorRow[];
}

export async function listOnlineEvaluatorsWire(db: Db) {
  return (await listOnlineEvaluatorRows(db)).map(toWire);
}

export async function updateOnlineEvaluator(db: Db, id: string, input: UpdateOnlineEvaluatorInput) {
  const existing = await getOnlineEvaluatorRow(db, id);
  if (!existing) {
    return null;
  }
  if (input.evaluationSettingsId !== undefined) {
    await assertEvaluationSettingsExists(db, input.evaluationSettingsId);
  }
  const updated: OnlineEvaluatorRow = {
    ...existing,
    name: input.name ?? existing.name,
    evaluationSettingsId: input.evaluationSettingsId ?? existing.evaluationSettingsId,
    sampleRate: input.sampleRate ?? existing.sampleRate,
    scopeMode: input.scopeMode ?? existing.scopeMode,
    agentIds: input.agentIds !== undefined ? input.agentIds : existing.agentIds,
    enabled: input.enabled ?? existing.enabled,
    alertThreshold: input.alertThreshold !== undefined ? input.alertThreshold : existing.alertThreshold,
    severity: input.severity ?? existing.severity,
  };
  const setValues = {
    name: updated.name,
    evaluationSettingsId: updated.evaluationSettingsId,
    sampleRate: updated.sampleRate,
    scopeMode: updated.scopeMode,
    agentIds: updated.agentIds,
    enabled: updated.enabled,
    alertThreshold: updated.alertThreshold,
    severity: updated.severity,
  };
  const updateCond = and(eq(db.schema.monitorOnlineEvaluators.id, id), eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorOnlineEvaluators).set(setValues).where(updateCond);
  } else {
    await db.db.update(db.schema.monitorOnlineEvaluators).set(setValues).where(updateCond);
  }
  return toWire(updated);
}

export async function deleteOnlineEvaluator(db: Db, id: string): Promise<boolean> {
  const existing = await getOnlineEvaluatorRow(db, id);
  if (!existing) {
    return false;
  }
  const deleteCond = and(eq(db.schema.monitorOnlineEvaluators.id, id), eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.monitorOnlineEvaluators).where(deleteCond);
  } else {
    await db.db.delete(db.schema.monitorOnlineEvaluators).where(deleteCond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type ScorableTrace = { input?: unknown; output?: unknown };

// Called from both ingest paths (routes/ingest.ts, routes/otlp.ts) after every trace, independent
// of that trace's own `monitor` flag — online evaluators are a server-side-configured feature (you
// opt in by creating one, not per SDK call), same as a LangSmith Rule fires from server config,
// not a client-side flag. Callers MUST wrap this in a try/catch: a judge failure (missing API key,
// provider outage) must never break trace ingestion, which is the endpoint's actual job.
export async function runOnlineEvaluators(
  db: Db,
  trace: ScorableTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  const evaluators = await listOnlineEvaluatorRows(db);
  const inputText = typeof trace.input === "string" ? trace.input : JSON.stringify(trace.input ?? "");
  const outputText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");

  for (const evaluator of evaluators) {
    if (!evaluator.enabled) continue;
    if (!matchesAgentScope(evaluator, ctx.agentId)) continue;
    if (!passesSampleRate(evaluator.sampleRate)) continue;

    // Resolve the referenced Evaluator config for its criteria/judge prompt/judge model — the
    // evaluator itself only stores the reference (see this file's header comment). A missing
    // reference shouldn't happen given create/update validation (assertEvaluationSettingsExists),
    // but is handled defensively the same isolated-skip way a judge failure below is.
    const settings = evaluator.evaluationSettingsId ? await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId) : null;
    if (!settings) {
      console.error(`Online evaluator "${evaluator.name}" has no valid evaluator config, skipping`);
      continue;
    }

    let rating: number;
    let justification: string;
    try {
      ({ rating, justification } = await scoreAgainstCriteria(
        {
          acceptanceCriteria: settings.acceptanceCriteria ?? "",
          rejectionCriteria: settings.rejectionCriteria ?? "",
          evaluationCriteria: settings.evaluationCriteria ?? "",
          judgePrompt: (settings.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
          judgeModel: settings.judgeModel ?? DEFAULT_JUDGE_MODEL,
        },
        { input: inputText, output: outputText }
      ));
    } catch (err) {
      // One evaluator failing (missing API key, provider outage) must not skip every other
      // evaluator after it for this trace — isolated per-evaluator, same reasoning as
      // detect.ts's per-pattern isolation.
      console.error(`Online evaluator "${evaluator.name}" failed to score:`, err instanceof Error ? err.message : err);
      continue;
    }

    // Below the configured threshold, this is a failure exactly like a matched Pattern is, so it
    // raises/updates a Signal the same way (upsertSignal, deduped on patternKey+agentId) instead
    // of only ever being visible by opening this evaluator's own ratings dialog. alertThreshold
    // null means the evaluator was deliberately configured to never do this (e.g. one only run to
    // populate the ratings chart, no triage intended).
    let signalId: string | null = null;
    if (evaluator.alertThreshold !== null && rating < evaluator.alertThreshold) {
      const signal = await upsertSignal(
        db,
        {
          type: "online_evaluator_low_score",
          severity: evaluator.severity,
          polarity: "failure",
          summary: `"${evaluator.name}" rated this response ${rating.toFixed(1)}/10 (below the ${evaluator.alertThreshold} threshold): ${justification}`,
          patternKey: `online-eval:${evaluator.id}`,
          rootCause: evaluator.name,
        },
        { agentId: ctx.agentId, traceId: ctx.traceId, evidence: { input: trace.input, output: trace.output } }
      );
      signalId = signal._id;
    }

    await recordEvent(db, {
      signalId,
      patternKey: `online-eval:${evaluator.id}`,
      type: "online_eval_score",
      severity: "low",
      polarity: "score",
      agentId: ctx.agentId,
      traceId: ctx.traceId,
      onlineEvaluatorId: evaluator.id,
      rating,
      justification,
    });
  }
}
