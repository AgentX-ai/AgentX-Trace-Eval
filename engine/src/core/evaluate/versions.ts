import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Wire shape returned to the dashboard — matches AgentX-web-front's VersionEntry<TSnapshot>
// (EvaluationSettingsVersionHistoryItem.tsx), minus `creator`: self-host has only the one
// synthetic LOCAL_USER, added at the route layer (routes/evaluateDashboard.ts) rather than stored
// per-row, same convention every other wire response here already follows.
export type VersionEntryWire = {
  _id: string;
  snapshot: Record<string, unknown>;
  createdAt: Date;
  changeSummary?: string;
};

const DATASET_SNAPSHOT_FIELDS = ["name", "description", "questions", "status"] as const;
const DATASET_FIELD_LABELS: Record<string, string> = {
  name: "name",
  description: "description",
  questions: "questions",
  status: "status",
};

// Mirrors AgentX-web-front's EvaluationSettingsVersionSnapshot exactly (including codeScorers,
// which that type didn't previously capture — see this plan's context: dropping custom code
// scorers on restore would itself be a bug now that restoring is real). thresholds/isDefault are
// deliberately excluded, same as the frontend type's own documented exclusions.
const SETTINGS_SNAPSHOT_FIELDS = [
  "name",
  "description",
  "numberOfRequests",
  "acceptanceCriteria",
  "rejectionCriteria",
  "evaluationCriteria",
  "judgePrompt",
  "judgeModel",
  "vectorSimilarity",
  "jaccardSimilarity",
  "bleuScore",
  "rougeScore",
  "codeScorers",
  "sovereigntyIndex",
  "status",
] as const;
const SETTINGS_FIELD_LABELS: Record<string, string> = {
  name: "name",
  description: "description",
  numberOfRequests: "number of requests",
  acceptanceCriteria: "acceptance criteria",
  rejectionCriteria: "rejection criteria",
  evaluationCriteria: "evaluation criteria",
  judgePrompt: "judge prompt",
  judgeModel: "judge model",
  vectorSimilarity: "vector similarity",
  jaccardSimilarity: "jaccard similarity",
  bleuScore: "BLEU score",
  rougeScore: "ROUGE score",
  codeScorers: "code scorers",
  sovereigntyIndex: "sovereignty index",
  status: "status",
};

function pick(obj: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = obj[field];
  }
  return out;
}

// null `before` (nothing to diff against — a fresh create) always yields "Created". Otherwise a
// plain list of which tracked fields changed ("Updated acceptance criteria, judge model"), or null
// if nothing tracked actually changed — a no-op save (dialog opened and saved untouched) shouldn't
// spam version history. Deliberately a synchronous computed diff, not an LLM call: the hosted SaaS
// generates this asynchronously (the frontend's version-history panel polls up to 30s waiting for
// it to appear), but self-host doesn't need that cost/latency for a plain field-level diff — it's
// already present on the very first fetch, so the same poll-until-present logic just resolves
// immediately instead of waiting.
function buildChangeSummary(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  fields: readonly string[],
  labels: Record<string, string>
): string | null {
  if (!before) {
    return "Created";
  }
  const changed = fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  if (changed.length === 0) {
    return null;
  }
  return `Updated ${changed.map(field => labels[field] ?? field).join(", ")}`;
}

type VersionRow = { id: string; snapshot: unknown; changeSummary: string | null; createdAt: Date };

function toWireEntry(row: VersionRow): VersionEntryWire {
  return {
    _id: row.id,
    snapshot: row.snapshot as Record<string, unknown>,
    changeSummary: row.changeSummary ?? undefined,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Dataset (questions-only) version log — before/after are the toWire()-shaped objects
// core/evaluate/datasets.ts's getDataset already returns, picked down to DATASET_SNAPSHOT_FIELDS.
// ---------------------------------------------------------------------------

export async function recordDatasetVersionIfChanged(
  db: Db,
  datasetId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): Promise<void> {
  const changeSummary = buildChangeSummary(before, after, DATASET_SNAPSHOT_FIELDS, DATASET_FIELD_LABELS);
  if (!changeSummary) {
    return;
  }
  const row = {
    id: nanoid(),
    projectId: db.projectId,
    datasetId,
    snapshot: pick(after, DATASET_SNAPSHOT_FIELDS),
    changeSummary,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.datasetVersions).values(row);
  } else {
    await db.db.insert(db.schema.datasetVersions).values(row);
  }
}

export async function listDatasetVersions(db: Db, datasetId: string): Promise<VersionEntryWire[]> {
  const cond = and(eq(db.schema.datasetVersions.datasetId, datasetId), eq(db.schema.datasetVersions.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.datasetVersions).where(cond).all()
      : await db.db.select().from(db.schema.datasetVersions).where(cond)
  ) as VersionRow[];
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toWireEntry);
}

export async function getDatasetVersionCounts(db: Db, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) {
    return {};
  }
  const cond = and(inArray(db.schema.datasetVersions.datasetId, ids), eq(db.schema.datasetVersions.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select({ datasetId: db.schema.datasetVersions.datasetId })
          .from(db.schema.datasetVersions)
          .where(cond)
          .all()
      : await db.db.select({ datasetId: db.schema.datasetVersions.datasetId }).from(db.schema.datasetVersions).where(cond)
  ) as { datasetId: string }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.datasetId] = (counts[row.datasetId] ?? 0) + 1;
  }
  return counts;
}

export async function deleteDatasetVersion(db: Db, datasetId: string, versionId: string): Promise<boolean> {
  const cond = and(
    eq(db.schema.datasetVersions.id, versionId),
    eq(db.schema.datasetVersions.datasetId, datasetId),
    eq(db.schema.datasetVersions.projectId, db.projectId)
  );
  const existing =
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.datasetVersions.id }).from(db.schema.datasetVersions).where(cond).all()[0]
      : (await db.db.select({ id: db.schema.datasetVersions.id }).from(db.schema.datasetVersions).where(cond))[0];
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.datasetVersions).where(cond);
  } else {
    await db.db.delete(db.schema.datasetVersions).where(cond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// EvaluationSettings (grading config) version log — same shape as the dataset log above, separate
// table (see schema.sqlite.ts's evaluationSettingsVersions comment). Applies equally to a
// dataset's twin config and a standalone Evaluator config (no dataset attached) — both are just
// rows in evaluationSettings.
// ---------------------------------------------------------------------------

export async function recordEvaluationSettingsVersionIfChanged(
  db: Db,
  evaluationSettingsId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): Promise<void> {
  const changeSummary = buildChangeSummary(before, after, SETTINGS_SNAPSHOT_FIELDS, SETTINGS_FIELD_LABELS);
  if (!changeSummary) {
    return;
  }
  const row = {
    id: nanoid(),
    projectId: db.projectId,
    evaluationSettingsId,
    snapshot: pick(after, SETTINGS_SNAPSHOT_FIELDS),
    changeSummary,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationSettingsVersions).values(row);
  } else {
    await db.db.insert(db.schema.evaluationSettingsVersions).values(row);
  }
}

export async function listEvaluationSettingsVersions(db: Db, evaluationSettingsId: string): Promise<VersionEntryWire[]> {
  const cond = and(
    eq(db.schema.evaluationSettingsVersions.evaluationSettingsId, evaluationSettingsId),
    eq(db.schema.evaluationSettingsVersions.projectId, db.projectId)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationSettingsVersions).where(cond).all()
      : await db.db.select().from(db.schema.evaluationSettingsVersions).where(cond)
  ) as VersionRow[];
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toWireEntry);
}

export async function getEvaluationSettingsVersionCounts(db: Db, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) {
    return {};
  }
  const cond = and(
    inArray(db.schema.evaluationSettingsVersions.evaluationSettingsId, ids),
    eq(db.schema.evaluationSettingsVersions.projectId, db.projectId)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select({ evaluationSettingsId: db.schema.evaluationSettingsVersions.evaluationSettingsId })
          .from(db.schema.evaluationSettingsVersions)
          .where(cond)
          .all()
      : await db.db
          .select({ evaluationSettingsId: db.schema.evaluationSettingsVersions.evaluationSettingsId })
          .from(db.schema.evaluationSettingsVersions)
          .where(cond)
  ) as { evaluationSettingsId: string }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.evaluationSettingsId] = (counts[row.evaluationSettingsId] ?? 0) + 1;
  }
  return counts;
}

export async function deleteEvaluationSettingsVersion(
  db: Db,
  evaluationSettingsId: string,
  versionId: string
): Promise<boolean> {
  const cond = and(
    eq(db.schema.evaluationSettingsVersions.id, versionId),
    eq(db.schema.evaluationSettingsVersions.evaluationSettingsId, evaluationSettingsId),
    eq(db.schema.evaluationSettingsVersions.projectId, db.projectId)
  );
  const existing =
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.evaluationSettingsVersions.id }).from(db.schema.evaluationSettingsVersions).where(cond).all()[0]
      : (
          await db.db
            .select({ id: db.schema.evaluationSettingsVersions.id })
            .from(db.schema.evaluationSettingsVersions)
            .where(cond)
        )[0];
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.evaluationSettingsVersions).where(cond);
  } else {
    await db.db.delete(db.schema.evaluationSettingsVersions).where(cond);
  }
  return true;
}
