import { nanoid } from "nanoid";
import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getEvaluationSettingsRow, type EvaluationSettingsRow } from "./evaluationSettings.js";
import type { SimilarityConfig } from "./datasets.js";
import { runCodeScorer, type CodeScorerConfig, type CodeScorerResult } from "./codeScorer.js";
import {
  scoreAgainstCriteria,
  generateSmokeTestVariants,
  computeJaccardSimilarity,
  computeBleuScore,
  computeRougeScore,
  computeVectorSimilarity,
  DEFAULT_JUDGE_PROMPT,
  DEFAULT_JUDGE_MODEL,
} from "./judge.js";

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
  similarityConfig: SimilarityConfig;
  codeScorers: CodeScorerConfig[];
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
    similarityConfig: (source?.similarityConfig as SimilarityConfig | null) ?? {},
    codeScorers: ((source?.codeScorers as CodeScorerConfig[] | null) ?? []).filter(s => s.enabled),
    questions,
  };
}

async function getDatasetRow(db: Db, id: string) {
  type Row = {
    id: string;
    acceptanceCriteria: string | null;
    rejectionCriteria: string | null;
    evaluationCriteria: string | null;
    similarityConfig: unknown;
    codeScorers: unknown;
    questions: unknown;
  };
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.datasets).where(eq(db.schema.datasets.id, id)))[0] as Row | undefined;
}

// ---------------------------------------------------------------------------
// init_run
// ---------------------------------------------------------------------------

// Extracted from evaluationSubject.version (if the SDK ever adds a first-class field) or
// evaluationSubject.metadata.version (works today, zero SDK changes needed — see
// AgentX-Python's EvaluationSubject.metadata, a free-form dict) — the external-agent analog to
// autotune: tag two SDK runs of the same dataset with different labels, compare their average
// ratings (getVersionComparison below) instead of AgentX branching/merging a config it doesn't own.
function extractVersion(evaluationSubject: unknown): string | null {
  if (!evaluationSubject || typeof evaluationSubject !== "object") {
    return null;
  }
  const subject = evaluationSubject as { version?: unknown; metadata?: { version?: unknown } };
  if (typeof subject.version === "string" && subject.version.trim()) {
    return subject.version.trim();
  }
  if (typeof subject.metadata?.version === "string" && subject.metadata.version.trim()) {
    return subject.metadata.version.trim();
  }
  return null;
}

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
  const smokeTestVariants = await generateSmokeTestVariantsForDataset(dataset.questions);
  const runRow = {
    id,
    datasetId: input.datasetId,
    evaluationSettingsId: input.evaluationSettingsId ?? null,
    evaluationSubject: input.evaluationSubject ?? null,
    version: extractVersion(input.evaluationSubject),
    runSource: input.runSource ?? "sdk",
    sdkInfo: input.sdk ?? null,
    smokeTestVariants,
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
    smokeTestVariants,
  };
}

type SmokeTestQuestion = {
  main_question?: {
    query?: string;
    smokeTest?: { enabled?: boolean; count?: number; guidance?: string };
  };
};

// One group per question with smokeTest.enabled, generated once here and frozen for the run's
// lifetime (see schema.sqlite.ts's evaluationRuns.smokeTestVariants). Returns null (not []) when
// no question requests it, matching AgentX-Python's EvaluationRun.smoke_test_variants being
// Optional/absent rather than an empty list in that case.
async function generateSmokeTestVariantsForDataset(
  questions: unknown
): Promise<{ questionIndex: number; variants: string[] }[] | null> {
  const typed = (questions as SmokeTestQuestion[] | undefined) ?? [];
  const requests = typed
    .map((q, questionIndex) => ({ questionIndex, smokeTest: q.main_question?.smokeTest, query: q.main_question?.query }))
    .filter(r => r.smokeTest?.enabled && (r.smokeTest?.count ?? 0) > 0 && r.query);
  if (requests.length === 0) {
    return null;
  }
  const groups = await Promise.all(
    requests.map(async r => ({
      questionIndex: r.questionIndex,
      variants: await generateSmokeTestVariants(r.query!, r.smokeTest!.count!, r.smokeTest!.guidance),
    }))
  );
  return groups;
}

// ---------------------------------------------------------------------------
// append_results: synchronous judge scoring, ported from
// AgentX-web-api/src/services/evaluationScoringService.ts's scoreResult.
// ---------------------------------------------------------------------------

type SubmittedResult = {
  caseId?: string;
  questionIndex?: number;
  runNumber?: number;
  idempotencyKey: string;
  input?: { query?: string };
  output?: { text?: string };
  error?: { type: string; message: string };
  traceId?: string;
  isSmokeTestVariant?: boolean;
  smokeTestVariantText?: string;
  // AgentX-Python's normalize_result nests these under `timings` (top-level input_tokens/
  // output_tokens on the callable's returned dict, or metadata.input_tokens/prompt_tokens as a
  // fallback, get folded in there client-side before the result is submitted).
  timings?: { latencyMs?: number; inputTokens?: number; outputTokens?: number };
};

type SimilarityScores = {
  vectorSimilarity: number | null;
  jaccardSimilarity: number | null;
  bleuScore: number | null;
  rougeScore: number | null;
};

async function scoreOneResult(
  config: ResolvedRunConfig,
  item: SubmittedResult
): Promise<{ rating: number; justification: string } & SimilarityScores & { codeScorerResults: CodeScorerResult[] }> {
  const question = item.questionIndex != null ? config.questions[item.questionIndex] : undefined;
  const mainQ = question?.main_question;
  const expected = mainQ?.expectedResults;
  const actual = item.output?.text;

  const [judged, vectorSimilarity, jaccardSimilarity, bleuScore, rougeScore, codeScorerResults] = await Promise.all([
    scoreAgainstCriteria(config, {
      input: item.input?.query || "",
      output: actual || "",
      expected,
      judgeGuideline: mainQ?.judgeGuideline,
    }),
    config.similarityConfig.vectorSimilarity?.enabled
      ? computeVectorSimilarity(expected, actual, config.similarityConfig.vectorSimilarity.model)
      : Promise.resolve(null),
    config.similarityConfig.jaccardSimilarity?.enabled ? computeJaccardSimilarity(expected, actual) : null,
    config.similarityConfig.bleuScore?.enabled ? computeBleuScore(expected, actual) : null,
    config.similarityConfig.rougeScore?.enabled ? computeRougeScore(expected, actual) : null,
    // Each code scorer isolates its own failure into { score: null, error } (see codeScorer.ts's
    // runCodeScorer) — a broken/timed-out scorer never rejects this Promise.all or takes down the
    // judge rating / similarity scores alongside it.
    Promise.all(
      config.codeScorers.map(scorer =>
        runCodeScorer(scorer, { input: item.input?.query || "", output: actual || "", expected })
      )
    ),
  ]);

  return { ...judged, vectorSimilarity, jaccardSimilarity, bleuScore, rougeScore, codeScorerResults };
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
    let similarity: SimilarityScores = { vectorSimilarity: null, jaccardSimilarity: null, bleuScore: null, rougeScore: null };
    let codeScorerResults: CodeScorerResult[] = [];

    if (item.error) {
      status = "failed";
      rating = 0;
      justification = `Case failed with error: ${item.error.type}: ${item.error.message}`;
    } else {
      try {
        const scored = await scoreOneResult(config, item);
        rating = scored.rating;
        justification = scored.justification;
        similarity = scored;
        codeScorerResults = scored.codeScorerResults;
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
      traceId: item.traceId ?? null,
      isSmokeTestVariant: item.isSmokeTestVariant ?? false,
      smokeTestVariantText: item.smokeTestVariantText ?? null,
      latencyMs: item.timings?.latencyMs ?? null,
      inputTokens: item.timings?.inputTokens ?? null,
      outputTokens: item.timings?.outputTokens ?? null,
      vectorSimilarity: similarity.vectorSimilarity,
      jaccardSimilarity: similarity.jaccardSimilarity,
      bleuScore: similarity.bleuScore,
      rougeScore: similarity.rougeScore,
      codeScorerResults: codeScorerResults.length > 0 ? codeScorerResults : null,
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

// ---------------------------------------------------------------------------
// Dashboard-facing reads (routes/evaluateDashboard.ts). Separate from getRunRow/getRun above
// (SDK-facing, routes/evaluations.ts) rather than widening those: the dashboard needs the run's
// full row (evaluationSubject/runSource/createdAt) and its raw per-question results, neither of
// which the SDK's summary shape exposes or needs.
// ---------------------------------------------------------------------------

export type FullRunRow = {
  id: string;
  datasetId: string;
  evaluationSettingsId: string | null;
  evaluationSubject: unknown;
  version: string | null;
  runSource: string | null;
  status: string;
  createdAt: Date;
};

export async function getRunRowFull(db: Db, id: string): Promise<FullRunRow | null> {
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.evaluationRuns).where(eq(db.schema.evaluationRuns.id, id)).all()[0] as
          | FullRunRow
          | undefined)
      : ((await db.db.select().from(db.schema.evaluationRuns).where(eq(db.schema.evaluationRuns.id, id)))[0] as
          | FullRunRow
          | undefined);
  return row ?? null;
}

export async function listRunRows(db: Db): Promise<FullRunRow[]> {
  const rows = (
    db.kind === "sqlite" ? db.db.select().from(db.schema.evaluationRuns).all() : await db.db.select().from(db.schema.evaluationRuns)
  ) as FullRunRow[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return rows;
}

export type RunResultRow = {
  questionIndex: number | null;
  runNumber: number | null;
  input: { query?: string } | null;
  output: { text?: string } | null;
  error: { type: string; message: string } | null;
  traceId: string | null;
  isSmokeTestVariant: boolean;
  smokeTestVariantText: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  vectorSimilarity: number | null;
  jaccardSimilarity: number | null;
  bleuScore: number | null;
  rougeScore: number | null;
  codeScorerResults: CodeScorerResult[] | null;
  rating: number | null;
  justification: string | null;
  createdAt: Date;
};

export async function getRunResults(db: Db, runId: string): Promise<RunResultRow[]> {
  const cond = eq(db.schema.evaluationRunResults.runId, runId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRunResults).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRunResults).where(cond)
  ) as RunResultRow[];
  rows.sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0) || (a.runNumber ?? 0) - (b.runNumber ?? 0));
  return rows;
}

// ---------------------------------------------------------------------------
// Version comparison (routes/evaluateDashboard.ts): the external-agent analog to AgentX's native
// autotune. Run the same external agent twice against a dataset, tag each run with a version
// label (see extractVersion above), see which one scored higher — the same candidateAvg >=
// baselineAvg check native autotune's /validate does, just comparing two already-computed run
// averages instead of two branch-scoped evaluations, since self-host owns no agent config to
// branch/merge/apply in the first place.
// ---------------------------------------------------------------------------

export type VersionComparisonEntry = {
  version: string;
  runCount: number;
  ratedCount: number;
  averageRating: number | null;
  lastRunAt: string;
};

export type VersionComparisonResult = {
  versions: VersionComparisonEntry[];
  comparison: {
    candidateVersion: string;
    baselineVersion: string;
    candidateAvg: number | null;
    baselineAvg: number | null;
    passed: boolean | null;
  } | null;
};

const UNVERSIONED = "(unversioned)";

export async function getVersionComparison(db: Db, datasetId: string): Promise<VersionComparisonResult> {
  const runsCond = eq(db.schema.evaluationRuns.datasetId, datasetId);
  const runs = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(runsCond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(runsCond)
  ) as { id: string; version: string | null; createdAt: Date }[];

  if (runs.length === 0) {
    return { versions: [], comparison: null };
  }

  const runIds = runs.map(r => r.id);
  const resultsCond = inArray(db.schema.evaluationRunResults.runId, runIds);
  const results = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRunResults).where(resultsCond).all()
      : await db.db.select().from(db.schema.evaluationRunResults).where(resultsCond)
  ) as { runId: string; rating: number | null }[];

  const versionByRunId = new Map(runs.map(r => [r.id, r.version?.trim() || UNVERSIONED]));

  type Bucket = { runIds: Set<string>; ratedSum: number; ratedCount: number; lastRunAt: Date };
  const buckets = new Map<string, Bucket>();

  for (const run of runs) {
    const version = versionByRunId.get(run.id)!;
    const bucket = buckets.get(version) ?? { runIds: new Set<string>(), ratedSum: 0, ratedCount: 0, lastRunAt: run.createdAt };
    bucket.runIds.add(run.id);
    if (run.createdAt.getTime() > bucket.lastRunAt.getTime()) {
      bucket.lastRunAt = run.createdAt;
    }
    buckets.set(version, bucket);
  }

  // A true average across every rated result in a version's runs, not an average of per-run
  // averages — averaging averages would misweight versions whose runs have different result
  // counts (e.g. one run of 50 questions vs three runs of 5).
  for (const result of results) {
    if (result.rating == null) {
      continue;
    }
    const version = versionByRunId.get(result.runId);
    const bucket = version ? buckets.get(version) : undefined;
    if (!bucket) {
      continue;
    }
    bucket.ratedSum += result.rating;
    bucket.ratedCount += 1;
  }

  const versions: VersionComparisonEntry[] = Array.from(buckets.entries())
    .map(([version, bucket]) => ({
      version,
      runCount: bucket.runIds.size,
      ratedCount: bucket.ratedCount,
      averageRating: bucket.ratedCount > 0 ? bucket.ratedSum / bucket.ratedCount : null,
      lastRunAt: bucket.lastRunAt.toISOString(),
    }))
    .sort((a, b) => new Date(b.lastRunAt).getTime() - new Date(a.lastRunAt).getTime());

  let comparison: VersionComparisonResult["comparison"] = null;
  if (versions.length >= 2) {
    const [candidate, baseline] = versions as [VersionComparisonEntry, VersionComparisonEntry];
    comparison = {
      candidateVersion: candidate.version,
      baselineVersion: baseline.version,
      candidateAvg: candidate.averageRating,
      baselineAvg: baseline.averageRating,
      passed:
        candidate.averageRating !== null
          ? baseline.averageRating === null || candidate.averageRating >= baseline.averageRating
          : null,
    };
  }

  return { versions, comparison };
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
