import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import {
  createDataset,
  deleteDataset,
  getDataset,
  listDatasets,
  extractSimilarityConfig,
  extractCodeScorers,
} from "../core/evaluate/datasets.js";
import { createEvaluationSettings, getEvaluationSettings, listEvaluationSettings } from "../core/evaluate/evaluationSettings.js";
import {
  initRun,
  appendResults,
  finalizeRun,
  getRun,
  listRuns,
  computeRunGate,
  recordGateResult,
  computeLiveStatistics,
  MAX_BATCH_SIZE, getRunResults, type RunResultRow,} from "../core/evaluate/runs.js";
import { createPrompt, getPromptForSdk, listPromptsForSdk } from "../core/evaluate/prompts.js";
import { runEvaluationAnalysis, getEvaluationAnalysisStatus, getEvaluationAnalysisRow } from "../core/evaluate/analysis.js";
import { handleCasePreview, handleSuggestExpected, handleAddCase } from "./curationHandlers.js";

// Mounted at /api/v1/custom-agent-evaluations, matching AgentX-Python's
// EvaluationsClient._DEFAULT_BASE_URL (agentx/evaluations/client.py) so pointing the SDK at a
// self-host instance via AGENTX_API_BASE_URL works unmodified.
//
// Scope: dataset/evaluation-settings CRUD, the synchronous per-result judge-scoring loop
// (init_run -> append_results -> finalize_run -> get_run), and whole-run analysis
// (analyze_run/get_analysis_status/get_report), which delegates to the same core/evaluate/
// analysis.ts as the dashboard's /evaluate/analyze routes rather than reimplementing it.
// Synchronous here where hosted AgentX queues a durable job; see the analyze route below.
//
// Still not ported: list_models.
export const evaluationsRouter = asyncRouter();

evaluationsRouter.post("/datasets", async (req: Request, res: Response) => {
  const { name, description, numberOfRequests, acceptanceCriteria, rejectionCriteria, evaluationCriteria, questions } =
    req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const dataset = await createDataset(scopedDb(req), {
    name,
    description,
    numberOfRequests: typeof numberOfRequests === "number" ? numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(req.body ?? {}),
    codeScorers: extractCodeScorers(req.body ?? {}),
    acceptanceCriteria,
    rejectionCriteria,
    evaluationCriteria,
    questions: Array.isArray(questions) ? questions : [],
  });
  res.status(201).json(dataset);
});

evaluationsRouter.get("/datasets", async (req: Request, res: Response) => {
  res.status(200).json({ datasets: await listDatasets(scopedDb(req)) });
});

evaluationsRouter.delete("/datasets/:id", async (req: Request, res: Response) => {
  const result = await deleteDataset(scopedDb(req), req.params.id!);
  if (!result.ok && result.reason === "not_found") {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  if (!result.ok) {
    res.status(409).json({ error: "This dataset's grading config is attached to a live scorer - detach it first." });
    return;
  }
  res.status(200).json({ deleted: true });
});

// Curation: production -> golden dataset. Three-step contract (preview builds the case from a
// trace/session, suggest-expected drafts a reference answer on demand, POST :id/cases appends the
// human-edited result with dedupe) - handlers shared with the dashboard router, see
// curationHandlers.ts and core/evaluate/curation.ts.
evaluationsRouter.post("/datasets/case-preview", handleCasePreview);
evaluationsRouter.post("/datasets/suggest-expected", handleSuggestExpected);
evaluationsRouter.post("/datasets/:id/cases", handleAddCase);

evaluationsRouter.get("/datasets/:id", async (req: Request, res: Response) => {
  const dataset = await getDataset(scopedDb(req), req.params.id!);
  if (!dataset) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  res.status(200).json(dataset);
});

evaluationsRouter.post("/evaluation-settings", async (req: Request, res: Response) => {
  const {
    name,
    description,
    numberOfRequests,
    acceptanceCriteria,
    rejectionCriteria,
    evaluationCriteria,
    judgePrompt,
    judgeModel,
  } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const settings = await createEvaluationSettings(scopedDb(req), {
    name,
    description,
    numberOfRequests: typeof numberOfRequests === "number" ? numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(req.body ?? {}),
    codeScorers: extractCodeScorers(req.body ?? {}),
    acceptanceCriteria,
    rejectionCriteria,
    evaluationCriteria,
    judgePrompt,
    judgeModel,
  });
  res.status(201).json(settings);
});

evaluationsRouter.get("/evaluation-settings", async (req: Request, res: Response) => {
  res.status(200).json({ evaluationSettings: await listEvaluationSettings(scopedDb(req)) });
});

evaluationsRouter.get("/evaluation-settings/:id", async (req: Request, res: Response) => {
  const settings = await getEvaluationSettings(scopedDb(req), req.params.id!);
  if (!settings) {
    res.status(404).json({ error: "Evaluation settings not found" });
    return;
  }
  res.status(200).json(settings);
});

evaluationsRouter.post("/runs", async (req: Request, res: Response) => {
  const { datasetId, evaluationSettingsId, evaluationSubject, runSource, sdk, split } = req.body ?? {};
  if (typeof datasetId !== "string" || !datasetId) {
    res.status(400).json({ error: "datasetId is required" });
    return;
  }
  const run = await initRun(scopedDb(req), {
    datasetId,
    evaluationSettingsId,
    evaluationSubject,
    runSource,
    sdk,
    split: typeof split === "string" ? split : undefined,
  });
  if (!run) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  res.status(201).json(run);
});

evaluationsRouter.post("/runs/:runId/results", async (req: Request, res: Response) => {
  const { batchId, results } = req.body ?? {};
  if (!batchId) {
    res.status(400).json({ error: "batchId is required" });
    return;
  }
  if (!Array.isArray(results) || results.length === 0) {
    res.status(400).json({ error: "results must be a non-empty array" });
    return;
  }
  if (results.length > MAX_BATCH_SIZE) {
    res.status(400).json({ error: `Batch size must not exceed ${MAX_BATCH_SIZE}` });
    return;
  }

  try {
    const outcome = await appendResults(scopedDb(req), req.params.runId!, batchId, results);
    if (!outcome) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    // liveStatistics per batch: the SDK's execute() reads it off every batch response, so
    // run.average_rating updates as scoring lands, not only at finalize.
    res.status(200).json({ ...outcome, liveStatistics: await computeLiveStatistics(scopedDb(req), req.params.runId!) });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Unable to append results" });
  }
});

// Resume support for the SDK's execute(): the idempotency keys this run has already accepted.
// The client derives its keys deterministically from (runId, caseId, runNumber), so the set is
// all it needs to skip re-running (and re-paying for) already-submitted cases after a crash or
// network failure mid-run. Kept on the /missing-results path the SDK has always called; the
// legacy `missing` field stays an empty array because the engine cannot know the client's full
// case list - the client computes "missing" as its own keys minus submittedKeys.
evaluationsRouter.get("/runs/:runId/missing-results", async (req: Request, res: Response) => {
  const db = scopedDb(req);
  const runId = req.params.runId!;
  const run = await getRun(db, runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const submittedKeys = (await getRunResults(db, runId)).map(r => r.idempotencyKey).filter(Boolean);
  res.status(200).json({ runId, submittedKeys, submittedCount: submittedKeys.length, missing: [] });
});

evaluationsRouter.post("/runs/:runId/finalize", async (req: Request, res: Response) => {
  const result = await finalizeRun(scopedDb(req), req.params.runId!);
  if (!result) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json(result);
});

evaluationsRouter.get("/runs", async (req: Request, res: Response) => {
  res.status(200).json({ runs: await listRuns(scopedDb(req)) });
});

// Whole-run LLM analysis, on the paths AgentX-Python calls: analyze_run, get_analysis_status
// and get_report (agentx/evaluations/client.py). These delegate to the same core/evaluate/
// analysis.ts the dashboard's /evaluate/analyze/:id routes use - the two surfaces share one
// implementation and one stored row, so an analysis started from the SDK is the same object the
// Evaluate tab renders, and vice versa.
//
// Hosted AgentX runs this as a durable queued job: analyze returns {status: "pending"} and the
// caller polls analyze-status. Here it is synchronous, so analyze returns only once the judges
// are done and the first poll already reads a terminal status. The SDK's poll loop handles that
// correctly - it checks is_terminal before sleeping - so the same client code works against
// both. The response carries mode:"sync" to say which one answered.
evaluationsRouter.post("/runs/:runId/analyze", async (req: Request, res: Response) => {
  const { judges, qualityMode } = req.body ?? {};
  const result = await runEvaluationAnalysis(scopedDb(req), req.params.runId!, {
    judges: Array.isArray(judges)
      ? judges.filter((j: unknown): j is { model: string } => !!j && typeof (j as { model?: unknown }).model === "string")
      : undefined,
    qualityMode: qualityMode === "quality_first" ? "quality_first" : "balanced",
  });
  if (!result) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json({
    evaluationId: result.evaluationId,
    jobId: result.evaluationId,
    status: result.status,
    mode: "sync",
    qualityMode: qualityMode === "quality_first" ? "quality_first" : "balanced",
  });
});

evaluationsRouter.get("/runs/:runId/analyze-status", async (req: Request, res: Response) => {
  res.status(200).json(await getEvaluationAnalysisStatus(scopedDb(req), req.params.runId!));
});

// The SDK's Report: the analysis body hoisted to the top level, alongside the run's identifiers
// and the statistics computed when the analysis ran. 404 rather than an empty report when
// nothing has analyzed this run - an empty report is indistinguishable from a run that scored
// nothing, and the SDK surfaces the distinction to the caller.
evaluationsRouter.get("/runs/:runId/report", async (req: Request, res: Response) => {
  const db = scopedDb(req);
  const runId = req.params.runId!;
  const [run, row] = await Promise.all([getRun(db, runId), getEvaluationAnalysisRow(db, runId)]);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "No analysis found for this run. POST /runs/:runId/analyze first." });
    return;
  }
  // A report that cannot point at its failures is a summary. The hosted platform sends
  // lowScoringCases; this route silently omitted it, so the SDK's Report.low_scoring_cases was
  // [] forever on self-host. Derived from the run's own rows: rating at or below the middle.
  const results = await getRunResults(db, runId);
  const lowScoringCases = results
    // Smoke-test variants are excluded, matching every other aggregation (compareRuns etc.):
    // a paraphrase scoring low is consistency signal, not a failing dataset case to fix.
    .filter((r: RunResultRow) => !r.isSmokeTestVariant && r.rating != null && (r.rating as number) <= 5)
    .map((r: RunResultRow) => ({
      query: r.input?.query ?? null,
      response: r.output?.text ?? null,
      rating: r.rating,
      justification: r.justification ?? null,
    }));
  res.status(200).json({
    ...(row.analysis ?? {}),
    runId,
    datasetId: run.datasetId,
    status: row.status,
    statistics: row.statistics ?? null,
    lowScoringCases,
  });
});

evaluationsRouter.get("/runs/:runId", async (req: Request, res: Response) => {
  const run = await getRun(scopedDb(req), req.params.runId!);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json(run);
});

// CI gate: pass/fail a finalized run for use in a CI job (see core/evaluate/runs.ts's
// computeRunGate). The verdict is computed fresh from the run's stored ratings on every call, so
// re-running a failed CI job re-evaluates against current state; record=true additionally
// appends the verdict to gate history (the dashboard's CI page).
evaluationsRouter.get("/runs/:runId/gate", async (req: Request, res: Response) => {
  const failUnderRaw = req.query.failUnder;
  const failUnder = typeof failUnderRaw === "string" && failUnderRaw !== "" ? Number(failUnderRaw) : null;
  const noRegression = req.query.noRegression === "true" || req.query.noRegression === "1";
  const toleranceRaw = req.query.tolerance;
  const tolerance = typeof toleranceRaw === "string" && toleranceRaw !== "" ? Number(toleranceRaw) : undefined;
  if (failUnder != null && !Number.isFinite(failUnder)) {
    res.status(400).json({ error: "failUnder must be a number" });
    return;
  }
  if (tolerance !== undefined && !Number.isFinite(tolerance)) {
    res.status(400).json({ error: "tolerance must be a number" });
    return;
  }
  if (failUnder == null && !noRegression) {
    res.status(400).json({ error: "At least one check is required: failUnder=<0-10> and/or noRegression=true" });
    return;
  }
  const gate = await computeRunGate(scopedDb(req), req.params.runId!, { failUnder, noRegression, tolerance });
  if (!gate) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  // record=true (the SDK's default) persists this evaluation into gate history - what the
  // dashboard's CI page lists. Ad hoc/preview calls omit it and stay compute-only.
  if (req.query.record === "true" || req.query.record === "1") {
    const caller = typeof req.query.caller === "string" && req.query.caller.trim() ? req.query.caller.trim().slice(0, 60) : null;
    await recordGateResult(scopedDb(req), gate, caller);
  }
  res.status(200).json(gate);
});

// Prompt registry (client.evaluations.prompts): deliberately read-mostly from the SDK - only
// create + pull, no SDK-side publish. A prompt only ever gets a new version through the
// dashboard's human-approved propose/publish flow (routes/evaluateDashboard.ts), matching how
// LangSmith/Langfuse both require a human step before a rewritten prompt reaches Prompt Hub /
// Prompt Management too.
evaluationsRouter.post("/prompts", async (req: Request, res: Response) => {
  const { name, text, description } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const prompt = await createPrompt(scopedDb(req), { name, text, description });
  res.status(201).json(prompt);
});

evaluationsRouter.get("/prompts", async (req: Request, res: Response) => {
  res.status(200).json({ prompts: await listPromptsForSdk(scopedDb(req)) });
});

// Accepts either the prompt's name or its id in the same path segment (see
// getPromptForSdk/getPromptRowByNameOrId), letting `client.evaluations.prompts.get()` take either
// without a second route or SDK method.
evaluationsRouter.get("/prompts/:identifier", async (req: Request, res: Response) => {
  const versionParam = req.query.version;
  const version = typeof versionParam === "string" && versionParam.trim() ? Number(versionParam) : undefined;
  if (version !== undefined && !Number.isInteger(version)) {
    res.status(400).json({ error: "version must be an integer" });
    return;
  }
  const prompt = await getPromptForSdk(scopedDb(req), req.params.identifier!, version);
  if (!prompt) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json(prompt);
});
