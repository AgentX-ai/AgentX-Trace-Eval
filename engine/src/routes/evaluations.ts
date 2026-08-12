import { Router, type Request, type Response } from "express";
import { scopedDb } from "../auth/apiKey.js";
import { createDataset, getDataset, listDatasets, extractSimilarityConfig, extractCodeScorers } from "../core/evaluate/datasets.js";
import { createEvaluationSettings, getEvaluationSettings, listEvaluationSettings } from "../core/evaluate/evaluationSettings.js";
import { initRun, appendResults, finalizeRun, getRun, listRuns, computeRunGate, recordGateResult, MAX_BATCH_SIZE } from "../core/evaluate/runs.js";
import { createPrompt, getPromptForSdk, listPromptsForSdk } from "../core/evaluate/prompts.js";
import { handleCasePreview, handleSuggestExpected, handleAddCase } from "./curationHandlers.js";

// Mounted at /api/v1/custom-agent-evaluations, matching AgentX-Python's
// EvaluationsClient._DEFAULT_BASE_URL (agentx/evaluations/client.py) so pointing the SDK at a
// self-host instance via AGENTX_API_BASE_URL works unmodified.
//
// Scope for this pass (plan task #109): dataset/evaluation-settings CRUD, and the synchronous
// per-result judge-scoring loop (init_run -> append_results -> finalize_run -> get_run). The
// hosted SaaS's async whole-run LLM analysis (analyze_run/get_analysis_status/get_report),
// list_models, and get_missing_results are not ported: a materially larger, separate feature
// (durable job queue, richer report schema) left for a future pass.
export const evaluationsRouter = Router();

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
  const { datasetId, evaluationSettingsId, evaluationSubject, runSource, sdk } = req.body ?? {};
  if (typeof datasetId !== "string" || !datasetId) {
    res.status(400).json({ error: "datasetId is required" });
    return;
  }
  const run = await initRun(scopedDb(req), { datasetId, evaluationSettingsId, evaluationSubject, runSource, sdk });
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
    res.status(200).json(outcome);
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Unable to append results" });
  }
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
