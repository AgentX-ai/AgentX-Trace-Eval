import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Mirrors AgentX-Python's EvaluationSettingsBuilder.publish() payload and the EvaluationSettings
// pydantic model's field aliases (agentx/evaluations/evaluation_settings.py, models.py). A
// standalone, reusable grading config: no questions attached, referenced by id from init_run.
export type CreateEvaluationSettingsInput = {
  name: string;
  description?: string;
  acceptanceCriteria?: string;
  rejectionCriteria?: string;
  evaluationCriteria?: string;
  judgePrompt?: string;
  judgeModel?: string;
};

export type EvaluationSettingsRow = {
  id: string;
  name: string;
  description: string | null;
  acceptanceCriteria: string | null;
  rejectionCriteria: string | null;
  evaluationCriteria: string | null;
  judgePrompt: string | null;
  judgeModel: string | null;
  createdAt: Date;
};

function toWire(row: EvaluationSettingsRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    numberOfRequests: 1,
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    rejectionCriteria: row.rejectionCriteria ?? undefined,
    evaluationCriteria: row.evaluationCriteria ?? undefined,
    judgePrompt: row.judgePrompt ?? undefined,
    judgeModel: row.judgeModel ?? undefined,
    status: "published",
  };
}

export async function createEvaluationSettings(db: Db, input: CreateEvaluationSettingsInput) {
  const row: EvaluationSettingsRow = {
    id: nanoid(),
    name: input.name,
    description: input.description ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    rejectionCriteria: input.rejectionCriteria ?? null,
    evaluationCriteria: input.evaluationCriteria ?? null,
    judgePrompt: input.judgePrompt ?? null,
    judgeModel: input.judgeModel ?? null,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationSettings).values(row);
  } else {
    await db.db.insert(db.schema.evaluationSettings).values(row);
  }
  return toWire(row);
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
