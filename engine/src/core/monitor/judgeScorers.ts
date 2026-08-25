import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { SimilarityConfig } from "../evaluate/datasets.js";
import type { CodeScorerConfig } from "../evaluate/codeScorer.js";
import {
  createEvaluationSettings,
  getEvaluationSettingsRow,
  isDatasetTwinSettingsId,
  listStandaloneEvaluationSettings,
  normalizeToolContext,
  patchEvaluationSettings,
  type EvaluationSettingsRow,
} from "../evaluate/evaluationSettings.js";
import { getEvaluationSettingsVersionCounts } from "../evaluate/versions.js";
import {
  createOnlineEvaluator,
  deleteOnlineEvaluator,
  findEvaluatorBoundToSettings,
  listOnlineEvaluatorRows,
  updateOnlineEvaluator,
  type OnlineEvaluatorRow,
} from "./onlineEvaluators.js";

// The unified LLM Judge Scorer (2026-08 consolidation): ONE entity with a judge rubric and two
// setting profiles, presented over the two storage halves that already existed -
//   - the evaluation_settings row = identity + `judge` rubric + `offline` profile
//     (dataset-run repetitions/similarity metrics/code scorers/default/status)
//   - the monitor_online_evaluators row = the optional `online` profile
//     (enabled/sampling/scope/threshold), strictly at most one per scorer
// The scorer's `_id` IS the settings id (what dataset runs and the Playground already
// reference); `online.profileId` IS the evaluator id (what `online-eval:<id>` patternKeys, KPI
// exclusions, ratings/events, and the tuning routes key on). Neither id ever changes here.
// Dataset "twins" (settings sharing a dataset's id) are dataset internals, not scorers - every
// function below treats them as not-found. Wire casing: camelCase only (the project convention).

export type JudgeScorerJudgeInput = {
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
  // How much tool context the judge sees: "none" (conversation + expected results only),
  // "simple" (tool inputs/outputs in trace order - the default and historical behavior),
  // "detailed" (simple + definitions for the tools actually used + a one-line unused-tools
  // mention). See evaluation_settings.toolContext.
  toolContext?: string;
  // Reference-centric rubric: offline-only. Enabling online scoring on such a scorer is a 409.
  requiresExpected?: boolean;
};

export type JudgeScorerOfflineInput = {
  numberOfRequests?: number;
  vectorSimilarity?: { enabled: boolean; model?: string };
  jaccardSimilarity?: { enabled: boolean };
  bleuScore?: { enabled: boolean };
  rougeScore?: { enabled: boolean };
  // Verdict gates and the sovereignty matrix ride in the same similarityConfig blob the legacy
  // config surface stored them in - passed through here so the unified surface is a strict
  // superset and nothing needs the legacy routes anymore.
  thresholds?: { enabled: boolean; gates?: unknown[] };
  sovereigntyIndex?: { enabled: boolean; models?: unknown[] };
  codeScorers?: CodeScorerConfig[];
  isDefault?: boolean;
  status?: string;
};

export type JudgeScorerOnlineInput = {
  enabled?: boolean;
  sampleRate?: number;
  scopeMode?: string;
  agentIds?: string[];
  alertThreshold?: number | null;
  severity?: string;
  scope?: string;
  idleSeconds?: number;
};

export type CreateJudgeScorerInput = {
  name: string;
  description?: string;
  judge?: JudgeScorerJudgeInput;
  offline?: JudgeScorerOfflineInput;
  online?: JudgeScorerOnlineInput | null;
};

// Sparse per top-level section: an absent section is untouched; `online: null` detaches the
// online profile; `online: {...}` upserts it (creating one is how an offline-only scorer
// "goes live").
export type UpdateJudgeScorerInput = Partial<CreateJudgeScorerInput>;

// 409 in the route layer: a mutation the builtin Session Baseline Judge does not allow
// (read-only except `enabled` and the judge rubric, which tuning legitimately edits).
export class BuiltinJudgeScorerError extends Error {}

const SIMILARITY_KEYS = ["vectorSimilarity", "jaccardSimilarity", "bleuScore", "rougeScore", "thresholds", "sovereigntyIndex"] as const;

function similarityFromOffline(offline: JudgeScorerOfflineInput | undefined, existing?: SimilarityConfig | null): SimilarityConfig | undefined {
  if (!offline || SIMILARITY_KEYS.every(k => offline[k] === undefined)) {
    return undefined;
  }
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const key of SIMILARITY_KEYS) {
    if (offline[key] !== undefined) merged[key] = offline[key];
  }
  return merged as SimilarityConfig;
}

export function toJudgeScorerWire(settings: EvaluationSettingsRow, evaluator: OnlineEvaluatorRow | null, versionCount: number) {
  const similarity = (settings.similarityConfig as Record<string, unknown> | null) ?? {};
  return {
    _id: settings.id,
    name: settings.name,
    description: settings.description ?? undefined,
    // Engine-seeded template (Example judge, RAG packs) vs. a scorer the user made - the
    // dashboard's first-run starter state shows only while no non-seeded scorer exists.
    seeded: settings.seeded ?? false,
    judge: {
      acceptanceCriteria: settings.acceptanceCriteria ?? undefined,
      rejectionCriteria: settings.rejectionCriteria ?? undefined,
      evaluationCriteria: settings.evaluationCriteria ?? undefined,
      judgePrompt: settings.judgePrompt ?? undefined,
      judgeModel: settings.judgeModel ?? undefined,
      toolContext: normalizeToolContext(settings.toolContext),
      // Reference-centric rubric: offline-only (online enable is refused, reference-less
      // offline items are skipped) - the "two grading modes" exception flag.
      requiresExpected: settings.requiresExpected ?? false,
    },
    offline: {
      numberOfRequests: settings.numberOfRequests,
      vectorSimilarity: similarity.vectorSimilarity ?? undefined,
      jaccardSimilarity: similarity.jaccardSimilarity ?? undefined,
      bleuScore: similarity.bleuScore ?? undefined,
      rougeScore: similarity.rougeScore ?? undefined,
      thresholds: similarity.thresholds ?? undefined,
      sovereigntyIndex: similarity.sovereigntyIndex ?? undefined,
      codeScorers: (settings.codeScorers as CodeScorerConfig[] | null) ?? undefined,
      isDefault: settings.isDefault,
      status: settings.status,
    },
    online: evaluator
      ? {
          profileId: evaluator.id,
          enabled: evaluator.enabled,
          sampleRate: evaluator.sampleRate,
          scopeMode: evaluator.scopeMode,
          agentIds: (evaluator.agentIds as string[] | null) ?? [],
          alertThreshold: evaluator.alertThreshold,
          severity: evaluator.severity,
          scope: evaluator.scope,
          idleSeconds: evaluator.idleSeconds,
          builtinKey: evaluator.builtinKey ?? undefined,
        }
      : null,
    createdAt: settings.createdAt,
    versionCount,
  };
}

export async function listJudgeScorers(db: Db) {
  // listStandaloneEvaluationSettings already excludes dataset twins and sorts newest-first;
  // re-fetch the raw rows here because its wire shape flattens similarityConfig.
  const standalone = await listStandaloneEvaluationSettings(db);
  const ids = standalone.map(s => s._id);
  if (ids.length === 0) {
    return [];
  }
  const cond = and(inArray(db.schema.evaluationSettings.id, ids), eq(db.schema.evaluationSettings.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationSettings).where(cond).all()
      : await db.db.select().from(db.schema.evaluationSettings).where(cond)
  ) as EvaluationSettingsRow[];
  const byId = new Map(rows.map(r => [r.id, r]));
  const evaluators = await listOnlineEvaluatorRows(db);
  const profileBySettingsId = new Map<string, OnlineEvaluatorRow>();
  for (const evaluator of evaluators) {
    if (evaluator.evaluationSettingsId && !profileBySettingsId.has(evaluator.evaluationSettingsId)) {
      profileBySettingsId.set(evaluator.evaluationSettingsId, evaluator);
    }
  }
  const versionCounts = await getEvaluationSettingsVersionCounts(db, ids);
  return ids
    .map(id => byId.get(id))
    .filter((row): row is EvaluationSettingsRow => row !== undefined)
    .map(row => toJudgeScorerWire(row, profileBySettingsId.get(row.id) ?? null, versionCounts[row.id] ?? 0));
}

export async function getJudgeScorer(db: Db, id: string) {
  const settings = await getEvaluationSettingsRow(db, id);
  if (!settings || (await isDatasetTwinSettingsId(db, id))) {
    return null;
  }
  const profile = await findEvaluatorBoundToSettings(db, id);
  const versionCounts = await getEvaluationSettingsVersionCounts(db, [id]);
  return toJudgeScorerWire(settings, profile, versionCounts[id] ?? 0);
}

export async function createJudgeScorer(db: Db, input: CreateJudgeScorerInput) {
  const settingsWire = await createEvaluationSettings(db, {
    name: input.name,
    description: input.description,
    numberOfRequests: input.offline?.numberOfRequests,
    similarityConfig: similarityFromOffline(input.offline),
    codeScorers: input.offline?.codeScorers,
    acceptanceCriteria: input.judge?.acceptanceCriteria,
    rejectionCriteria: input.judge?.rejectionCriteria,
    evaluationCriteria: input.judge?.evaluationCriteria,
    judgePrompt: input.judge?.judgePrompt,
    judgeModel: input.judge?.judgeModel,
    toolContext: input.judge?.toolContext !== undefined ? normalizeToolContext(input.judge.toolContext) : undefined,
    requiresExpected: input.judge?.requiresExpected,
    isDefault: input.offline?.isDefault,
    status: input.offline?.status,
  });
  if (input.online) {
    try {
      await createOnlineEvaluator(db, {
        name: input.name,
        evaluationSettingsId: settingsWire._id,
        ...input.online,
      });
    } catch (err) {
      // Compensating delete so a failed profile insert doesn't strand a half-created scorer
      // (same best-effort posture as the dashboard's dataset+settings twin create).
      await hardDeleteSettings(db, settingsWire._id).catch(() => undefined);
      throw err;
    }
  }
  return (await getJudgeScorer(db, settingsWire._id))!;
}

export async function updateJudgeScorer(db: Db, id: string, patch: UpdateJudgeScorerInput) {
  const settings = await getEvaluationSettingsRow(db, id);
  if (!settings || (await isDatasetTwinSettingsId(db, id))) {
    return null;
  }
  const profile = await findEvaluatorBoundToSettings(db, id);

  if (profile?.builtinKey) {
    // The builtin allows: judge-rubric edits (tuning does exactly this), and online.enabled.
    // Everything else - rename, detach, routing changes - is refused loudly rather than
    // silently ignored (the legacy surface ignores; the unified surface is explicit).
    const onlinePatch = patch.online;
    const onlineKeys = onlinePatch ? Object.keys(onlinePatch).filter(k => onlinePatch[k as keyof JudgeScorerOnlineInput] !== undefined) : [];
    const onlineOk = onlinePatch === undefined || (onlinePatch !== null && onlineKeys.every(k => k === "enabled"));
    if (!onlineOk || (patch.name !== undefined && patch.name !== settings.name) || patch.offline !== undefined) {
      throw new BuiltinJudgeScorerError(
        `"${settings.name}" is a built-in judge scorer: only online.enabled and the judge rubric can change`
      );
    }
  }

  const settingsPatch: Parameters<typeof patchEvaluationSettings>[2] = {};
  if (patch.name !== undefined) settingsPatch.name = patch.name;
  if (patch.description !== undefined) settingsPatch.description = patch.description;
  if (patch.judge) {
    for (const key of ["acceptanceCriteria", "rejectionCriteria", "evaluationCriteria", "judgePrompt", "judgeModel"] as const) {
      if (patch.judge[key] !== undefined) settingsPatch[key] = patch.judge[key];
    }
    if (patch.judge.toolContext !== undefined) settingsPatch.toolContext = normalizeToolContext(patch.judge.toolContext);
    if (patch.judge.requiresExpected !== undefined) settingsPatch.requiresExpected = patch.judge.requiresExpected;
  }
  if (patch.offline) {
    if (patch.offline.numberOfRequests !== undefined) settingsPatch.numberOfRequests = patch.offline.numberOfRequests;
    if (patch.offline.codeScorers !== undefined) settingsPatch.codeScorers = patch.offline.codeScorers;
    if (patch.offline.isDefault !== undefined) settingsPatch.isDefault = patch.offline.isDefault;
    if (patch.offline.status !== undefined) settingsPatch.status = patch.offline.status;
    const similarity = similarityFromOffline(patch.offline, settings.similarityConfig as SimilarityConfig | null);
    if (similarity !== undefined) settingsPatch.similarityConfig = similarity;
  }
  if (Object.keys(settingsPatch).length > 0) {
    await patchEvaluationSettings(db, id, settingsPatch);
  }

  if (patch.online === null) {
    if (profile) {
      const deleted = await deleteOnlineEvaluator(db, profile.id);
      if (!deleted && profile.builtinKey) {
        throw new BuiltinJudgeScorerError(`"${settings.name}" is a built-in judge scorer: its online profile cannot be detached`);
      }
    }
  } else if (patch.online) {
    if (profile) {
      await updateOnlineEvaluator(db, profile.id, {
        ...patch.online,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      });
    } else {
      await createOnlineEvaluator(db, {
        name: patch.name ?? settings.name,
        evaluationSettingsId: id,
        ...patch.online,
      });
    }
  } else if (patch.name !== undefined && profile && !profile.builtinKey) {
    // Name is canonical on the settings row; keep the profile row's copy in sync.
    await updateOnlineEvaluator(db, profile.id, { name: patch.name });
  }

  return (await getJudgeScorer(db, id))!;
}

export async function deleteJudgeScorer(db: Db, id: string): Promise<boolean> {
  const settings = await getEvaluationSettingsRow(db, id);
  if (!settings || (await isDatasetTwinSettingsId(db, id))) {
    return false;
  }
  const profile = await findEvaluatorBoundToSettings(db, id);
  if (profile?.builtinKey) {
    throw new BuiltinJudgeScorerError(`"${settings.name}" is a built-in judge scorer and cannot be deleted`);
  }
  if (profile) {
    await deleteOnlineEvaluator(db, profile.id);
  }
  await hardDeleteSettings(db, id);
  return true;
}

// Removes the settings row and its version history. Historical monitor_events/session_scores
// keyed on a deleted profile id are left in place, matching today's evaluator-delete behavior.
async function hardDeleteSettings(db: Db, id: string): Promise<void> {
  const versionsCond = and(
    eq(db.schema.evaluationSettingsVersions.evaluationSettingsId, id),
    eq(db.schema.evaluationSettingsVersions.projectId, db.projectId)
  );
  const settingsCond = and(eq(db.schema.evaluationSettings.id, id), eq(db.schema.evaluationSettings.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.evaluationSettingsVersions).where(versionsCond);
    await db.db.delete(db.schema.evaluationSettings).where(settingsCond);
  } else {
    await db.db.delete(db.schema.evaluationSettingsVersions).where(versionsCond);
    await db.db.delete(db.schema.evaluationSettings).where(settingsCond);
  }
}

// ---------------------------------------------------------------------------------------------
// "Try it on a real trace" (the Judge Scorer editor's rubric rail, per the claude.design
// Judge Scorer Modal mock): score ONE captured trace with an UNSAVED draft rubric, so the user
// sees what their criteria do before spending anything on live traffic. Exactly one judge call,
// assembled the same way runOnlineEvaluators assembles a reference-free live check.

export type JudgePreviewDraft = {
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
  toolContext?: string;
};

async function latestScorableTrace(db: Db, traceId?: string) {
  if (db.kind === "sqlite") {
    const t = db.schema.traces;
    const cond = traceId
      ? and(eq(t.id, traceId), eq(t.projectId, db.projectId))
      : and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), isNotNull(t.output), ne(t.output, ""));
    return db.db.select().from(t).where(cond).orderBy(desc(t.createdAt)).limit(1).all()[0] ?? null;
  }
  const t = db.schema.traces;
  const cond = traceId
    ? and(eq(t.id, traceId), eq(t.projectId, db.projectId))
    : and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), isNotNull(t.output), ne(t.output, ""));
  const rows = await db.db.select().from(t).where(cond).orderBy(desc(t.createdAt)).limit(1);
  return rows[0] ?? null;
}

// What the editor's "Try it" rail can score: recent root traces and recent multi-turn
// sessions (newest first), plus recent traffic volume for the live-scoring cost estimate.
export async function getJudgePreviewContext(db: Db): Promise<{
  traces: { traceId: string; input: string; output: string; createdAt: Date }[];
  sessions: { sessionId: string; firstInput: string; traceCount: number; lastAt: Date }[];
  dailyTraces: number;
}> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  let rows: Array<{ id: string; input: unknown; output: unknown; sessionId: string | null; createdAt: Date }>;
  let weekly: number;
  if (db.kind === "sqlite") {
    const t = db.schema.traces;
    rows = db.db
      .select({ id: t.id, input: t.input, output: t.output, sessionId: t.sessionId, createdAt: t.createdAt })
      .from(t)
      .where(and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), isNotNull(t.output), ne(t.output, "")))
      .orderBy(desc(t.createdAt))
      .limit(200)
      .all();
    const countCond = and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), gt(t.createdAt, weekAgo));
    weekly = Number(db.db.select({ n: count() }).from(t).where(countCond).all()[0]?.n ?? 0);
  } else {
    const t = db.schema.traces;
    rows = await db.db
      .select({ id: t.id, input: t.input, output: t.output, sessionId: t.sessionId, createdAt: t.createdAt })
      .from(t)
      .where(and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), isNotNull(t.output), ne(t.output, "")))
      .orderBy(desc(t.createdAt))
      .limit(200);
    const countCond = and(eq(t.projectId, db.projectId), isNull(t.parentSpanId), gt(t.createdAt, weekAgo));
    const countRows = await db.db.select({ n: count() }).from(t).where(countCond);
    weekly = Number(countRows[0]?.n ?? 0);
  }
  const traces = rows.slice(0, 12).map(r => ({
    traceId: r.id,
    input: asText(r.input),
    output: asText(r.output),
    createdAt: r.createdAt,
  }));
  // Sessions grouped from the same recent window, newest activity first. Only multi-turn ones:
  // every SDK trace auto-creates a single-turn session, which would just duplicate the trace
  // list at conversation prices.
  const bySession = new Map<string, { firstInput: string; traceCount: number; lastAt: Date }>();
  for (const r of rows) {
    if (!r.sessionId) continue;
    const existing = bySession.get(r.sessionId);
    if (existing) {
      existing.traceCount += 1;
      // rows are newest-first, so the LAST row seen for a session is its earliest turn.
      existing.firstInput = asText(r.input);
    } else {
      bySession.set(r.sessionId, { firstInput: asText(r.input), traceCount: 1, lastAt: r.createdAt });
    }
  }
  const sessions = [...bySession.entries()]
    .filter(([, v]) => v.traceCount >= 2)
    .slice(0, 8)
    .map(([sessionId, v]) => ({ sessionId, ...v }));
  return { traces, sessions, dailyTraces: Math.round(weekly / 7) };
}

// One reference-free judge call with the draft rubric - on one trace, or (sessionId) on a
// whole session via the sweep's exact structured session prompt. Throws on judge failure
// (missing API key, provider outage) - the route maps that to a 502 the dialog can show.
export async function previewJudgeScore(
  db: Db,
  draft: JudgePreviewDraft,
  target: { traceId?: string; sessionId?: string } = {}
): Promise<
  | { traceId?: string; sessionId?: string; rating: number | null; justification: string | null; latencyMs: number }
  | null
> {
  if (target.sessionId) {
    const { judgeSessionWithDraftCriteria } = await import("./sessionSweep.js");
    const startedAt = Date.now();
    const verdict = await judgeSessionWithDraftCriteria(db, target.sessionId, draft);
    if (!verdict) return null;
    return { sessionId: target.sessionId, ...verdict, latencyMs: Date.now() - startedAt };
  }
  const row = await latestScorableTrace(db, target.traceId);
  if (!row) return null;
  const toolContext = normalizeToolContext(draft.toolContext);
  const { renderTraceTrajectory, renderUsedToolDefinitions, getTraceRetrievalContext } = await import(
    "../trace/trajectory.js"
  );
  const { scoreAgainstCriteria, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL } = await import("../evaluate/judge.js");
  const [trajectory, toolDefinitions, context] = await Promise.all([
    toolContext !== "none" ? renderTraceTrajectory(db, row.id).catch(() => null) : Promise.resolve(null),
    toolContext === "detailed" ? renderUsedToolDefinitions(db, row.id).catch(() => null) : Promise.resolve(null),
    getTraceRetrievalContext(db, row.id).catch(() => null),
  ]);
  const startedAt = Date.now();
  const { rating, justification } = await scoreAgainstCriteria(
    {
      acceptanceCriteria: draft.acceptanceCriteria ?? "",
      rejectionCriteria: draft.rejectionCriteria ?? "",
      evaluationCriteria: draft.evaluationCriteria ?? "",
      judgePrompt: (draft.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
      judgeModel: (draft.judgeModel ?? "").trim() || DEFAULT_JUDGE_MODEL,
    },
    {
      input: typeof row.input === "string" ? row.input : JSON.stringify(row.input ?? ""),
      output: typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? ""),
      context: context ?? undefined,
      trajectory: trajectory ?? undefined,
      toolDefinitions: toolDefinitions ?? undefined,
    }
  );
  return { traceId: row.id, rating, justification, latencyMs: Date.now() - startedAt };
}
