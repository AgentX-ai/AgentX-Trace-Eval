import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getRunRowFull, getRunResults, type RunResultRow } from "./runs.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { analysisNarrativeSchemaProperties, type AnalysisNarrative } from "@agentx/judge-core";

// Self-host's own "Analyze" (AI Analysis) feature — see the plan's Context section for why this
// isn't a port of the hosted SaaS's multi-judge MapReduce job pipeline (evaluationAnalysisService.ts):
// no job queue exists anywhere in this engine, and the pipeline's centerpiece — instructionChanges,
// applied straight into a native agent's live config — has no self-host target at all (self-host
// doesn't own the caller's agent code, same reason Prompt Management exists instead of native
// autotune).
//
// Multi-judge IS supported (up to MAX_JUDGES, same as hosted's slot count) — just not via a job
// queue: every selected judge independently re-rates every sampled item, all in parallel
// (Promise.all across items x judges, bounded by SAMPLE_WORST_COUNT+SAMPLE_BEST_COUNT items x 3
// judges), synchronously within the one HTTP request. That gives genuine independent opinions and
// a real agreement/disagreement signal per item, without hosted's confidence-weighted fusion or
// tie-break-on-disagreement judge — this just averages the judges that responded and buckets the
// spread into a disagreement band. The final narrative write-up is still one call (using the first
// selected judge as writer), fed the multi-judge consensus rather than raw single-judge ratings.
//
// Deliberately out of scope, always returned as empty/undefined rather than faked:
// confidence-weighted fusion / tie-break judge on disagreement (hosted-pipeline-specific — this
// just averages), pipelineBreakdown/cost/SLO/overflow stats (hosted-pipeline-specific), and
// instructionChanges (see above) — the frontend panel already renders all of these as optional/
// "N/A" when absent, so nothing needs to change there to accept a smaller response.

export type EvaluationAnalysisStatistics = {
  numberOfRuns: number;
  averageRating: number;
  minRating: number;
  maxRating: number;
  ratingVariance: number;
};

// The narrative fields (summary/instructionAdherence/.../overallAssessment) live in judge-core's
// AnalysisNarrative now, shared with AgentX-web-api's evaluationAnalysisService.ts — see that
// type's own comment for why instructionChanges/delegationAnalysis aren't part of it.
export type AnalysisSchema = AnalysisNarrative & { instructionChanges: never[] };

export type ItemJudgeRating = {
  judgeVariant: string;
  model: string;
  rating: number | null;
  justification: string | null;
};

export type JudgeEvidenceSampleItem = {
  questionIndex: number;
  runNumber: number;
  query: string;
  response: string;
  // Average of the judges that returned a rating (null if all failed) and a spread-based bucket —
  // see disagreementBandFor. Not hosted's confidence-weighted fusion, just an honest average.
  finalScore: number | null;
  disagreementBand: "single_judge" | "unanimous" | "moderate" | "split";
  judges: ItemJudgeRating[];
};

export type EvaluationAnalysisRow = {
  evaluationId: string;
  status: "completed" | "failed";
  // Primary/writer judge (judgeModels[0]) — kept alongside judgeModels for rows written before
  // multi-judge support existed, and as the model that authored the narrative fields below.
  judgeModel: string;
  judgeModels: string[];
  analysis: AnalysisSchema | null;
  statistics: EvaluationAnalysisStatistics | null;
  judgeEvidence: JudgeEvidenceSampleItem[] | null;
  error: string | null;
  createdAt: Date;
};

function computeStatistics(results: RunResultRow[]): EvaluationAnalysisStatistics {
  const ratings = results.map(r => r.rating).filter((r): r is number => r != null);
  const numberOfRuns = ratings.length;
  const averageRating = numberOfRuns ? ratings.reduce((a, b) => a + b, 0) / numberOfRuns : 0;
  const variance = numberOfRuns
    ? ratings.reduce((sum, r) => sum + (r - averageRating) ** 2, 0) / numberOfRuns
    : 0;
  return {
    numberOfRuns,
    averageRating,
    minRating: numberOfRuns ? Math.min(...ratings) : 0,
    maxRating: numberOfRuns ? Math.max(...ratings) : 0,
    ratingVariance: variance,
  };
}

// Worst-N + best-N, not worst-only: a judge that only ever sees failures can't tell you what's
// consistently working (overallAssessment.strengths, responsePatterns.similarities need that too).
// Capped well under typical context limits — this is one prompt, not a paginated report.
const SAMPLE_WORST_COUNT = 12;
const SAMPLE_BEST_COUNT = 5;

function buildSample(results: RunResultRow[]): RunResultRow[] {
  const rated = results.filter(r => r.rating != null).sort((a, b) => (a.rating as number) - (b.rating as number));
  if (rated.length <= SAMPLE_WORST_COUNT + SAMPLE_BEST_COUNT) {
    return rated;
  }
  const worst = rated.slice(0, SAMPLE_WORST_COUNT);
  const best = rated.slice(-SAMPLE_BEST_COUNT);
  return [...worst, ...best];
}

const MAX_JUDGES = 3;
const JUDGE_VARIANTS = ["A", "B", "C"] as const;

const ITEM_SCORE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "number", description: "Rating from 0-10" },
    justification: { type: "string", description: "1-2 sentence explanation" },
  },
  required: ["rating", "justification"],
};

function itemScorePrompt(query: string, response: string): string {
  return `You are independently reviewing a single AI agent response as part of a multi-judge analysis. Rate it on its own merits — you won't see what any other judge scored it.

**User's question:**
${query}

**Agent's response:**
${response}

Rate the response from 0-10 on how helpful, accurate, relevant, and well-structured it is. Provide a 1-2 sentence justification.`;
}

function disagreementBandFor(ratings: number[]): JudgeEvidenceSampleItem["disagreementBand"] {
  if (ratings.length <= 1) {
    return "single_judge";
  }
  const spread = Math.max(...ratings) - Math.min(...ratings);
  if (spread <= 1) {
    return "unanimous";
  }
  return spread <= 3 ? "moderate" : "split";
}

// Every selected judge independently re-rates this one item (in parallel, not sequentially) —
// deliberately not shown each other's rating/justification, so each opinion is genuinely
// independent rather than anchored on whichever judge happens to run "first".
async function scoreItemWithJudges(row: RunResultRow, judgeModels: string[]): Promise<JudgeEvidenceSampleItem> {
  const query = row.input?.query ?? "";
  const response = row.error ? `[error] ${row.error.type}: ${row.error.message}` : (row.output?.text ?? "");
  const prompt = itemScorePrompt(query, response);

  const judges: ItemJudgeRating[] = await Promise.all(
    judgeModels.map(async (model, i) => {
      const variant = JUDGE_VARIANTS[i] ?? String(i + 1);
      const result = await callJudgeJson({ model, jsonSchema: ITEM_SCORE_SCHEMA, userMessage: prompt });
      const payload = result.payload as { rating?: number; justification?: string } | null;
      return {
        judgeVariant: variant,
        model,
        rating: typeof payload?.rating === "number" ? payload.rating : null,
        justification: payload?.justification ?? null,
      };
    })
  );

  const ratings = judges.map(j => j.rating).filter((r): r is number => r != null);
  const finalScore = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

  return {
    questionIndex: row.questionIndex ?? 0,
    runNumber: row.runNumber ?? 1,
    query,
    response,
    finalScore,
    disagreementBand: disagreementBandFor(ratings),
    judges,
  };
}

// All sample items scored in parallel too, not just the judges within each item — worst case
// (SAMPLE_WORST_COUNT + SAMPLE_BEST_COUNT) x MAX_JUDGES concurrent judge calls for one "Start
// Analysis" click. Acceptable for a manual, infrequent, user-initiated action; revisit with
// chunking/concurrency limits if that turns out to be too aggressive against provider rate limits.
async function scoreSampleWithJudges(sample: RunResultRow[], judgeModels: string[]): Promise<JudgeEvidenceSampleItem[]> {
  return Promise.all(sample.map(row => scoreItemWithJudges(row, judgeModels)));
}

const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: analysisNarrativeSchemaProperties({ requireRatings: true }),
  required: [
    "summary",
    "consistencyScore",
    "instructionAdherence",
    "responsePatterns",
    "reasoningAnalysis",
    "toolUsageAnalysis",
    "recommendations",
    "overallAssessment",
  ],
};

function buildJudgePrompt(
  judgeEvidence: JudgeEvidenceSampleItem[],
  statistics: EvaluationAnalysisStatistics,
  judgeCount: number
): string {
  const examplesText = judgeEvidence
    .map((item, i) => {
      const rating = item.finalScore != null ? `${item.finalScore.toFixed(1)}/10` : "unrated";
      const judgeLine =
        judgeCount > 1
          ? `\nJudges: ${item.judges.map(j => `${j.judgeVariant}=${j.rating ?? "n/a"}`).join(", ")} (${item.disagreementBand})`
          : item.judges[0]?.justification
            ? `\nJudge feedback: ${item.judges[0].justification}`
            : "";
      return `Example ${i + 1} (rating ${rating}):\nQuery: ${item.query}\nResponse: ${item.response}${judgeLine}`;
    })
    .join("\n\n");

  const multiJudgeNote =
    judgeCount > 1
      ? `\n\nEach example below was independently re-rated by ${judgeCount} judges; the rating shown is their average, and each example notes how much the judges agreed ("unanimous"/"moderate"/"split"). Where judges disagreed significantly, treat that as a signal of ambiguity worth mentioning.`
      : "";

  return `You are analyzing an AI agent's evaluation results to help its developer understand how it's performing and how to improve it.

Aggregate statistics across all ${statistics.numberOfRuns} scored responses in this run:
- Average rating: ${statistics.averageRating.toFixed(2)}/10
- Range: ${statistics.minRating}-${statistics.maxRating}
- Rating variance: ${statistics.ratingVariance.toFixed(2)}

Below is a sample of responses, spanning both the worst-rated and best-rated ones so you can see both what's failing and what's working consistently well.${multiJudgeNote}

${examplesText}

Write a structured analysis: an overall summary, how consistent the agent's behavior was, how well it followed its apparent instructions, patterns across responses (what's similar/different/outlying), the quality of its reasoning where visible, how effectively it used any tools, concrete prioritized recommendations, and an overall assessment of strengths/weaknesses. Return only JSON matching the schema.`;
}

export async function getEvaluationAnalysisRow(db: Db, evaluationId: string): Promise<EvaluationAnalysisRow | null> {
  const cond = and(eq(db.schema.evaluationAnalyses.evaluationId, evaluationId), eq(db.schema.evaluationAnalyses.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.evaluationAnalyses).where(cond).all()[0] as EvaluationAnalysisRow | undefined)
      : ((await db.db.select().from(db.schema.evaluationAnalyses).where(cond))[0] as EvaluationAnalysisRow | undefined);
  return row ?? null;
}

async function upsertEvaluationAnalysisRow(db: Db, row: EvaluationAnalysisRow): Promise<void> {
  const existing = await getEvaluationAnalysisRow(db, row.evaluationId);
  if (existing) {
    const updateCond = and(
      eq(db.schema.evaluationAnalyses.evaluationId, row.evaluationId),
      eq(db.schema.evaluationAnalyses.projectId, db.projectId)
    );
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.evaluationAnalyses).set(row).where(updateCond);
    } else {
      await db.db.update(db.schema.evaluationAnalyses).set(row).where(updateCond);
    }
    return;
  }
  const insertRow = { ...row, projectId: db.projectId };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationAnalyses).values(insertRow);
  } else {
    await db.db.insert(db.schema.evaluationAnalyses).values(insertRow);
  }
}

export type AnalyzeEvaluationOptions = {
  judges?: { model: string }[];
  qualityMode?: "quality_first" | "balanced";
};

export type AnalyzeEvaluationResult = { evaluationId: string; status: "completed" | "failed"; judgeModel: string };

export async function runEvaluationAnalysis(
  db: Db,
  evaluationId: string,
  opts: AnalyzeEvaluationOptions = {}
): Promise<AnalyzeEvaluationResult | null> {
  const run = await getRunRowFull(db, evaluationId);
  if (!run) {
    return null;
  }
  const requested = (opts.judges ?? []).map(j => j.model).filter((m): m is string => !!m);
  const judgeModels = (requested.length ? requested : [DEFAULT_JUDGE_MODEL]).slice(0, MAX_JUDGES);
  const judgeModel = judgeModels[0]!;
  const results = await getRunResults(db, evaluationId);
  const statistics = computeStatistics(results);
  const sample = buildSample(results);
  const now = new Date();

  if (sample.length === 0) {
    const row: EvaluationAnalysisRow = {
      evaluationId,
      status: "failed",
      judgeModel,
      judgeModels,
      analysis: null,
      statistics,
      judgeEvidence: [],
      error: "No scored results yet — nothing to analyze.",
      createdAt: now,
    };
    await upsertEvaluationAnalysisRow(db, row);
    return { evaluationId, status: "failed", judgeModel };
  }

  const judgeEvidence = await scoreSampleWithJudges(sample, judgeModels);

  const judgeResult = await callJudgeJson({
    model: judgeModel,
    jsonSchema: ANALYSIS_JSON_SCHEMA,
    userMessage: buildJudgePrompt(judgeEvidence, statistics, judgeModels.length),
    maxTokens: 3000,
  });
  // judgeResult.payload's own type (judge-core's JudgeCallResult) is `unknown` — a parsed JSON
  // object on success, or null on failure — never actually guaranteed to be the right shape at
  // runtime (the judge model's raw response only *should* match jsonSchema, an LLM call can always
  // return something else). A bare `if (!payload)` below would accept a non-null non-object (a
  // string, a number, an array) as if it were the analysis object; `{ ...payload, ... }` on a
  // string spreads its characters into a garbage object instead of failing loudly. Guard on the
  // actual shape, not just truthiness.
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const payload = isPlainObject(judgeResult.payload)
    ? (judgeResult.payload as Omit<AnalysisSchema, "instructionChanges">)
    : null;

  if (!payload) {
    const row: EvaluationAnalysisRow = {
      evaluationId,
      status: "failed",
      judgeModel,
      judgeModels,
      analysis: null,
      statistics,
      judgeEvidence,
      error: "Judge model returned no analysis.",
      createdAt: now,
    };
    await upsertEvaluationAnalysisRow(db, row);
    return { evaluationId, status: "failed", judgeModel };
  }

  const row: EvaluationAnalysisRow = {
    evaluationId,
    status: "completed",
    judgeModel,
    judgeModels,
    analysis: { ...payload, instructionChanges: [] },
    statistics,
    judgeEvidence,
    error: null,
    createdAt: now,
  };
  await upsertEvaluationAnalysisRow(db, row);
  return { evaluationId, status: "completed", judgeModel };
}

export async function getEvaluationAnalysisStatus(db: Db, evaluationId: string) {
  const row = await getEvaluationAnalysisRow(db, evaluationId);
  if (!row) {
    return {
      evaluationId,
      jobId: null,
      status: "not_started" as const,
      progress: { overallPercentage: 0, currentLevel: null, levels: {} },
      failureReason: null,
      warnings: [],
      cost: { estimatedUSD: null },
      etaUpdatedAt: null,
      overflowStats: { compressedItems: 0, maxCompressionRatio: null, tokenOverflowCount: 0, recursiveSplitCount: 0 },
    };
  }
  return {
    evaluationId,
    jobId: evaluationId,
    status: row.status,
    progress: { overallPercentage: 100, currentLevel: null, levels: {} },
    failureReason: row.error ? { code: "ANALYSIS_FAILED", message: row.error, retryable: true } : null,
    warnings: [],
    cost: { estimatedUSD: null },
    etaUpdatedAt: null,
    overflowStats: { compressedItems: 0, maxCompressionRatio: null, tokenOverflowCount: 0, recursiveSplitCount: 0 },
  };
}

function modelProvider(model: string): "anthropic" | "openai" {
  return model.startsWith("claude-") ? "anthropic" : "openai";
}

export async function getEvaluationAnalysisMetrics(db: Db, evaluationId: string) {
  const row = await getEvaluationAnalysisRow(db, evaluationId);
  if (!row) {
    return null;
  }
  // Legacy rows (written before multi-judge support) only have judgeModel, not judgeModels.
  const judgeModels = row.judgeModels?.length ? row.judgeModels : [row.judgeModel];
  const modelSnapshot: Record<string, { model: string; provider: string }> = {};
  const slotKeys = ["judgeA", "judgeB", "judgeC"] as const;
  judgeModels.slice(0, MAX_JUDGES).forEach((model, i) => {
    const key = slotKeys[i];
    if (key) {
      modelSnapshot[key] = { model, provider: modelProvider(model) };
    }
  });

  return {
    modelSnapshot,
    pipelineBreakdown: undefined,
    judgeEvidence: (row.judgeEvidence ?? []).map(item => ({
      questionIndex: item.questionIndex,
      runNumber: item.runNumber,
      stepIndex: 0,
      finalScore: item.finalScore ?? undefined,
      disagreementBand: item.disagreementBand,
      responseText: item.response,
      judges: item.judges.map(j => ({
        judgeVariant: j.judgeVariant,
        model: j.model,
        rating: j.rating ?? undefined,
        justification: j.justification ?? undefined,
      })),
    })),
  };
}
