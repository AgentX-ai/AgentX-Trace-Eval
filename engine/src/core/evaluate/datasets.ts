import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Mirrors the wire payload AgentX-Python's DatasetBuilder.publish() sends (see
// agentx/evaluations/datasets.py) and the Dataset pydantic model's field aliases it expects back
// (agentx/evaluations/models.py). Similarity metrics (vectorSimilarity/jaccard/bleu/rouge) and
// Sovereignty & Portability model comparison are accepted but not acted on: out of scope for this
// pass, see plan task #109.
export type CreateDatasetInput = {
  name: string;
  description?: string;
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  questions: unknown[];
};

export type DatasetRow = {
  id: string;
  name: string;
  description: string | null;
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
    numberOfRequests: 1,
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    rejectionCriteria: row.rejectionCriteria ?? undefined,
    evaluationCriteria: row.evaluationCriteria ?? undefined,
    questions: row.questions,
    status: "published",
  };
}

export async function createDataset(db: Db, input: CreateDatasetInput) {
  const row: DatasetRow = {
    id: nanoid(),
    name: input.name,
    description: input.description ?? null,
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

export async function getDataset(db: Db, id: string) {
  let row: DatasetRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)).all()[0] as
      | DatasetRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)))[0] as
      | DatasetRow
      | undefined;
  }
  return row ? toWire(row) : null;
}

export async function listDatasets(db: Db) {
  const rows =
    db.kind === "sqlite" ? db.db.select().from(db.schema.datasets).all() : await db.db.select().from(db.schema.datasets);
  return (rows as DatasetRow[]).map(toWire);
}
