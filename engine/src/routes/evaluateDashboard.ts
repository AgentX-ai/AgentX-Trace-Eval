import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { getDb, type Db } from "../storage/db.js";
import {
  createDataset,
  getDataset,
  listDatasets,
  updateDataset,
  extractSimilarityConfig,
  type SimilarityConfig,
} from "../core/evaluate/datasets.js";
import {
  createEvaluationSettings,
  getEvaluationSettingsRow,
  updateEvaluationSettings,
  patchEvaluationSettings,
  listStandaloneEvaluationSettings,
} from "../core/evaluate/evaluationSettings.js";
import {
  getRunRowFull,
  getRunResults,
  listRunRows,
  getVersionComparison,
  type FullRunRow,
  type RunResultRow,
} from "../core/evaluate/runs.js";
import {
  createPrompt,
  listPromptsWire,
  getPromptWithVersionsWire,
  publishPromptVersion,
  proposePromptImprovement,
  getWorstRatedExamples,
  getFailureThemes,
  deletePrompt,
} from "../core/evaluate/prompts.js";
import type { MonitoringWindow } from "../core/monitor/events.js";

// Same convention as agentMonitoringDashboard.ts's parseWindow — not shared across route files,
// each route file is self-contained.
function parseWindow(req: Request): MonitoringWindow {
  const raw = req.query.window ?? req.body?.window;
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

// Mounted at /api/v1/evaluate — the paths AgentX-web-front's Evaluate tab (Governance ->
// EvaluateTab.tsx's "Runs" and "Datasets" sub-views) actually calls (src/data/apiPaths.ts's
// getAllEvaluations/getEvaluationById/getAllEvaluationSettings/createEvaluationSettings/
// updateEvaluationSettings), a different dialect from the SDK-facing /api/v1/custom-agent-
// evaluations router (routes/evaluations.ts): same underlying core logic, different response
// envelope/query params, same convention as agentMonitoringDashboard.ts.
//
// Scope for this pass: Datasets CRUD (list/get/create/update), the standalone "Evaluator" sub-tab
// (a grading config with no dataset attached — POST /evaluationSettings/create-standalone below;
// distinct from the dataset+settings twin getMergedEvaluationSettings merges), and a flat Runs
// list/detail. Similarity metrics (vectorSimilarity/jaccard/bleu/rouge) and Sovereignty &
// Portability model comparison are accepted on both dataset and standalone-config payloads but not
// acted on, same as core/evaluate/datasets.ts's CreateDatasetInput — out of scope for this pass,
// see plan task #109. Not built: dataset/config version history (stubbed as empty so the dialogs
// that unconditionally fetch it don't error, see the /versions routes below), and anything tied to
// AgentX's native agent-building/config-branching system (agentConfigVersion, robotConfigBranch,
// evaluationSettingsConfigVersion, datasetConfigVersion, agent/team-scoped run endpoints) — self-
// host has no agent/team registry or config-branching, so those fields are simply omitted rather
// than faked. See README's Status section.
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
    numberOfRequests: settingsRow!.numberOfRequests,
    ...((settingsRow!.similarityConfig as SimilarityConfig | null) ?? {}),
    acceptanceCriteria: settingsRow!.acceptanceCriteria ?? undefined,
    rejectionCriteria: settingsRow!.rejectionCriteria ?? undefined,
    evaluationCriteria: settingsRow!.evaluationCriteria ?? undefined,
    questions: [],
    status: settingsRow!.status,
    isDefault: settingsRow!.isDefault,
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

async function listStandaloneConfigsWire(db: Db) {
  const configs = await listStandaloneEvaluationSettings(db);
  return configs.map(c => ({ ...c, creator: LOCAL_USER }));
}

// "dataset" restricts to real datasets (questions attached), "config" to standalone grading
// configs (no dataset twin — see listStandaloneEvaluationSettings), "all" (default) merges both,
// matching AgentX-web-front's EvaluationSettingsKind contract exactly (useGetAllEvaluationSettings.ts).
evaluateDashboardRouter.get("/evaluationSettings", async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const kind = req.query.kind;
  let all: unknown[];
  if (kind === "config") {
    all = await listStandaloneConfigsWire(getDb());
  } else if (kind === "dataset") {
    all = await listMergedEvaluationSettings(getDb());
  } else {
    const [datasets, configs] = await Promise.all([listMergedEvaluationSettings(getDb()), listStandaloneConfigsWire(getDb())]);
    all = [...datasets, ...configs].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }
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

// Not the same concept as the /versions stub above (that's dataset *edit* history, not built).
// This is the external-agent analog to native autotune's baseline-vs-candidate comparison: group
// this dataset's runs by the version label their evaluationSubject was tagged with (see
// core/evaluate/runs.ts's extractVersion/getVersionComparison), average ratings per version, and
// report whether the most recent version beat the one before it.
evaluateDashboardRouter.get("/datasets/:datasetId/run-comparison", async (req: Request, res: Response) => {
  res.status(200).json(await getVersionComparison(getDb(), req.params.datasetId!));
});

// Prompt registry dashboard routes (core/evaluate/prompts.ts) — the external-agent analog to
// native autotune's config-mutation step: AgentX doesn't own the agent's code, so instead of
// branching/applying a RobotConfig, it becomes the prompt's source of truth (see LangSmith Prompt
// Hub / Langfuse Prompt Management), and a human approves every write. Registered before the
// catch-all GET "/:id" route below so "/prompts" (a bare list) isn't swallowed by it.
evaluateDashboardRouter.get("/prompts", async (_req: Request, res: Response) => {
  res.status(200).json({ prompts: await listPromptsWire(getDb()) });
});

evaluateDashboardRouter.post("/prompts", async (req: Request, res: Response) => {
  const { name, text, description } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const prompt = await createPrompt(getDb(), { name, text, description });
  res.status(201).json(prompt);
});

evaluateDashboardRouter.get("/prompts/:id", async (req: Request, res: Response) => {
  const prompt = await getPromptWithVersionsWire(getDb(), req.params.id!);
  if (!prompt) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json(prompt);
});

// Manual edit and accept-a-proposal both land here — the only write path for a new version, so
// a judge-proposed rewrite never reaches storage without this explicit human-triggered call.
evaluateDashboardRouter.post("/prompts/:id/versions", async (req: Request, res: Response) => {
  const { text, source, reasoning, basedOnVersion } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const prompt = await publishPromptVersion(getDb(), req.params.id!, {
    text,
    source: source === "proposed" ? "proposed" : "manual",
    reasoning,
    basedOnVersion,
  });
  if (!prompt) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(201).json(prompt);
});

// The data half of /propose with no judge call, for a Claude Code skill (or any other caller) to
// do its own reasoning instead of this engine's — see core/evaluate/prompts.ts's
// getWorstRatedExamples for why this is a real evidence feed rather than a second stub.
evaluateDashboardRouter.get("/prompts/:id/examples", async (req: Request, res: Response) => {
  const datasetId = req.query.datasetId;
  const gathered = await getWorstRatedExamples(getDb(), req.params.id!, {
    datasetId: typeof datasetId === "string" && datasetId ? datasetId : undefined,
    includeAllVersions: req.query.includeAllVersions === "true",
    window: parseWindow(req),
  });
  if (!gathered) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json({ ...gathered, exampleCount: gathered.examples.length });
});

// A second, purely-informational judge pass over the same evidence (core/evaluate/prompts.ts's
// clusterFailureThemes), grouping it into a handful of named recurring failure modes for the
// Evidence panel. Its own endpoint (rather than folding into /examples) since it's a real LLM
// call with its own cost/latency and its own "no judge key configured" failure mode, while
// /examples stays a plain data read.
evaluateDashboardRouter.get("/prompts/:id/themes", async (req: Request, res: Response) => {
  const datasetId = req.query.datasetId;
  try {
    const result = await getFailureThemes(getDb(), req.params.id!, {
      datasetId: typeof datasetId === "string" && datasetId ? datasetId : undefined,
      includeAllVersions: req.query.includeAllVersions === "true",
      window: parseWindow(req),
    });
    if (!result) {
      res.status(404).json({ error: "Prompt not found" });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "Unable to cluster failure themes" });
  }
});

// Never writes on its own — returns a suggestion for the dashboard to show, which the human then
// accepts via POST /prompts/:id/versions (source: "proposed") or discards outright.
evaluateDashboardRouter.post("/prompts/:id/propose", async (req: Request, res: Response) => {
  const { datasetId, includeAllVersions, exampleIds } = req.body ?? {};
  try {
    const proposal = await proposePromptImprovement(getDb(), req.params.id!, {
      datasetId: typeof datasetId === "string" && datasetId ? datasetId : undefined,
      includeAllVersions: includeAllVersions === true,
      window: parseWindow(req),
      exampleIds: Array.isArray(exampleIds) ? exampleIds.filter((id: unknown) => typeof id === "string") : undefined,
    });
    if (!proposal) {
      res.status(404).json({ error: "Prompt not found" });
      return;
    }
    res.status(200).json(proposal);
  } catch (err) {
    // Most commonly a missing OPENAI_API_KEY/ANTHROPIC_API_KEY (core/evaluate/judge.ts's
    // callJudgeJson throws a clear setup error for that) — surfaced to the dialog instead of
    // hanging or 500ing opaquely.
    res.status(422).json({ error: err instanceof Error ? err.message : "Unable to generate a proposal" });
  }
});

evaluateDashboardRouter.delete("/prompts/:id", async (req: Request, res: Response) => {
  const deleted = await deletePrompt(getDb(), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json({ success: true });
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
    numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(body),
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

// A standalone, reusable grading config — no dataset/questions attached, no twin (see this file's
// header comment). EvaluationConfigsTab.tsx / CreateEvaluationSettingsConfigDialog.tsx's create
// flow (distinct from the "New dataset" flow above, which always pairs one). numberOfRequests and
// the similarity-metric toggles are both persisted (read back at run-scoring time, see
// core/evaluate/runs.ts's scoreOneResult); sovereigntyIndex/thresholds are still accepted but not
// persisted or acted on, see plan task #109.
evaluateDashboardRouter.post("/evaluationSettings/create-standalone", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const settings = await createEvaluationSettings(getDb(), {
    name: body.name as string,
    description: body.description as string | undefined,
    numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(body),
    acceptanceCriteria: body.acceptanceCriteria as string | undefined,
    rejectionCriteria: body.rejectionCriteria as string | undefined,
    evaluationCriteria: body.evaluationCriteria as string | undefined,
    judgePrompt: body.judgePrompt as string | undefined,
    judgeModel: body.judgeModel as string | undefined,
    isDefault: body.isDefault === true,
    status: typeof body.status === "string" ? body.status : undefined,
  });
  res.status(201).json({ ...settings, creator: LOCAL_USER });
});

evaluateDashboardRouter.put("/evaluationSettings/:id", async (req: Request, res: Response) => {
  const id = req.params.id!;
  const body = req.body ?? {};

  // Two shapes share this one route: a dataset+settings twin (dashboard "New dataset" flow, full-
  // form submit every time) vs. a standalone config (Evaluator tab, which also sends partial
  // payloads like `{ isDefault: true }` from "Make default" — see patchEvaluationSettings's
  // comment for why that needs sparse-merge semantics instead of updateEvaluationSettings's full
  // replace). Branch on whether a dataset row actually exists for this id.
  const existingDataset = await getDataset(getDb(), id);
  if (!existingDataset) {
    const updated = await patchEvaluationSettings(getDb(), id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: body.description as string | undefined,
      numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
      similarityConfig: extractSimilarityConfig(body),
      acceptanceCriteria: body.acceptanceCriteria as string | undefined,
      rejectionCriteria: body.rejectionCriteria as string | undefined,
      evaluationCriteria: body.evaluationCriteria as string | undefined,
      judgePrompt: body.judgePrompt as string | undefined,
      judgeModel: body.judgeModel as string | undefined,
      isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: "Evaluation settings not found" });
      return;
    }
    res.status(200).json({ ...updated, creator: LOCAL_USER });
    return;
  }

  const questions = Array.isArray(body.questions) ? body.questions : [];
  const shared = {
    name: body.name as string,
    description: body.description as string | undefined,
    numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(body),
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

type QuestionsShape = Array<{ main_question?: { expectedResults?: string } }>;

// expectedResults: prefers the run's own evaluationSettings.questions (matches the hosted SaaS
// shape, where a dataset and its grading config are the same twin object), falling back to the
// dataset's questions — needed because a standalone grading config (evaluationSettings/create-
// standalone) has no questions of its own by design, so a run scored against one but backed by a
// real dataset would otherwise show no expected answer at all, even though the dataset has one.
// Same fallback core/evaluate/prompts.ts's getWorstRatedExamples already uses for this exact gap.
function toResultWire(r: RunResultRow, evaluationSettingsQuestions: unknown, datasetQuestions: unknown) {
  const questionIndex = r.questionIndex ?? 0;
  const settingsQuestions = (evaluationSettingsQuestions ?? []) as QuestionsShape;
  const fallbackQuestions = (datasetQuestions ?? []) as QuestionsShape;
  const expectedResults =
    settingsQuestions[questionIndex]?.main_question?.expectedResults ??
    fallbackQuestions[questionIndex]?.main_question?.expectedResults ??
    undefined;
  return {
    message: "",
    responseMessage: r.output?.text ?? (r.error ? `Error: ${r.error.type}: ${r.error.message}` : ""),
    rating: r.rating ?? 0,
    justification: r.justification ?? "",
    questionIndex: r.questionIndex ?? undefined,
    runNumber: r.runNumber ?? undefined,
    questionText: r.input?.query ?? "",
    expectedResults,
    traceId: r.traceId ?? undefined,
    isSmokeTestVariant: r.isSmokeTestVariant,
    smokeTestVariantText: r.smokeTestVariantText ?? undefined,
    latencyMs: r.latencyMs ?? undefined,
    inputTokens: r.inputTokens ?? undefined,
    outputTokens: r.outputTokens ?? undefined,
    vectorSimilarity: r.vectorSimilarity ?? undefined,
    jaccardSimilarity: r.jaccardSimilarity ?? undefined,
    bleuScore: r.bleuScore ?? undefined,
    rougeScore: r.rougeScore ?? undefined,
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
    results: includeResults ? results.map(r => toResultWire(r, evaluationSettings?.questions, dataset?.questions)) : [],
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
