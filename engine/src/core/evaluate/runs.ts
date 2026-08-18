import { nanoid } from "nanoid";
import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import {
  renderTraceTrajectory,
  extractTraceToolSequence,
  matchTrajectory,
  type TrajectoryMatchMode,
} from "../trace/trajectory.js";
import { getEvaluationSettingsRow, type EvaluationSettingsRow } from "./evaluationSettings.js";
import type { SimilarityConfig } from "./datasets.js";
import { runCodeScorer, type CodeScorerConfig, type CodeScorerResult } from "./codeScorer.js";
import { extractWebhookUrls, notifyWebhooks } from "../monitor/webhooks.js";
import { listProfileRows } from "../monitor/profiles.js";
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
  questions: Array<{
    main_question?: {
      query?: string;
      expectedResults?: string;
      judgeGuideline?: string;
      retrievalContext?: string;
      // Agent-native expectation: the tool calls this case should make, matched against the
      // linked trace's actual tool sequence (core/trace/trajectory.ts's matchTrajectory).
      expectedTrajectory?: { tools?: string[]; mode?: string };
    };
  }>;
};

// Exported for proposalValidation.ts, which grades baseline-vs-candidate runs with exactly the
// grading config a real run of that dataset would use.
export async function resolveRunConfig(
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
  const cond = and(eq(db.schema.datasets.id, id), eq(db.schema.datasets.projectId, db.projectId));
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.datasets).where(cond).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.datasets).where(cond))[0] as Row | undefined;
}

// ---------------------------------------------------------------------------
// init_run
// ---------------------------------------------------------------------------

// Extracted from evaluationSubject.version (if the SDK ever adds a first-class field) or
// evaluationSubject.metadata.version (works today, zero SDK changes needed - see
// AgentX-Python's EvaluationSubject.metadata, a free-form dict) - the external-agent analog to
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
    projectId: db.projectId,
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

// Minimal local trace read (id + toolCalls only, in effect) rather than importing
// core/trace/ingest.ts's getTraceRow - keeps core/evaluate free of an import into core/trace,
// which pulls in the classification/pricing graph this module doesn't need.
async function getTraceRowForScoring(db: Db, traceId: string): Promise<{ toolCalls: unknown } | null> {
  const cond = and(eq(db.schema.traces.id, traceId), eq(db.schema.traces.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.traces).where(cond).all()[0] as { toolCalls: unknown } | undefined)
      : ((await db.db.select().from(db.schema.traces).where(cond))[0] as { toolCalls: unknown } | undefined);
  return row ?? null;
}

// judgeError isolates the one part of scoring that needs an API key. The similarity metrics and
// code scorers need none - they are the whole no-key story - but shared a Promise.all and a catch
// with the judge, so an install with no OPENAI_API_KEY got null in every similarity column even
// though the numbers had been calculated.
type ScoredResult = { rating: number | null; justification: string; judgeError: Error | null } & SimilarityScores & {
    codeScorerResults: CodeScorerResult[];
  };

async function scoreOneResult(db: Db, config: ResolvedRunConfig, item: SubmittedResult): Promise<ScoredResult> {
  const question = item.questionIndex != null ? config.questions[item.questionIndex] : undefined;
  const mainQ = question?.main_question;
  const expected = mainQ?.expectedResults;
  const actual = item.output?.text;

  // The linked trace's recorded tool calls, when the result carries a traceId and any scorer will
  // actually run - lets a code scorer assert on tool behavior (see codeScorer.ts's ScorerArgs).
  // One cheap local row read, skipped entirely for the common no-scorers case.
  let toolCalls: unknown;
  if (item.traceId && config.codeScorers.length > 0) {
    const trace = await getTraceRowForScoring(db, item.traceId);
    if (trace && Array.isArray(trace.toolCalls) && trace.toolCalls.length > 0) {
      toolCalls = trace.toolCalls;
    }
  }

  // Trajectory-aware judging: a result that links its trace (snippets pass sync=True and return
  // span.trace_id) gets the agent's actual execution path rendered into the judge prompt, so the
  // judge scores HOW the answer was produced (tool choice, order, failures), not just the answer.
  const trajectory = item.traceId ? await renderTraceTrajectory(db, item.traceId).catch(() => null) : null;

  const [judged, vectorSimilarity, jaccardSimilarity, bleuScore, rougeScore, codeScorerResults] = await Promise.all([
    // Resolved, never rejected - the same isolation the code scorers below already have.
    scoreAgainstCriteria(config, {
      input: item.input?.query || "",
      output: actual || "",
      expected,
      judgeGuideline: mainQ?.judgeGuideline,
      // For {context}-referencing judge prompts (the RAG metric pack) - a case can pin the
      // retrieved chunks it was answered from.
      context: mainQ?.retrievalContext,
      trajectory: trajectory ?? undefined,
    }).then(
      result => ({ ...result, judgeError: null as Error | null }),
      (err: unknown) => ({
        rating: null,
        justification: "",
        judgeError: err instanceof Error ? err : new Error(String(err)),
      })
    ),
    config.similarityConfig.vectorSimilarity?.enabled
      ? computeVectorSimilarity(expected, actual, config.similarityConfig.vectorSimilarity.model)
      : Promise.resolve(null),
    config.similarityConfig.jaccardSimilarity?.enabled ? computeJaccardSimilarity(expected, actual) : null,
    config.similarityConfig.bleuScore?.enabled ? computeBleuScore(expected, actual) : null,
    config.similarityConfig.rougeScore?.enabled ? computeRougeScore(expected, actual) : null,
    // Each code scorer isolates its own failure into { score: null, error } (see codeScorer.ts's
    // runCodeScorer) - a broken/timed-out scorer never rejects this Promise.all or takes down the
    // judge rating / similarity scores alongside it.
    Promise.all(
      config.codeScorers.map(scorer =>
        runCodeScorer(scorer, { input: item.input?.query || "", output: actual || "", expected, toolCalls })
      )
    ),
  ]);

  // Trajectory match: a case that declares expected tool calls gets a deterministic pass/fail
  // scored against the linked trace's actual sequence. Reported through codeScorerResults so it
  // rides the existing storage and results UI as one more named scorer row.
  const expectedTrajectory = mainQ?.expectedTrajectory;
  const expectedTools = (expectedTrajectory?.tools ?? []).map(t => String(t).trim()).filter(Boolean);
  if (expectedTools.length > 0) {
    const mode = (["strict", "unordered", "subset", "superset"] as const).includes(
      expectedTrajectory?.mode as TrajectoryMatchMode
    )
      ? (expectedTrajectory?.mode as TrajectoryMatchMode)
      : "strict";
    if (!item.traceId) {
      codeScorerResults.push({
        name: `Trajectory match (${mode})`,
        score: null,
        error: "No trace linked to this result - trace with sync=True and return the span's trace_id",
      });
    } else {
      const actualSequence = (await extractTraceToolSequence(db, item.traceId)) ?? [];
      const match = matchTrajectory(expectedTools, actualSequence, mode);
      codeScorerResults.push({
        name: `Trajectory match (${mode})`,
        score: match.matched ? 1 : 0,
        reasoning: match.reasoning,
      });
    }
  }

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
        const scored = await scoreOneResult(db, config, item);
        // Kept regardless of the judge outcome - all a run without an LLM key has to show.
        similarity = scored;
        codeScorerResults = scored.codeScorerResults;
        if (scored.judgeError) {
          status = "skipped";
          justification = scored.judgeError.message;
          // Judge call failures (bad/missing API key, provider outage) previously left no trace
          // anywhere except this one result's justification field, effectively invisible unless a
          // caller went looking at the exact result row. Surfacing it here at least gets it into
          // agentx-server's own logs.
          console.error("Evaluate: judge scoring failed for run %s (%s):", runId, item.idempotencyKey, scored.judgeError);
        } else {
          rating = scored.rating;
          justification = scored.justification;
        }
      } catch (err) {
        status = "skipped";
        justification = err instanceof Error ? err.message : "Scoring failed";
        console.error(`Evaluate: scoring failed for run ${runId} (${item.idempotencyKey}):`, err);
      }
    }

    const resultRow = {
      id: nanoid(),
      projectId: db.projectId,
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
    eq(db.schema.evaluationRunResults.idempotencyKey, idempotencyKey),
    eq(db.schema.evaluationRunResults.projectId, db.projectId)
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
  const cond = and(eq(db.schema.evaluationRuns.id, id), eq(db.schema.evaluationRuns.projectId, db.projectId));
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.evaluationRuns).where(cond).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.evaluationRuns).where(cond))[0] as Row | undefined;
}

// Rating aggregate in the hosted SDK's liveStatistics shape ({averageRating, minRating,
// maxRating, ratedCount}) - what AgentX-Python's run context reads for run.average_rating and
// friends. Computed from stored results, so it reflects whatever judge scoring has already
// written; returned from appendResults batches, finalize, and the run resource alike.
export async function computeLiveStatistics(db: Db, runId: string) {
  const cond = and(eq(db.schema.evaluationRunResults.runId, runId), eq(db.schema.evaluationRunResults.projectId, db.projectId));
  const results = (
    db.kind === "sqlite"
      ? db.db.select({ rating: db.schema.evaluationRunResults.rating }).from(db.schema.evaluationRunResults).where(cond).all()
      : await db.db.select({ rating: db.schema.evaluationRunResults.rating }).from(db.schema.evaluationRunResults).where(cond)
  ) as { rating: number | null }[];
  const rated = results.filter(r => r.rating != null).map(r => r.rating as number);
  return {
    averageRating: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null,
    minRating: rated.length ? Math.min(...rated) : null,
    maxRating: rated.length ? Math.max(...rated) : null,
    ratedCount: rated.length,
  };
}

export async function finalizeRun(db: Db, runId: string) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  const updateCond = and(eq(db.schema.evaluationRuns.id, runId), eq(db.schema.evaluationRuns.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationRuns).set({ status: "completed" }).where(updateCond);
  } else {
    await db.db.update(db.schema.evaluationRuns).set({ status: "completed" }).where(updateCond);
  }
  return { runId, status: "completed", liveStatistics: await computeLiveStatistics(db, runId) };
}

// Sibling to finalizeRun above, for a run that never made it that far - used by
// connectorRun.ts's background driver when the whole run blows up unexpectedly (not a
// per-question failure, which already isolates into that question's own {error} result via
// appendResults; this is for something outside that, e.g. the dataset itself vanishing mid-run).
export async function failRun(db: Db, runId: string) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  const updateCond = and(eq(db.schema.evaluationRuns.id, runId), eq(db.schema.evaluationRuns.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.evaluationRuns).set({ status: "failed" }).where(updateCond);
  } else {
    await db.db.update(db.schema.evaluationRuns).set({ status: "failed" }).where(updateCond);
  }
  return { runId, status: "failed" };
}

export async function getRun(db: Db, runId: string) {
  const run = await getRunRow(db, runId);
  if (!run) {
    return null;
  }
  const cond = and(eq(db.schema.evaluationRunResults.runId, runId), eq(db.schema.evaluationRunResults.projectId, db.projectId));
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
    liveStatistics: {
      averageRating,
      minRating: rated.length ? Math.min(...rated) : null,
      maxRating: rated.length ? Math.max(...rated) : null,
      ratedCount: rated.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CI gate: pass/fail a finalized run so a CI job can block a merge on eval quality. Two checks,
// both optional but at least one required: an absolute floor (failUnder) and no-regression
// against the dataset's previous completed run (with a tolerance, default 0.5 - judge scores are
// noisy enough that an exact >= comparison would flake builds on variance, not regressions).
// ---------------------------------------------------------------------------

export type RunGateCheck = {
  check: "fail-under" | "no-regression";
  passed: boolean;
  threshold: number | null;
  actual: number | null;
  detail: string;
};

export type RunGateResult = {
  runId: string;
  datasetId: string;
  averageRating: number | null;
  resultCount: number;
  baselineRunId: string | null;
  baselineAverage: number | null;
  checks: RunGateCheck[];
  passed: boolean;
};

const DEFAULT_GATE_TOLERANCE = 0.5;

export async function computeRunGate(
  db: Db,
  runId: string,
  opts: { failUnder?: number | null; noRegression?: boolean; tolerance?: number }
): Promise<RunGateResult | null> {
  const run = await getRun(db, runId);
  const runRow = await getRunRowFull(db, runId);
  if (!run || !runRow) return null;

  // Baseline = the dataset's most recent completed run that finished before this one and has at
  // least one rating. Walked newest-first with a small cap so one empty/failed run in between
  // doesn't blank the comparison.
  let baselineRunId: string | null = null;
  let baselineAverage: number | null = null;
  if (opts.noRegression) {
    const cond = and(eq(db.schema.evaluationRuns.datasetId, run.datasetId), eq(db.schema.evaluationRuns.projectId, db.projectId));
    const rows = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.evaluationRuns).where(cond).all()
        : await db.db.select().from(db.schema.evaluationRuns).where(cond)
    ) as { id: string; status: string | null; createdAt: Date }[];
    const candidates = rows
      .filter(r => r.id !== runId && r.status === "completed" && r.createdAt < runRow.createdAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5);
    for (const candidate of candidates) {
      const summary = await getRun(db, candidate.id);
      if (summary?.averageRating != null) {
        baselineRunId = candidate.id;
        baselineAverage = Math.round(summary.averageRating * 100) / 100;
        break;
      }
    }
  }

  const avg = run.averageRating != null ? Math.round(run.averageRating * 100) / 100 : null;
  const tolerance = opts.tolerance ?? DEFAULT_GATE_TOLERANCE;
  const checks: RunGateCheck[] = [];

  if (opts.failUnder != null) {
    const passed = avg != null && avg >= opts.failUnder;
    checks.push({
      check: "fail-under",
      passed,
      threshold: opts.failUnder,
      actual: avg,
      detail:
        avg == null
          ? "Run has no rated results to score"
          : `Average rating ${avg} ${passed ? ">=" : "<"} floor ${opts.failUnder}`,
    });
  }
  if (opts.noRegression) {
    const passed = baselineAverage == null || (avg != null && avg >= baselineAverage - tolerance);
    checks.push({
      check: "no-regression",
      passed,
      threshold: baselineAverage,
      actual: avg,
      detail:
        baselineAverage == null
          ? "No previous completed run with ratings on this dataset - nothing to regress against"
          : avg == null
            ? "Run has no rated results to compare"
            : `Average rating ${avg} vs previous run's ${baselineAverage} (tolerance ${tolerance})`,
    });
  }

  return {
    runId,
    datasetId: run.datasetId,
    averageRating: avg,
    resultCount: run.resultCount,
    baselineRunId,
    baselineAverage,
    checks,
    passed: checks.every(c => c.passed),
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
  const cond = and(eq(db.schema.evaluationRuns.id, id), eq(db.schema.evaluationRuns.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.evaluationRuns).where(cond).all()[0] as FullRunRow | undefined)
      : ((await db.db.select().from(db.schema.evaluationRuns).where(cond))[0] as FullRunRow | undefined);
  return row ?? null;
}

export async function listRunRows(db: Db): Promise<FullRunRow[]> {
  const cond = eq(db.schema.evaluationRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(cond)
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
  const cond = and(eq(db.schema.evaluationRunResults.runId, runId), eq(db.schema.evaluationRunResults.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRunResults).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRunResults).where(cond)
  ) as RunResultRow[];
  rows.sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0) || (a.runNumber ?? 0) - (b.runNumber ?? 0));
  return rows;
}

// ---------------------------------------------------------------------------
// Recorded gate history: one row per gate evaluation the caller asked to record (the SDK's
// report.gate() records by default; the dashboard's live preview never does), so the CI page
// shows what actually happened in CI rather than recomputed previews.
// ---------------------------------------------------------------------------

export type GateResultRow = {
  id: string;
  runId: string;
  datasetId: string;
  passed: boolean;
  averageRating: number | null;
  baselineRunId: string | null;
  baselineAverage: number | null;
  checks: unknown;
  caller: string | null;
  createdAt: Date;
  projectId: string | null;
};

export async function recordGateResult(db: Db, gate: RunGateResult, caller: string | null): Promise<void> {
  const row: GateResultRow = {
    id: nanoid(),
    runId: gate.runId,
    datasetId: gate.datasetId,
    passed: gate.passed,
    averageRating: gate.averageRating,
    baselineRunId: gate.baselineRunId,
    baselineAverage: gate.baselineAverage,
    checks: gate.checks,
    caller,
    createdAt: new Date(),
    projectId: db.projectId,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.gateResults).values(row);
  } else {
    await db.db.insert(db.schema.gateResults).values(row);
  }

  // A recorded FAIL pages the same webhook channels live-monitoring signals already use - a CI
  // gate blocking a merge is exactly the kind of event someone wants in Slack, and only recorded
  // results alert (record=false preview runs stay silent). Gates aren't agent-scoped, so this
  // notifies the union of every agent profile's webhook targets in the project, fire-and-forget.
  if (!gate.passed) {
    const failing = gate.checks.filter(c => !c.passed);
    const urls = [
      ...new Set((await listProfileRows(db)).flatMap(profile => extractWebhookUrls(profile.channels))),
    ];
    notifyWebhooks(urls, {
      summary: `CI gate FAILED for run ${gate.runId}${caller ? ` (${caller})` : ""}: ${
        failing.map(c => c.detail).join("; ") || "no checks passed"
      }`,
      severity: "high",
      patternKey: `ci-gate:${gate.datasetId}`,
      agentId: null,
    });
  }
}

export async function listGateResults(db: Db, limit = 50): Promise<GateResultRow[]> {
  const cond = eq(db.schema.gateResults.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.gateResults).where(cond).all()
      : await db.db.select().from(db.schema.gateResults).where(cond)
  ) as GateResultRow[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return rows.slice(0, limit);
}

// The dashboard CI page's live preview: gate the dataset's most recent completed run without
// recording anything - "would my CI have passed right now with these thresholds".
export async function previewLatestRunGate(
  db: Db,
  datasetId: string,
  opts: { failUnder?: number | null; noRegression?: boolean; tolerance?: number }
): Promise<RunGateResult | { error: string }> {
  const cond = and(eq(db.schema.evaluationRuns.datasetId, datasetId), eq(db.schema.evaluationRuns.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(cond)
  ) as { id: string; status: string | null; createdAt: Date }[];
  const latest = rows.filter(r => r.status === "completed").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return { error: "No completed runs on this dataset yet" };
  const gate = await computeRunGate(db, latest.id, opts);
  return gate ?? { error: "Run not found" };
}

// ---------------------------------------------------------------------------
// Per-case run comparison (routes/evaluateDashboard.ts): the drill-down under the version
// comparison's aggregate verdict - which cases exactly regressed between two runs, with both
// outputs visible. Results are paired by questionIndex; multiple results per question (repeat
// runs) average their ratings, and smoke-test variants are excluded (they're phrasing-robustness
// probes of the same question, not their own cases - including them would double-count).
// ---------------------------------------------------------------------------

export type RunCaseSide = {
  rating: number | null;
  output: string | null;
  justification: string | null;
  error: string | null;
};

export type RunCaseComparison = {
  questionIndex: number;
  query: string;
  baseline: RunCaseSide;
  candidate: RunCaseSide;
  delta: number | null;
};

export type CompareRunsResult = {
  baselineRun: { runId: string; createdAt: string; version: string | null; averageRating: number | null };
  candidateRun: { runId: string; createdAt: string; version: string | null; averageRating: number | null };
  cases: RunCaseComparison[];
};

function summarizeSide(rows: RunResultRow[]): RunCaseSide {
  const rated = rows.filter(r => r.rating != null);
  const rating = rated.length ? Math.round((rated.reduce((a, r) => a + (r.rating as number), 0) / rated.length) * 10) / 10 : null;
  const representative = rated[0] ?? rows[0];
  return {
    rating,
    output: representative?.output?.text ?? null,
    justification: representative?.justification ?? null,
    error: representative?.error?.message ?? null,
  };
}

export async function compareRuns(db: Db, baselineRunId: string, candidateRunId: string): Promise<CompareRunsResult | { error: string }> {
  const [baselineRow, candidateRow] = await Promise.all([getRunRowFull(db, baselineRunId), getRunRowFull(db, candidateRunId)]);
  if (!baselineRow || !candidateRow) return { error: "Run not found" };
  if (baselineRow.datasetId !== candidateRow.datasetId) {
    return { error: "Runs belong to different datasets - a per-case comparison needs the same question set" };
  }

  const [baselineSummary, candidateSummary, baselineResults, candidateResults] = await Promise.all([
    getRun(db, baselineRunId),
    getRun(db, candidateRunId),
    getRunResults(db, baselineRunId),
    getRunResults(db, candidateRunId),
  ]);

  const group = (rows: RunResultRow[]) => {
    const byQuestion = new Map<number, RunResultRow[]>();
    for (const row of rows) {
      if (row.isSmokeTestVariant || row.questionIndex == null) continue;
      const list = byQuestion.get(row.questionIndex) ?? [];
      list.push(row);
      byQuestion.set(row.questionIndex, list);
    }
    return byQuestion;
  };
  const baselineByQ = group(baselineResults);
  const candidateByQ = group(candidateResults);

  const questionIndexes = [...new Set([...baselineByQ.keys(), ...candidateByQ.keys()])].sort((a, b) => a - b);
  const cases: RunCaseComparison[] = questionIndexes.map(questionIndex => {
    const baseline = summarizeSide(baselineByQ.get(questionIndex) ?? []);
    const candidate = summarizeSide(candidateByQ.get(questionIndex) ?? []);
    const sourceRows = candidateByQ.get(questionIndex) ?? baselineByQ.get(questionIndex) ?? [];
    return {
      questionIndex,
      query: sourceRows[0]?.input?.query ?? `Question ${questionIndex + 1}`,
      baseline,
      candidate,
      delta:
        baseline.rating != null && candidate.rating != null
          ? Math.round((candidate.rating - baseline.rating) * 10) / 10
          : null,
    };
  });

  const toRunInfo = (row: FullRunRow, summary: Awaited<ReturnType<typeof getRun>>) => ({
    runId: row.id,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    averageRating: summary?.averageRating != null ? Math.round(summary.averageRating * 100) / 100 : null,
  });
  return {
    baselineRun: toRunInfo(baselineRow, baselineSummary),
    candidateRun: toRunInfo(candidateRow, candidateSummary),
    cases,
  };
}

// ---------------------------------------------------------------------------
// Version comparison (routes/evaluateDashboard.ts): the external-agent analog to AgentX's native
// autotune. Run the same external agent twice against a dataset, tag each run with a version
// label (see extractVersion above), see which one scored higher - the same candidateAvg >=
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
  // The version's most recent run - what the dashboard's per-case comparison (compareRuns below)
  // diffs when a human clicks through from the aggregate verdict.
  latestRunId: string;
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
  const runsCond = and(eq(db.schema.evaluationRuns.datasetId, datasetId), eq(db.schema.evaluationRuns.projectId, db.projectId));
  const runs = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(runsCond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(runsCond)
  ) as { id: string; version: string | null; createdAt: Date }[];

  if (runs.length === 0) {
    return { versions: [], comparison: null };
  }

  const runIds = runs.map(r => r.id);
  const resultsCond = and(
    inArray(db.schema.evaluationRunResults.runId, runIds),
    eq(db.schema.evaluationRunResults.projectId, db.projectId)
  );
  const results = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRunResults).where(resultsCond).all()
      : await db.db.select().from(db.schema.evaluationRunResults).where(resultsCond)
  ) as { runId: string; rating: number | null }[];

  const versionByRunId = new Map(runs.map(r => [r.id, r.version?.trim() || UNVERSIONED]));

  type Bucket = { runIds: Set<string>; ratedSum: number; ratedCount: number; lastRunAt: Date; latestRunId: string };
  const buckets = new Map<string, Bucket>();

  for (const run of runs) {
    const version = versionByRunId.get(run.id)!;
    const bucket =
      buckets.get(version) ??
      { runIds: new Set<string>(), ratedSum: 0, ratedCount: 0, lastRunAt: run.createdAt, latestRunId: run.id };
    bucket.runIds.add(run.id);
    if (run.createdAt.getTime() >= bucket.lastRunAt.getTime()) {
      bucket.lastRunAt = run.createdAt;
      bucket.latestRunId = run.id;
    }
    buckets.set(version, bucket);
  }

  // A true average across every rated result in a version's runs, not an average of per-run
  // averages - averaging averages would misweight versions whose runs have different result
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
      latestRunId: bucket.latestRunId,
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
  const cond = eq(db.schema.evaluationRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(cond)
  ) as Row[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return Promise.all(
    rows.slice(0, limit).map(async row => {
      const summary = await getRun(db, row.id);
      return summary ?? { runId: row.id, datasetId: row.datasetId, status: row.status, resultCount: 0, averageRating: null };
    })
  );
}
