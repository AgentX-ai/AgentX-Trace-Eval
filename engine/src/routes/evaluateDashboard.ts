import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { getDb, type Db } from "../storage/db.js";
import { createDataset, getDataset, listDatasets, updateDataset } from "../core/evaluate/datasets.js";
import {
  createEvaluationSettings,
  getEvaluationSettingsRow,
  updateEvaluationSettings,
} from "../core/evaluate/evaluationSettings.js";
import { getRunRowFull, getRunResults, listRunRows, type FullRunRow, type RunResultRow } from "../core/evaluate/runs.js";

// Mounted at /api/v1/evaluate — the paths AgentX-web-front's Evaluate tab (Governance ->
// EvaluateTab.tsx's "Runs" and "Datasets" sub-views) actually calls (src/data/apiPaths.ts's
// getAllEvaluations/getEvaluationById/getAllEvaluationSettings/createEvaluationSettings/
// updateEvaluationSettings), a different dialect from the SDK-facing /api/v1/custom-agent-
// evaluations router (routes/evaluations.ts): same underlying core logic, different response
// envelope/query params, same convention as agentMonitoringDashboard.ts.
//
// Scope for this pass: Datasets CRUD (list/get/create/update) and a flat Runs list/detail. Not
// built: the standalone "Evaluator" sub-tab (creating a grading config with no dataset attached —
// self-host's dashboard-created entries are always dataset-backed twins, see
// getMergedEvaluationSettings below), dataset/config version history (stubbed as empty so the
// dialogs that unconditionally fetch it don't error, see the /versions routes below), and
// anything tied to AgentX's native agent-building/config-branching system (agentConfigVersion,
// robotConfigBranch, evaluationSettingsConfigVersion, datasetConfigVersion, agent/team-scoped run
// endpoints) — self-host has no agent/team registry or config-branching, so those fields are
// simply omitted rather than faked. See README's Status section.
export const evaluateDashboardRouter = Router();

// Matches AgentX-web-front's src/lib/selfHostMode.ts LOCAL_USER exactly (same synthetic
// always-logged-in local user used everywhere else self-host stands in for a real account).
const LOCAL_USER = { _id: "local", name: "Local", email: "local@localhost" };

function paginate<T>(items: T[], page: number, limit: number) {
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * limit;
  return {
    page: items.slice(start, start + limit),
    pagination: {
      currentPage,
      totalPages,
      totalCount,
      hasNextPage: currentPage < totalPages,
      hasPrevPage: currentPage > 1,
    },
  };
}

function parsePageLimit(req: Request, defaultLimit = 20) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || defaultLimit), 1000);
  return { page, limit };
}

// A "dataset" in the dashboard is a datasets row plus its evaluationSettings twin (same id),
// merged into one EvaluationSettings-shaped wire object — mirrors the hosted SaaS's
// upsertDatasetTwin/resolveDatasetSettings pattern referenced in core/evaluate/runs.ts. Falls back
// gracefully in either direction: a dataset with no twin yet (shouldn't happen via the dashboard,
// which always creates both) still returns with default judgePrompt/judgeModel; a bare
// evaluationSettings row with no dataset twin (created via the SDK's EvaluationSettingsBuilder,
// no questions) still returns as a valid config with an empty questions array.
async function getMergedEvaluationSettings(db: Db, id: string) {
  const datasetWire = await getDataset(db, id);
  const settingsRow = await getEvaluationSettingsRow(db, id);
  if (!datasetWire && !settingsRow) {
    return null;
  }
  const base = datasetWire ?? {
    _id: id,
    name: settingsRow!.name,
    description: settingsRow!.description ?? undefined,
    numberOfRequests: 1,
    acceptanceCriteria: settingsRow!.acceptanceCriteria ?? undefined,
    rejectionCriteria: settingsRow!.rejectionCriteria ?? undefined,
    evaluationCriteria: settingsRow!.evaluationCriteria ?? undefined,
    questions: [],
    status: "published",
    createdAt: settingsRow!.createdAt,
  };
  return {
    ...base,
    judgePrompt: settingsRow?.judgePrompt ?? undefined,
    judgeModel: settingsRow?.judgeModel ?? undefined,
    creator: LOCAL_USER,
  };
}

async function listMergedEvaluationSettings(db: Db) {
  const datasetWires = await listDatasets(db);
  const merged = await Promise.all(
    datasetWires.map(async d => {
      const settingsRow = await getEvaluationSettingsRow(db, d._id);
      return {
        ...d,
        judgePrompt: settingsRow?.judgePrompt ?? undefined,
        judgeModel: settingsRow?.judgeModel ?? undefined,
        creator: LOCAL_USER,
      };
    })
  );
  merged.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return merged;
}

evaluateDashboardRouter.get("/evaluationSettings", async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  // "config" (standalone grading configs with no dataset) isn't buildable from this dashboard yet
  // (see this file's header comment) — nothing to list for that kind.
  if (req.query.kind === "config") {
    res.status(200).json({
      evaluationSettings: [],
      pagination: { currentPage: 1, totalPages: 1, totalCount: 0, hasNextPage: false, hasPrevPage: false },
    });
    return;
  }
  const all = await listMergedEvaluationSettings(getDb());
  const { page: evaluationSettings, pagination } = paginate(all, page, limit);
  res.status(200).json({ evaluationSettings, pagination });
});

// Stub: self-host has no dataset/config version history (see this file's header comment). Must
// come before the /evaluationSettings/:id GET route below only in the sense that Express matches
// by full path shape (two segments vs one), not by declaration order, but is kept up top for
// readability.
evaluateDashboardRouter.get("/evaluationSettings/batch/versions", async (_req: Request, res: Response) => {
  res.status(200).json({ versionCounts: {} });
});

evaluateDashboardRouter.get("/evaluationSettings/:id/versions", async (_req: Request, res: Response) => {
  res.status(200).json([]);
});

evaluateDashboardRouter.get("/datasets/:id/versions", async (_req: Request, res: Response) => {
  res.status(200).json([]);
});

evaluateDashboardRouter.get("/evaluationSettings/:id", async (req: Request, res: Response) => {
  const settings = await getMergedEvaluationSettings(getDb(), req.params.id!);
  if (!settings) {
    res.status(404).json({ error: "Evaluation settings not found" });
    return;
  }
  res.status(200).json(settings);
});

evaluateDashboardRouter.post("/evaluationSettings/create", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const id = nanoid();
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const shared = {
    id,
    name: body.name as string,
    description: body.description as string | undefined,
    acceptanceCriteria: body.acceptanceCriteria as string | undefined,
    rejectionCriteria: body.rejectionCriteria as string | undefined,
    evaluationCriteria: body.evaluationCriteria as string | undefined,
  };
  const [datasetWire] = await Promise.all([
    createDataset(getDb(), { ...shared, questions }),
    createEvaluationSettings(getDb(), shared),
  ]);
  res.status(201).json({ ...datasetWire, creator: LOCAL_USER });
});

evaluateDashboardRouter.put("/evaluationSettings/:id", async (req: Request, res: Response) => {
  const id = req.params.id!;
  const body = req.body ?? {};
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const shared = {
    name: body.name as string,
    description: body.description as string | undefined,
    acceptanceCriteria: body.acceptanceCriteria as string | undefined,
    rejectionCriteria: body.rejectionCriteria as string | undefined,
    evaluationCriteria: body.evaluationCriteria as string | undefined,
  };
  const [datasetWire] = await Promise.all([
    updateDataset(getDb(), id, { ...shared, questions }),
    updateEvaluationSettings(getDb(), id, shared),
  ]);
  if (!datasetWire) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  res.status(200).json({ ...datasetWire, creator: LOCAL_USER });
});

function toResultWire(r: RunResultRow) {
  return {
    message: "",
    responseMessage: r.output?.text ?? (r.error ? `Error: ${r.error.type}: ${r.error.message}` : ""),
    rating: r.rating ?? 0,
    justification: r.justification ?? "",
    questionIndex: r.questionIndex ?? undefined,
    runNumber: r.runNumber ?? undefined,
    questionText: r.input?.query ?? "",
  };
}

// includeResults controls only whether the raw per-question array is embedded in the response
// (the list endpoint omits it, same as the hosted SaaS does for scale reasons) — liveStatistics is
// always computed from the real result rows regardless, since the table's rating column reads
// liveStatistics.averageRating, not results.length, and a rating of exactly 0 (e.g. an errored
// result) must not be treated as "no rating yet" (0 !== null).
async function toEvaluateWire(db: Db, run: FullRunRow, includeResults: boolean) {
  const [dataset, evaluationSettings, results] = await Promise.all([
    getDataset(db, run.datasetId),
    getMergedEvaluationSettings(db, run.evaluationSettingsId ?? run.datasetId),
    getRunResults(db, run.id),
  ]);
  const rated = results.filter(r => r.rating != null).map(r => r.rating as number);
  const averageRating = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;

  return {
    _id: run.id,
    evaluationSettings: evaluationSettings ?? undefined,
    datasetId: dataset ? { _id: dataset._id, name: dataset.name, description: dataset.description } : run.datasetId,
    results: includeResults ? results.map(toResultWire) : [],
    creator: LOCAL_USER,
    executor: LOCAL_USER,
    status: run.status,
    liveStatistics: {
      averageRating,
      minRating: rated.length ? Math.min(...rated) : null,
      maxRating: rated.length ? Math.max(...rated) : null,
      ratedCount: rated.length,
    },
    evaluationSubject: run.evaluationSubject ?? undefined,
    runSource: run.runSource ?? "sdk",
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
  };
}

evaluateDashboardRouter.get("/list", async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const allRows = await listRunRows(getDb());
  const { page: rows, pagination } = paginate(allRows, page, limit);
  const evaluations = await Promise.all(rows.map(run => toEvaluateWire(getDb(), run, false)));
  res.status(200).json({ evaluations, pagination: { ...pagination, limit } });
});

evaluateDashboardRouter.get("/:id", async (req: Request, res: Response) => {
  const run = await getRunRowFull(getDb(), req.params.id!);
  if (!run) {
    res.status(404).json({ error: "Evaluation not found" });
    return;
  }
  const evaluation = await toEvaluateWire(getDb(), run, true);
  res.status(200).json(evaluation);
});
