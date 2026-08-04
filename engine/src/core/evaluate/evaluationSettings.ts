import { nanoid } from "nanoid";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { SimilarityConfig } from "./datasets.js";

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
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
  // Only meaningful for a standalone config — see the isDefault comment on the schema column.
  isDefault?: boolean;
  status?: string;
};

export type UpdateEvaluationSettingsInput = Omit<CreateEvaluationSettingsInput, "id">;

export type EvaluationSettingsRow = {
  id: string;
  name: string;
  description: string | null;
  numberOfRequests: number;
  similarityConfig: unknown;
  acceptanceCriteria: string | null;
  rejectionCriteria: string | null;
  evaluationCriteria: string | null;
  judgePrompt: string | null;
  judgeModel: string | null;
  isDefault: boolean;
  status: string;
  createdAt: Date;
};

function toWire(row: EvaluationSettingsRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    numberOfRequests: row.numberOfRequests,
    ...((row.similarityConfig as SimilarityConfig | null) ?? {}),
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    rejectionCriteria: row.rejectionCriteria ?? undefined,
    evaluationCriteria: row.evaluationCriteria ?? undefined,
    judgePrompt: row.judgePrompt ?? undefined,
    judgeModel: row.judgeModel ?? undefined,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt,
  };
}

// At most one standalone config is "default" at a time (EvaluationConfigSelector preselects it) —
// clear any existing default before a create/update sets a new one, mirroring the hosted SaaS's
// single-default invariant.
async function clearDefaultEvaluationSettings(db: Db, exceptId?: string): Promise<void> {
  const cond = exceptId
    ? and(eq(db.schema.evaluationSettings.isDefault, true), ne(db.schema.evaluationSettings.id, exceptId))
    : eq(db.schema.evaluationSettings.isDefault, true);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set({ isDefault: false }).where(cond);
  } else {
    await db.db.update(db.schema.evaluationSettings).set({ isDefault: false }).where(cond);
  }
}

export async function createEvaluationSettings(db: Db, input: CreateEvaluationSettingsInput) {
  const row: EvaluationSettingsRow = {
    id: input.id ?? nanoid(),
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    judgePrompt: input.judgePrompt ?? null,
    judgeModel: input.judgeModel ?? null,
    isDefault: input.isDefault ?? false,
    status: input.status ?? "published",
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
  return toWire(row);
}

// Full replace, same convention as updateDataset. Silently no-ops if the id doesn't exist (a
// dashboard-created dataset's evaluationSettings twin should always exist by the time an edit can
// happen, but this isn't assumed) — getMergedEvaluationSettings in evaluateDashboard.ts falls back
// to the dataset's own criteria when the twin is missing, same as resolveRunConfig does at run time.
export async function updateEvaluationSettings(db: Db, id: string, input: UpdateEvaluationSettingsInput) {
  const values = {
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    judgePrompt: input.judgePrompt ?? null,
    judgeModel: input.judgeModel ?? null,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set(values).where(eq(db.schema.evaluationSettings.id, id));
  } else {
    await db.db.update(db.schema.evaluationSettings).set(values).where(eq(db.schema.evaluationSettings.id, id));
  }
  return getEvaluationSettings(db, id);
}

// Sparse patch, unlike updateEvaluationSettings's full replace — used by the standalone-config PUT
// path (routes/evaluateDashboard.ts), whose callers can send a partial payload (e.g.
// EvaluationConfigsTab.tsx's "Make default" action sends only `{ isDefault: true }`). A full
// replace would null out every other field on a payload like that; merging onto the existing row
// keeps whatever wasn't sent untouched, same pattern as core/monitor/signals.ts's updateSignal.
export async function patchEvaluationSettings(db: Db, id: string, patch: Partial<UpdateEvaluationSettingsInput>) {
  const existing = await getEvaluationSettingsRow(db, id);
  if (!existing) {
    return null;
  }
  if (patch.isDefault) {
    await clearDefaultEvaluationSettings(db, id);
  }
  const values = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    numberOfRequests: patch.numberOfRequests ?? existing.numberOfRequests,
    similarityConfig: patch.similarityConfig ?? existing.similarityConfig,
    acceptanceCriteria: patch.acceptanceCriteria ?? existing.acceptanceCriteria,
    rejectionCriteria: patch.rejectionCriteria ?? existing.rejectionCriteria,
    evaluationCriteria: patch.evaluationCriteria ?? existing.evaluationCriteria,
    judgePrompt: patch.judgePrompt ?? existing.judgePrompt,
    judgeModel: patch.judgeModel ?? existing.judgeModel,
    isDefault: patch.isDefault ?? existing.isDefault,
    status: patch.status ?? existing.status,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationSettings).set(values).where(eq(db.schema.evaluationSettings.id, id));
  } else {
    await db.db.update(db.schema.evaluationSettings).set(values).where(eq(db.schema.evaluationSettings.id, id));
  }
  return getEvaluationSettings(db, id);
}

export async function getEvaluationSettingsRow(db: Db, id: string): Promise<EvaluationSettingsRow | null> {
  let row: EvaluationSettingsRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.evaluationSettings).where(eq(db.schema.evaluationSettings.id, id)).all()[0] as
      | EvaluationSettingsRow
      | undefined;
  } else {
    row = (
      await db.db.select().from(db.schema.evaluationSettings).where(eq(db.schema.evaluationSettings.id, id))
    )[0] as EvaluationSettingsRow | undefined;
  }
  return row ?? null;
}

export async function getEvaluationSettings(db: Db, id: string) {
  const row = await getEvaluationSettingsRow(db, id);
  return row ? toWire(row) : null;
}

export async function listEvaluationSettings(db: Db) {
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationSettings).all()
      : await db.db.select().from(db.schema.evaluationSettings);
  return (rows as EvaluationSettingsRow[]).map(toWire);
}

// Rows in evaluation_settings with no matching id in datasets — the standalone "Evaluator" configs
// (EvaluationConfigsTab.tsx), as opposed to a dataset+settings twin created via the dashboard's
// "New dataset" flow (both share one id, see routes/evaluateDashboard.ts's header comment).
// Filtered in JS rather than a NOT IN subquery: self-host's local scale doesn't need it, and it
// keeps this dialect-agnostic without leaning on drizzle's subquery typing across sqlite/pg.
export async function listStandaloneEvaluationSettings(db: Db) {
  const [allRows, datasetIdRows] =
    db.kind === "sqlite"
      ? [
          db.db.select().from(db.schema.evaluationSettings).all() as EvaluationSettingsRow[],
          db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets).all(),
        ]
      : await Promise.all([
          db.db.select().from(db.schema.evaluationSettings) as Promise<EvaluationSettingsRow[]>,
          db.db.select({ id: db.schema.datasets.id }).from(db.schema.datasets),
        ]);
  const datasetIds = new Set(datasetIdRows.map(r => r.id));
  return allRows
    .filter(row => !datasetIds.has(row.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toWire);
}
