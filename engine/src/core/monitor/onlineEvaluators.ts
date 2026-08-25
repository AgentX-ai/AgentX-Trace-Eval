import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { scoreAgainstCriteria, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { recordEvent } from "./events.js";
import { upsertSignal } from "./signals.js";
import {
  cloneEvaluationSettings,
  getEvaluationSettingsRow,
  isDatasetTwinSettingsId,
} from "../evaluate/evaluationSettings.js";
import { renderTraceTrajectory, renderUsedToolDefinitions, getTraceRetrievalContext } from "../trace/trajectory.js";
import { logger } from "../../log.js";

// The ONLINE PROFILE of an LLM Judge Scorer (core/monitor/judgeScorers.ts is the unified
// surface): a real judge scoring sampled live traffic continuously, producing a rating over
// time - distinct from core/monitor/detect.ts's pattern-matching (a binary signal). This row
// stores routing/threshold state only; the rubric (criteria/judge prompt/judge model) lives on
// the referenced evaluation_settings row, which also carries the scorer's OFFLINE profile
// (dataset-run repetitions/similarity metrics/code scorers). Strict 1:1 since the unification:
// each config backs at most one online profile - legacy creates that would share a config get
// an automatic clone (see resolveBindableSettingsId below).
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
  // "trace" (default): judge each sampled trace at ingest. "session": judge whole idle
  // conversations via core/monitor/sessionSweep.ts instead - see schema.sqlite.ts's
  // monitorOnlineEvaluators.scope comment. idleSeconds only applies to session scope.
  scope?: string;
  idleSeconds?: number;
  // Internal-only (core/monitor/builtinEvaluators.ts) - the public create route never passes it.
  builtinKey?: string;
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
  scope: string;
  idleSeconds: number;
  // Non-null = system-owned built-in (core/monitor/builtinEvaluators.ts): API-immutable except
  // `enabled`, never deletable.
  builtinKey: string | null;
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
    scope: row.scope,
    idleSeconds: row.idleSeconds,
    builtinKey: row.builtinKey ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// Thrown by create/update when evaluationSettingsId doesn't resolve to a real config - the route
// layer (routes/agentMonitoringDashboard.ts) turns this into a 400, same shape as the existing
// "name is required" validation error.
export class InvalidEvaluationSettingsIdError extends Error {}

async function assertEvaluationSettingsExists(db: Db, evaluationSettingsId: string): Promise<void> {
  const row = await getEvaluationSettingsRow(db, evaluationSettingsId);
  if (!row) {
    throw new InvalidEvaluationSettingsIdError(`evaluationSettingsId "${evaluationSettingsId}" does not refer to an existing evaluator config`);
  }
}

// Which evaluator (if any) already holds this config as its online profile - the 1:1 invariant's
// lookup, also used by the unified surface's 409 check (core/monitor/judgeScorers.ts).
export async function findEvaluatorBoundToSettings(db: Db, evaluationSettingsId: string): Promise<OnlineEvaluatorRow | null> {
  const cond = and(
    eq(db.schema.monitorOnlineEvaluators.evaluationSettingsId, evaluationSettingsId),
    eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId)
  );
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond).all()[0] as OnlineEvaluatorRow | undefined)
      : ((await db.db.select().from(db.schema.monitorOnlineEvaluators).where(cond))[0] as OnlineEvaluatorRow | undefined);
  return row ?? null;
}

// Enforces the 1:1 judge-scorer invariant on the LEGACY create/update surfaces without breaking
// their wire contract: a config that is already another evaluator's online profile, or that
// doubles as a dataset twin, gets CLONED and the clone's id is bound instead. The caller's
// script keeps working; the response's evaluationSettingsId simply comes back as the clone
// (SDKs round-trip it opaquely). The unified /judge-scorers surface 409s instead - explicitness
// there, compatibility here.
async function resolveBindableSettingsId(db: Db, evaluationSettingsId: string, selfEvaluatorId?: string): Promise<string> {
  await assertEvaluationSettingsExists(db, evaluationSettingsId);
  const twin = await isDatasetTwinSettingsId(db, evaluationSettingsId);
  const bound = await findEvaluatorBoundToSettings(db, evaluationSettingsId);
  const boundElsewhere = bound !== null && bound.id !== selfEvaluatorId;
  if (!twin && !boundElsewhere) {
    return evaluationSettingsId;
  }
  const cloneId = await cloneEvaluationSettings(db, evaluationSettingsId);
  if (!cloneId) {
    throw new InvalidEvaluationSettingsIdError(`evaluationSettingsId "${evaluationSettingsId}" disappeared while binding`);
  }
  return cloneId;
}

export async function createOnlineEvaluator(db: Db, input: CreateOnlineEvaluatorInput) {
  const evaluationSettingsId = await resolveBindableSettingsId(db, input.evaluationSettingsId);
  const row: OnlineEvaluatorRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    evaluationSettingsId,
    // Every check here is a real LLM call against the user's own API key - default meaningfully
    // lower than a pattern's (1), sampling isn't optional the way it arguably is for pattern-
    // matching (usually free string/regex work).
    sampleRate: input.sampleRate ?? 0.1,
    scopeMode: input.scopeMode ?? "all",
    agentIds: input.agentIds ?? null,
    enabled: input.enabled ?? true,
    alertThreshold: input.alertThreshold !== undefined ? input.alertThreshold : 5,
    severity: input.severity ?? "medium",
    scope: input.scope === "session" ? "session" : "trace",
    idleSeconds: input.idleSeconds ?? 120,
    // Only builtinEvaluators.ts creates system rows - the public create route never sets this.
    builtinKey: input.builtinKey ?? null,
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
  let requestedSettingsId = input.evaluationSettingsId;
  if (requestedSettingsId !== undefined && requestedSettingsId !== existing.evaluationSettingsId) {
    requestedSettingsId = await resolveBindableSettingsId(db, requestedSettingsId, id);
  }
  // Built-ins are read-only except enabled: pausable, never editable away. Everything else in the
  // patch is ignored rather than erroring, so a stale full-object PUT from an older dashboard
  // can't corrupt the system row.
  const patch: UpdateOnlineEvaluatorInput = existing.builtinKey
    ? { enabled: input.enabled }
    : { ...input, evaluationSettingsId: requestedSettingsId };
  const input_ = patch;
  const updated: OnlineEvaluatorRow = {
    ...existing,
    name: input_.name ?? existing.name,
    evaluationSettingsId: input_.evaluationSettingsId ?? existing.evaluationSettingsId,
    sampleRate: input_.sampleRate ?? existing.sampleRate,
    scopeMode: input_.scopeMode ?? existing.scopeMode,
    agentIds: input_.agentIds !== undefined ? input_.agentIds : existing.agentIds,
    enabled: input_.enabled ?? existing.enabled,
    alertThreshold: input_.alertThreshold !== undefined ? input_.alertThreshold : existing.alertThreshold,
    severity: input_.severity ?? existing.severity,
    scope: input_.scope !== undefined ? (input_.scope === "session" ? "session" : "trace") : existing.scope,
    idleSeconds: input_.idleSeconds ?? existing.idleSeconds,
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
    scope: updated.scope,
    idleSeconds: updated.idleSeconds,
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
  // System rows can be paused (updateOnlineEvaluator's enabled path) but never deleted - the
  // ensure pass would just recreate one with default settings, silently discarding the tuned
  // rubric its config accumulated.
  if (existing.builtinKey) {
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

// Retrieved chunks for {context}-referencing judge prompts (the RAG metric pack): read from the
// trace's metadata.retrievalContext - a string, or an array of chunk strings joined with
// separators. Anything else (absent, wrong shape) means "no context", which the prompt states
// explicitly rather than judging against an empty string.
function extractRetrievalContext(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as { retrievalContext?: unknown }).retrievalContext;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (Array.isArray(raw)) {
    const chunks = raw.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
    if (chunks.length > 0) return chunks.map((c, i) => `[chunk ${i + 1}] ${c}`).join("\n\n");
  }
  return undefined;
}

type ScorableTrace = { input?: unknown; output?: unknown; metadata?: unknown };

// Called from both ingest paths (routes/ingest.ts, routes/otlp.ts) after every trace, independent
// of that trace's own `monitor` flag - online evaluators are a server-side-configured feature (you
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

  // Rendered once, lazily, shared by every evaluator scoring this trace - the judge sees the
  // agent's actual execution path (span subtree / tool calls), not just the final answer. A
  // render failure degrades to the old output-only judging rather than skipping the evaluator.
  let trajectoryPromise: Promise<string | null> | null = null;
  const getTrajectory = () => {
    if (!ctx.traceId) return Promise.resolve(null);
    if (!trajectoryPromise) {
      trajectoryPromise = renderTraceTrajectory(db, ctx.traceId).catch(() => null);
    }
    return trajectoryPromise;
  };
  // {context}-referencing judges (the RAG metric pack): explicit metadata.retrievalContext wins,
  // else fall back to what the trace actually recorded retrieving (SDK/LangChain/LlamaIndex
  // retrieval spans) - so RAG scoring works on real traffic with zero caller changes.
  // toolContext="detailed" evaluators: definitions of the tools this trace actually used
  // (trace-captured metadata.tools first, registry by name as fallback) - rendered once,
  // lazily, shared by every opted-in evaluator; a render failure degrades gracefully.
  let toolDefinitionsPromise: Promise<string | null> | null = null;
  const getToolDefinitions = () => {
    if (!ctx.traceId) return Promise.resolve(null);
    if (!toolDefinitionsPromise) {
      toolDefinitionsPromise = renderUsedToolDefinitions(db, ctx.traceId).catch(() => null);
    }
    return toolDefinitionsPromise;
  };
  const explicitContext = extractRetrievalContext(trace.metadata);
  let recordedContextPromise: Promise<string | null> | null = null;
  const getContext = () => {
    if (explicitContext) return Promise.resolve(explicitContext);
    if (!ctx.traceId) return Promise.resolve(null);
    if (!recordedContextPromise) {
      recordedContextPromise = getTraceRetrievalContext(db, ctx.traceId).catch(() => null);
    }
    return recordedContextPromise;
  };

  for (const evaluator of evaluators) {
    if (!evaluator.enabled) continue;
    // Session-scoped evaluators never run at ingest - the idle-session sweep
    // (core/monitor/sessionSweep.ts) is their only trigger, judging whole conversations instead
    // of individual traces.
    if (evaluator.scope === "session") continue;
    if (!matchesAgentScope(evaluator, ctx.agentId)) continue;
    if (!passesSampleRate(evaluator.sampleRate)) continue;

    // Resolve the referenced Evaluator config for its criteria/judge prompt/judge model - the
    // evaluator itself only stores the reference (see this file's header comment). A missing
    // reference shouldn't happen given create/update validation (assertEvaluationSettingsExists),
    // but is handled defensively the same isolated-skip way a judge failure below is.
    const settings = evaluator.evaluationSettingsId ? await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId) : null;
    if (!settings) {
      logger.error(`Online evaluator "${evaluator.name}" has no valid evaluator config, skipping`);
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
        {
          input: inputText,
          output: outputText,
          context: (await getContext()) ?? undefined,
          // toolContext gates how much the judge sees: "none" = conversation only,
          // "simple" = the trajectory (historical behavior), "detailed" = + definitions.
          trajectory: settings.toolContext !== "none" ? ((await getTrajectory()) ?? undefined) : undefined,
          toolDefinitions:
            settings.toolContext === "detailed" ? ((await getToolDefinitions()) ?? undefined) : undefined,
        }
      ));
    } catch (err) {
      // One evaluator failing (missing API key, provider outage) must not skip every other
      // evaluator after it for this trace - isolated per-evaluator, same reasoning as
      // detect.ts's per-pattern isolation.
      logger.error({ err: err instanceof Error ? err.message : err }, `Online evaluator "${evaluator.name}" failed to score:`);
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
