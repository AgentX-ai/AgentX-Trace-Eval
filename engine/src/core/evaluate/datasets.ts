import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Mirrors the wire payload AgentX-Python's DatasetBuilder.publish() sends (see
// agentx/evaluations/datasets.py) and the Dataset pydantic model's field aliases it expects back
// (agentx/evaluations/models.py). Sovereignty & Portability model comparison is accepted but not
// acted on: out of scope for this pass, see plan task #109.
export type SimilarityConfig = {
  vectorSimilarity?: { enabled: boolean; model?: string };
  jaccardSimilarity?: { enabled: boolean };
  bleuScore?: { enabled: boolean };
  rougeScore?: { enabled: boolean };
};

// Both routes/evaluations.ts (SDK) and routes/evaluateDashboard.ts (dashboard) accept this same
// shape on dataset/evaluation-settings create+update bodies — one extraction helper instead of
// repeating the same four-field pull at every call site (a field missed at one of them is exactly
// how numberOfRequests went unpersisted on the SDK route for a full session before being caught).
export function extractSimilarityConfig(body: Record<string, unknown>): SimilarityConfig | undefined {
  const config: SimilarityConfig = {};
  if (body.vectorSimilarity && typeof body.vectorSimilarity === "object") {
    const vs = body.vectorSimilarity as { enabled?: unknown; model?: unknown };
    if (vs.enabled === true) {
      config.vectorSimilarity = { enabled: true, model: typeof vs.model === "string" ? vs.model : undefined };
    }
  }
  if (body.jaccardSimilarity && typeof body.jaccardSimilarity === "object" && (body.jaccardSimilarity as { enabled?: unknown }).enabled === true) {
    config.jaccardSimilarity = { enabled: true };
  }
  if (body.bleuScore && typeof body.bleuScore === "object" && (body.bleuScore as { enabled?: unknown }).enabled === true) {
    config.bleuScore = { enabled: true };
  }
  if (body.rougeScore && typeof body.rougeScore === "object" && (body.rougeScore as { enabled?: unknown }).enabled === true) {
    config.rougeScore = { enabled: true };
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

export type CreateDatasetInput = {
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
  questions: unknown[];
};

export type UpdateDatasetInput = Omit<CreateDatasetInput, "id">;

export type DatasetRow = {
  id: string;
  name: string;
  description: string | null;
  numberOfRequests: number;
  similarityConfig: unknown;
  acceptanceCriteria: string | null;
  rejectionCriteria: string | null;
  evaluationCriteria: string | null;
  questions: unknown;
  createdAt: Date;
};

function toWire(row: DatasetRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    numberOfRequests: row.numberOfRequests,
    ...((row.similarityConfig as SimilarityConfig | null) ?? {}),
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    rejectionCriteria: row.rejectionCriteria ?? undefined,
    evaluationCriteria: row.evaluationCriteria ?? undefined,
    questions: row.questions,
    status: "published",
    createdAt: row.createdAt,
  };
}

export async function createDataset(db: Db, input: CreateDatasetInput) {
  const row: DatasetRow = {
    id: input.id ?? nanoid(),
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    questions: input.questions,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.datasets).values(row);
  } else {
    await db.db.insert(db.schema.datasets).values(row);
  }
  return toWire(row);
}

// Dashboard edits always submit the full form, so this is a full replace, not a sparse patch
// (same convention as agentMonitoringDashboard.ts's updatePattern). Returns null if the id
// doesn't exist, same as getDataset.
export async function updateDataset(
  db: Db,
  id: string,
  input: UpdateDatasetInput,
) {
  const values = {
    name: input.name,
    description: input.description ?? null,
    numberOfRequests: input.numberOfRequests ?? 1,
    similarityConfig: input.similarityConfig ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    questions: input.questions,
  };
  if (db.kind === "sqlite") {
    await db.db
      .update(db.schema.datasets)
      .set(values)
      .where(eq(db.schema.datasets.id, id));
  } else {
    await db.db
      .update(db.schema.datasets)
      .set(values)
      .where(eq(db.schema.datasets.id, id));
  }
  return getDataset(db, id);
}

export async function getDataset(db: Db, id: string) {
  let row: DatasetRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db
      .select()
      .from(db.schema.datasets)
      .where(eq(db.schema.datasets.id, id))
      .all()[0] as DatasetRow | undefined;
  } else {
    row = (
      await db.db
        .select()
        .from(db.schema.datasets)
        .where(eq(db.schema.datasets.id, id))
    )[0] as DatasetRow | undefined;
  }
  return row ? toWire(row) : null;
}

export async function listDatasets(db: Db) {
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.datasets).all()
      : await db.db.select().from(db.schema.datasets);
  return (rows as DatasetRow[])
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toWire);
}
