import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { createDataset, getDataset, listDatasets } from "../core/evaluate/datasets.js";
import { createEvaluationSettings, getEvaluationSettings, listEvaluationSettings } from "../core/evaluate/evaluationSettings.js";
import { initRun, appendResults, finalizeRun, getRun, listRuns, MAX_BATCH_SIZE } from "../core/evaluate/runs.js";

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
  const { name, description, acceptanceCriteria, rejectionCriteria, evaluationCriteria, questions } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const dataset = await createDataset(getDb(), {
    name,
    description,
    acceptanceCriteria,
    rejectionCriteria,
    evaluationCriteria,
    questions: Array.isArray(questions) ? questions : [],
  });
  res.status(201).json(dataset);
});

evaluationsRouter.get("/datasets", async (_req: Request, res: Response) => {
  res.status(200).json({ datasets: await listDatasets(getDb()) });
});

evaluationsRouter.get("/datasets/:id", async (req: Request, res: Response) => {
  const dataset = await getDataset(getDb(), req.params.id!);
  if (!dataset) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  res.status(200).json(dataset);
});

evaluationsRouter.post("/evaluation-settings", async (req: Request, res: Response) => {
  const { name, description, acceptanceCriteria, rejectionCriteria, evaluationCriteria, judgePrompt, judgeModel } =
    req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const settings = await createEvaluationSettings(getDb(), {
    name,
    description,
    acceptanceCriteria,
    rejectionCriteria,
    evaluationCriteria,
    judgePrompt,
    judgeModel,
  });
  res.status(201).json(settings);
});

evaluationsRouter.get("/evaluation-settings", async (_req: Request, res: Response) => {
  res.status(200).json({ evaluationSettings: await listEvaluationSettings(getDb()) });
});

evaluationsRouter.get("/evaluation-settings/:id", async (req: Request, res: Response) => {
  const settings = await getEvaluationSettings(getDb(), req.params.id!);
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
  const run = await initRun(getDb(), { datasetId, evaluationSettingsId, evaluationSubject, runSource, sdk });
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
    const outcome = await appendResults(getDb(), req.params.runId!, batchId, results);
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
  const result = await finalizeRun(getDb(), req.params.runId!);
  if (!result) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json(result);
});

evaluationsRouter.get("/runs", async (_req: Request, res: Response) => {
  res.status(200).json({ runs: await listRuns(getDb()) });
});

evaluationsRouter.get("/runs/:runId", async (req: Request, res: Response) => {
  const run = await getRun(getDb(), req.params.runId!);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json(run);
});
