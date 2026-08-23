import { nanoid } from "nanoid";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { SimilarityConfig } from "./datasets.js";
import type { CodeScorerConfig } from "./codeScorer.js";
import { recordEvaluationSettingsVersionIfChanged } from "./versions.js";

export type { SimilarityConfig };

// Mirrors AgentX-Python's EvaluationSettingsBuilder.publish() payload and the EvaluationSettings
// pydantic model's field aliases (agentx/evaluations/evaluation_settings.py, models.py). A
// standalone, reusable grading config: no questions attached, referenced by id from init_run.
export type CreateEvaluationSettingsInput = {
  // Set by routes/evaluateDashboard.ts to create a dataset+evaluationSettings twin sharing one id
  // (see that file's header comment). Omitted (SDK path via routes/evaluations.ts): a fresh id is
  // generated here as before.
  id?: string;
  name: string;
  description?: string;
  numberOfRequests?: number;
  similarityConfig?: SimilarityConfig;
  codeScorers?: CodeScorerConfig[];
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
  // Only meaningful for a standalone config - see the isDefault comment on the schema column.
  isDefault?: boolean;
  status?: string;
  // Opt-in: append the tool-registry catalog to this judge's prompt (see the schema column).
  includeToolCatalog?: boolean;
};

export type UpdateEvaluationSettingsInput = Omit<CreateEvaluationSettingsInput, "id">;

export type EvaluationSettingsRow = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  numberOfRequests: number;
  similarityConfig: unknown;
  codeScorers: unknown;
  acceptanceCriteria: string | null;
  rejectionCriteria: string | null;
  evaluationCriteria: string | null;
  judgePrompt: string | null;
  judgeModel: string | null;
  isDefault: boolean;
  status: string;
  includeToolCatalog: boolean;
  createdAt: Date;
};

function toWire(row: EvaluationSettingsRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    numberOfRequests: row.numberOfRequests,
    ...((row.similarityConfig as SimilarityConfig | null) ?? {}),
    codeScorers: (row.codeScorers as CodeScorerConfig[] | null) ?? undefined,
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    rejectionCriteria: row.rejectionCriteria ?? undefined,
    evaluationCriteria: row.evaluationCriteria ?? undefined,
    judgePrompt: row.judgePrompt ?? undefined,
    judgeModel: row.judgeModel ?? undefined,
    isDefault: row.isDefault,
    status: row.status,
    includeToolCatalog: row.includeToolCatalog,
    createdAt: row.createdAt,
  };
}

// At most one standalone config is "default" at a time (EvaluationConfigSelector preselects it) -
// clear any existing default before a create/update sets a new one, mirroring the hosted SaaS's
// single-default invariant.
async function clearDefaultEvaluationSettings(db: Db, exceptId?: string): Promise<void> {
  const cond = exceptId
    ? and(
        eq(db.schema.evaluationSettings.isDefault, true),
        ne(db.schema.evaluationSettings.id, exceptId),
        eq(db.schema.evaluationSettings.projectId, db.projectId)
      )
    : and(eq(db.schema.evaluationSettings.isDefault, true), eq(db.schema.evaluationSettings.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set({ isDefault: false }).where(cond);
  } else {
    await db.db.update(db.schema.evaluationSettings).set({ isDefault: false }).where(cond);
  }
}

export async function createEvaluationSettings(db: Db, input: CreateEvaluationSettingsInput) {
  const row: EvaluationSettingsRow = {
    id: input.id ?? nanoid(),
    projectId: db.projectId,
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    codeScorers: input.codeScorers ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    judgePrompt: input.judgePrompt ?? null,
    judgeModel: input.judgeModel ?? null,
    isDefault: input.isDefault ?? false,
    status: input.status ?? "published",
    includeToolCatalog: input.includeToolCatalog ?? false,
    createdAt: new Date(),
  };
  if (row.isDefault) {
    await clearDefaultEvaluationSettings(db);
  }
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationSettings).values(row);
  } else {
    await db.db.insert(db.schema.evaluationSettings).values(row);
  }
  const wire = toWire(row);
  await recordEvaluationSettingsVersionIfChanged(db, row.id, null, wire);
  return wire;
}

// Full replace, same convention as updateDataset. Silently no-ops if the id doesn't exist (a
// dashboard-created dataset's evaluationSettings twin should always exist by the time an edit can
// happen, but this isn't assumed) - getMergedEvaluationSettings in evaluateDashboard.ts falls back
// to the dataset's own criteria when the twin is missing, same as resolveRunConfig does at run time.
export async function updateEvaluationSettings(db: Db, id: string, input: UpdateEvaluationSettingsInput) {
  const before = await getEvaluationSettings(db, id);
  const values = {
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    codeScorers: input.codeScorers ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    judgePrompt: input.judgePrompt ?? null,
    judgeModel: input.judgeModel ?? null,
    includeToolCatalog: input.includeToolCatalog ?? false,
  };
  const updateCond = and(eq(db.schema.evaluationSettings.id, id), eq(db.schema.evaluationSettings.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set(values).where(updateCond);
  } else {
    await db.db.update(db.schema.evaluationSettings).set(values).where(updateCond);
  }
  const after = await getEvaluationSettings(db, id);
  if (after) {
    await recordEvaluationSettingsVersionIfChanged(db, id, before, after);
  }
  return after;
}

// Sparse patch, unlike updateEvaluationSettings's full replace - used by the standalone-config PUT
// path (routes/evaluateDashboard.ts), whose callers can send a partial payload (e.g.
// EvaluationConfigsTab.tsx's "Make default" action sends only `{ isDefault: true }`). A full
// replace would null out every other field on a payload like that; merging onto the existing row
// keeps whatever wasn't sent untouched, same pattern as core/monitor/signals.ts's updateSignal.
export async function patchEvaluationSettings(db: Db, id: string, patch: Partial<UpdateEvaluationSettingsInput>) {
  const existing = await getEvaluationSettingsRow(db, id);
  if (!existing) {
    return null;
  }
  const before = toWire(existing);
  if (patch.isDefault) {
    await clearDefaultEvaluationSettings(db, id);
  }
  const values = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    numberOfRequests: patch.numberOfRequests ?? existing.numberOfRequests,
    similarityConfig: patch.similarityConfig ?? existing.similarityConfig,
    codeScorers: patch.codeScorers ?? existing.codeScorers,
    acceptanceCriteria: patch.acceptanceCriteria ?? existing.acceptanceCriteria,
    rejectionCriteria: patch.rejectionCriteria ?? existing.rejectionCriteria,
    evaluationCriteria: patch.evaluationCriteria ?? existing.evaluationCriteria,
    judgePrompt: patch.judgePrompt ?? existing.judgePrompt,
    judgeModel: patch.judgeModel ?? existing.judgeModel,
    isDefault: patch.isDefault ?? existing.isDefault,
    status: patch.status ?? existing.status,
    includeToolCatalog: patch.includeToolCatalog ?? existing.includeToolCatalog,
  };
  const patchCond = and(eq(db.schema.evaluationSettings.id, id), eq(db.schema.evaluationSettings.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set(values).where(patchCond);
  } else {
    await db.db.update(db.schema.evaluationSettings).set(values).where(patchCond);
  }
  const after = await getEvaluationSettings(db, id);
  if (after) {
    await recordEvaluationSettingsVersionIfChanged(db, id, before, after);
  }
  return after;
}

// Copies a config's full rubric + offline profile into a fresh row (new id, isDefault cleared,
// empty version history - the next edit seeds one). Exists for the LLM Judge Scorer 1:1
// invariant (core/monitor/judgeScorers.ts): a legacy create/update that would bind an online
// profile to an already-bound or dataset-twin config gets its own copy instead of sharing -
// the shared-rubric ambiguity ("which of my three evaluators does editing this config change?")
// is exactly what the unification removes. Returns the clone's id, or null if the source is gone.
export async function cloneEvaluationSettings(db: Db, id: string): Promise<string | null> {
  const existing = await getEvaluationSettingsRow(db, id);
  if (!existing) {
    return null;
  }
  const clone: EvaluationSettingsRow = {
    ...existing,
    id: nanoid(),
    isDefault: false,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationSettings).values(clone);
  } else {
    await db.db.insert(db.schema.evaluationSettings).values(clone);
  }
  return clone.id;
}

// True when this settings id doubles as a dataset's grading twin (both share one id - see
// routes/evaluateDashboard.ts's header comment). Twins are dataset internals, not standalone
// judge scorers: the unified surface 404s them and online profiles must never bind to one.
export async function isDatasetTwinSettingsId(db: Db, id: string): Promise<boolean> {
  const cond = and(eq(db.schema.datasets.id, id), eq(db.schema.datasets.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets).where(cond).all()
      : await db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets).where(cond);
  return rows.length > 0;
}

export async function getEvaluationSettingsRow(db: Db, id: string): Promise<EvaluationSettingsRow | null> {
  const cond = and(eq(db.schema.evaluationSettings.id, id), eq(db.schema.evaluationSettings.projectId, db.projectId));
  let row: EvaluationSettingsRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.evaluationSettings).where(cond).all()[0] as EvaluationSettingsRow | undefined;
  } else {
    row = (await db.db.select().from(db.schema.evaluationSettings).where(cond))[0] as EvaluationSettingsRow | undefined;
  }
  return row ?? null;
}

export async function getEvaluationSettings(db: Db, id: string) {
  const row = await getEvaluationSettingsRow(db, id);
  return row ? toWire(row) : null;
}

export async function listEvaluationSettings(db: Db) {
  const cond = eq(db.schema.evaluationSettings.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationSettings).where(cond).all()
      : await db.db.select().from(db.schema.evaluationSettings).where(cond);
  return (rows as EvaluationSettingsRow[]).map(toWire);
}

// Rows in evaluation_settings with no matching id in datasets - the standalone "Evaluator" configs
// (EvaluationConfigsTab.tsx), as opposed to a dataset+settings twin created via the dashboard's
// "New dataset" flow (both share one id, see routes/evaluateDashboard.ts's header comment).
// Filtered in JS rather than a NOT IN subquery: self-host's local scale doesn't need it, and it
// keeps this dialect-agnostic without leaning on drizzle's subquery typing across sqlite/pg.
export async function listStandaloneEvaluationSettings(db: Db) {
  const settingsCond = eq(db.schema.evaluationSettings.projectId, db.projectId);
  const datasetsCond = eq(db.schema.datasets.projectId, db.projectId);
  const [allRows, datasetIdRows] =
    db.kind === "sqlite"
      ? [
          db.db.select().from(db.schema.evaluationSettings).where(settingsCond).all() as EvaluationSettingsRow[],
          db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets).where(datasetsCond).all(),
        ]
      : await Promise.all([
          db.db.select().from(db.schema.evaluationSettings).where(settingsCond) as Promise<EvaluationSettingsRow[]>,
          db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets).where(datasetsCond),
        ]);
  const datasetIds = new Set(datasetIdRows.map(r => r.id));
  return allRows
    .filter(row => !datasetIds.has(row.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toWire);
}
