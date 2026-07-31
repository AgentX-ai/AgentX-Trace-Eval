import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getEvaluationSettingsRow, type EvaluationSettingsRow } from "./evaluationSettings.js";
import { callJudgeJson, applyJudgePromptTemplate, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL } from "./judge.js";

export const MAX_BATCH_SIZE = 10;

// Resolved grading config for one run: which criteria/judge prompt/model actually apply, and the
// dataset's questions for per-question expectedResults/judgeGuideline lookup.
//
// Deliberately simpler than the hosted SaaS here: that system resolves an SDK run's config via a
// "twin" EvaluationSettings document sharing the dataset's own id (see
// AgentX-web-api/src/routes/api_v1/customAgentEvaluations.ts's `evaluationSettingsId ||
// datasetId` lookup and helpers/datasetHelper.ts's resolveDatasetSettings), a hosted-SaaS-specific
// indirection. Self-host's `datasets` table already stores its own criteria directly, so a bare
// dataset (no evaluationSettingsId passed to init_run) just uses its own fields, no twin needed.
type ResolvedRunConfig = {
  acceptanceCriteria: string;
  rejectionCriteria: string;
  evaluationCriteria: string;
  judgePrompt: string;
  judgeModel: string;
  questions: Array<{ main_question?: { query?: string; expectedResults?: string; judgeGuideline?: string } }>;
};

async function resolveRunConfig(
  db: Db,
  datasetId: string,
  evaluationSettingsId: string | null
): Promise<ResolvedRunConfig> {
  const datasetRow = await getDatasetRow(db, datasetId);
  const questions = (datasetRow?.questions as ResolvedRunConfig["questions"] | undefined) ?? [];

  let settings: EvaluationSettingsRow | null = null;
  if (evaluationSettingsId) {
    settings = await getEvaluationSettingsRow(db, evaluationSettingsId);
  }

  const source = settings ?? datasetRow;
  return {
    acceptanceCriteria: source?.acceptanceCriteria ?? "",
    rejectionCriteria: source?.rejectionCriteria ?? "",
    evaluationCriteria: source?.evaluationCriteria ?? "",
    judgePrompt: (settings?.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
    judgeModel: settings?.judgeModel ?? DEFAULT_JUDGE_MODEL,
    questions,
  };
}

async function getDatasetRow(db: Db, id: string) {
  type Row = { id: string; acceptanceCriteria: string | null; rejectionCriteria: string | null; evaluationCriteria: string | null; questions: unknown };
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)))[0] as Row | undefined;
}

// ---------------------------------------------------------------------------
// init_run
// ---------------------------------------------------------------------------

export async function initRun(
  db: Db,
  input: {
    datasetId: string;
    evaluationSettingsId?: string;
    evaluationSubject?: unknown;
    runSource?: string;
    sdk?: unknown;
  }
) {
  const dataset = await getDatasetRow(db, input.datasetId);
  if (!dataset) {
    return null;
  }
  const id = nanoid();
  const runRow = {
    id,
    datasetId: input.datasetId,
    evaluationSettingsId: input.evaluationSettingsId ?? null,
    evaluationSubject: input.evaluationSubject ?? null,
    runSource: input.runSource ?? "sdk",
    sdkInfo: input.sdk ?? null,
    status: "in_progress",
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationRuns).values(runRow);
  } else {
    await db.db.insert(db.schema.evaluationRuns).values(runRow);
  }
  return {
    runId: id,
    datasetId: input.datasetId,
    status: "in_progress",
  };
}

// ---------------------------------------------------------------------------
// append_results: synchronous judge scoring, ported from
// AgentX-web-api/src/services/evaluationScoringService.ts's scoreResult.
// ---------------------------------------------------------------------------

const scoreSchema = {
  type: "object",
  properties: {
    rating: { type: "number", description: "Rating from 0-10" },
    justification: { type: "string", description: "Detailed explanation" },
  },
  required: ["rating", "justification"],
};

type SubmittedResult = {
  caseId?: string;
  questionIndex?: number;
  runNumber?: number;
  idempotencyKey: string;
  input?: { query?: string };
  output?: { text?: string };
  error?: { type: string; message: string };
};

async function scoreOneResult(config: ResolvedRunConfig, item: SubmittedResult): Promise<{ rating: number; justification: string }> {
  const question = item.questionIndex != null ? config.questions[item.questionIndex] : undefined;
  const mainQ = question?.main_question;
  const expectedResults = mainQ?.expectedResults;
  const judgeGuideline = mainQ?.judgeGuideline;

  const substitutedPrompt = applyJudgePromptTemplate(config.judgePrompt, {
    input: item.input?.query || "",
    output: item.output?.text || "",
    expected: expectedResults || "N/A",
  });

  const additionalContext = `
${judgeGuideline ? `**Judge Guideline (specific to this question):** ${judgeGuideline}` : ""}
${config.acceptanceCriteria ? `**Acceptance Criteria:** ${config.acceptanceCriteria}` : ""}
${config.rejectionCriteria ? `**Rejection Criteria:** ${config.rejectionCriteria}` : ""}
${config.evaluationCriteria ? `**Evaluation Criteria:** ${config.evaluationCriteria}` : ""}
`;

  const judgeResult = await callJudgeJson({
    model: config.judgeModel,
    jsonSchema: scoreSchema,
    userMessage: `${substitutedPrompt}\n${additionalContext}`,
  });
  const payload = judgeResult.payload as { rating: number; justification: string } | null;
  if (!payload) {
    return { rating: 0, justification: "Scoring failed: no result returned from the judge model" };
  }
  return { rating: payload.rating, justification: payload.justification };
}

export async function appendResults(
  db: Db,
  runId: string,
  batchId: string,
  results: SubmittedResult[]
) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  if (run.status === "completed" || run.status === "failed") {
    throw new Error("Run is already in a terminal state");
  }

  const config = await resolveRunConfig(db, run.datasetId, run.evaluationSettingsId);

  let accepted = 0;
  let duplicates = 0;
  let failedValidation = 0;
  const scoredResults: { idempotencyKey: string; rating: number | null; justification: string | null }[] = [];

  for (const item of results) {
    if (!item.idempotencyKey || (!item.output?.text && !item.error)) {
      failedValidation++;
      continue;
    }

    const existing = await getExistingResult(db, runId, item.idempotencyKey);
    if (existing) {
      duplicates++;
      scoredResults.push({ idempotencyKey: item.idempotencyKey, rating: existing.rating, justification: existing.justification });
      continue;
    }

    let rating: number | null = null;
    let justification: string | null = null;
    let status: "scored" | "failed" | "skipped" = "scored";

    if (item.error) {
      status = "failed";
      rating = 0;
      justification = `Case failed with error: ${item.error.type}: ${item.error.message}`;
    } else {
      try {
        const scored = await scoreOneResult(config, item);
        rating = scored.rating;
        justification = scored.justification;
      } catch (err) {
        status = "skipped";
        justification = err instanceof Error ? err.message : "Scoring failed";
        // Judge call failures (bad/missing API key, provider outage) previously left no trace
        // anywhere except this one result's justification field, effectively invisible unless a
        // caller went looking at the exact result row. Surfacing it here at least gets it into
        // agentx-server's own logs.
        console.error(`Evaluate: scoring failed for run ${runId} (${item.idempotencyKey}):`, err);
      }
    }

    const resultRow = {
      id: nanoid(),
      runId,
      batchId,
      idempotencyKey: item.idempotencyKey,
      caseId: item.caseId ?? `case-${item.questionIndex ?? 0}`,
      questionIndex: item.questionIndex ?? 0,
      runNumber: item.runNumber ?? 1,
      input: item.input ?? null,
      output: item.output ?? null,
      error: item.error ?? null,
      rating,
      justification,
      status,
      createdAt: new Date(),
    };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.evaluationRunResults).values(resultRow);
    } else {
      await db.db.insert(db.schema.evaluationRunResults).values(resultRow);
    }

    accepted++;
    scoredResults.push({ idempotencyKey: item.idempotencyKey, rating, justification });
  }

  return {
    runId,
    batchId,
    accepted,
    duplicates,
    failedValidation,
    status: run.status,
    scoredResults,
  };
}

async function getExistingResult(db: Db, runId: string, idempotencyKey: string) {
  type Row = { rating: number | null; justification: string | null };
  const cond = and(
    eq(db.schema.evaluationRunResults.runId, runId),
    eq(db.schema.evaluationRunResults.idempotencyKey, idempotencyKey)
  );
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.evaluationRunResults).where(cond).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.evaluationRunResults).where(cond))[0] as Row | undefined;
}

// ---------------------------------------------------------------------------
// finalize / get
// ---------------------------------------------------------------------------

async function getRunRow(db: Db, id: string) {
  type Row = { id: string; datasetId: string; evaluationSettingsId: string | null; status: string };
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.evaluationRuns).where(eq(db.schema.evaluationRuns.id, id)).all()[0] as
      | Row
      | undefined;
  }
  return (await db.db.select().from(db.schema.evaluationRuns).where(eq(db.schema.evaluationRuns.id, id)))[0] as
    | Row
    | undefined;
}

export async function finalizeRun(db: Db, runId: string) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationRuns).set({ status: "completed" }).where(eq(db.schema.evaluationRuns.id, runId));
  } else {
    await db.db.update(db.schema.evaluationRuns).set({ status: "completed" }).where(eq(db.schema.evaluationRuns.id, runId));
  }
  return { runId, status: "completed" };
}

export async function getRun(db: Db, runId: string) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  const cond = eq(db.schema.evaluationRunResults.runId, runId);
  const results =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRunResults).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRunResults).where(cond);

  const rated = (results as { rating: number | null }[]).filter(r => r.rating != null).map(r => r.rating as number);
  const averageRating = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;

  return {
    runId: run.id,
    datasetId: run.datasetId,
    evaluationSettingsId: run.evaluationSettingsId,
    status: run.status,
    resultCount: results.length,
    averageRating,
  };
}

// Not part of the SDK-compatible surface (AgentX-Python has no list_runs() call), added for the
// web dashboard's Evaluate tab (plan task #112).
export async function listRuns(db: Db, limit = 50) {
  type Row = { id: string; datasetId: string; evaluationSettingsId: string | null; status: string; createdAt: Date };
  const rows = (
    db.kind === "sqlite" ? db.db.select().from(db.schema.evaluationRuns).all() : await db.db.select().from(db.schema.evaluationRuns)
  ) as Row[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return Promise.all(
    rows.slice(0, limit).map(async row => {
      const summary = await getRun(db, row.id);
      return summary ?? { runId: row.id, datasetId: row.datasetId, status: row.status, resultCount: 0, averageRating: null };
    })
  );
}
