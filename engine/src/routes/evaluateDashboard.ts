import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { handleCasePreview, handleSuggestExpected, handleAddCase } from "./curationHandlers.js";
import { validatePromptProposal, validateToolSchemaProposal } from "../core/evaluate/proposalValidation.js";
import {
  listImprovementProposals,
  dismissImprovementProposal,
  publishImprovementProposal,
  sweepImprovementsOnce,
} from "../core/evaluate/improvementSweep.js";
import type { Db } from "../storage/db.js";
import { scopedDb } from "../auth/apiKey.js";
import {
  createDataset,
  getDataset,
  listDatasets,
  updateDataset,
  extractSimilarityConfig,
  extractCodeScorers,
  type SimilarityConfig,
} from "../core/evaluate/datasets.js";
import type { CodeScorerConfig } from "../core/evaluate/codeScorer.js";
import {
  createEvaluationSettings,
  getEvaluationSettingsRow,
  updateEvaluationSettings,
  patchEvaluationSettings,
  listStandaloneEvaluationSettings,
} from "../core/evaluate/evaluationSettings.js";
import {
  listDatasetVersions,
  getDatasetVersionCounts,
  deleteDatasetVersion,
  listEvaluationSettingsVersions,
  getEvaluationSettingsVersionCounts,
  deleteEvaluationSettingsVersion,
} from "../core/evaluate/versions.js";
import {
  getRunRowFull,
  getRunResults,
  listRunRows,
  getVersionComparison,
  compareRuns,
  listGateResults,
  previewLatestRunGate,
  type FullRunRow,
  type RunResultRow,
} from "../core/evaluate/runs.js";
import {
  createAgentConnector,
  listAgentConnectorsWire,
  updateAgentConnector,
  deleteAgentConnector,
  getAgentConnectorRow,
  testAgentConnectorConnection,
} from "../core/evaluate/agentConnectors.js";
import { startConnectorRun } from "../core/evaluate/connectorRun.js";
import {
  createToolSchema,
  listToolSchemasWire,
  getToolSchemaWithVersionsWire,
  publishToolSchemaVersion,
  getToolFailureExamples,
  proposeToolSchemaImprovement,
  listUnregisteredTools,
  deleteToolSchema,
  updateToolSchemaTestEndpoint,
  updateToolSchemaMeta,
} from "../core/evaluate/toolSchemas.js";
import { runPlayground, extractPlaygroundTools, callPlaygroundTool } from "../core/evaluate/playground.js";
import { runConversationSimulation } from "../core/evaluate/simulation.js";
import { generateSyntheticCases } from "../core/evaluate/synthesize.js";
import { loadMcpTools } from "../core/evaluate/mcp.js";
import {
  createPlaygroundRun,
  updatePlaygroundRunResults,
  listPlaygroundRuns,
  getPlaygroundRun,
  deletePlaygroundRun,
} from "../core/evaluate/playgroundRuns.js";
import {
  createPrompt,
  listPromptsWire,
  getPromptWithVersionsWire,
  publishPromptVersion,
  proposePromptImprovement,
  getWorstRatedExamples,
  getFailureThemes,
  deletePrompt,
  updatePromptMeta,
} from "../core/evaluate/prompts.js";
import {
  runEvaluationAnalysis,
  getEvaluationAnalysisStatus,
  getEvaluationAnalysisMetrics,
  getEvaluationAnalysisRow,
} from "../core/evaluate/analysis.js";
import type { MonitoringWindow } from "../core/monitor/events.js";

// Same convention as agentMonitoringDashboard.ts's parseWindow - not shared across route files,
// each route file is self-contained.
function parseWindow(req: Request): MonitoringWindow {
  const raw = req.query.window ?? req.body?.window;
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

// Mounted at /api/v1/evaluate - the paths AgentX-web-front's Evaluate tab (Governance ->
// EvaluateTab.tsx's "Runs" and "Datasets" sub-views) actually calls (src/data/apiPaths.ts's
// getAllEvaluations/getEvaluationById/getAllEvaluationSettings/createEvaluationSettings/
// updateEvaluationSettings), a different dialect from the SDK-facing /api/v1/custom-agent-
// evaluations router (routes/evaluations.ts): same underlying core logic, different response
// envelope/query params, same convention as agentMonitoringDashboard.ts.
//
// Scope for this pass: Datasets CRUD (list/get/create/update), the standalone "Evaluator" sub-tab
// (a grading config with no dataset attached - POST /evaluationSettings/create-standalone below;
// distinct from the dataset+settings twin getMergedEvaluationSettings merges), and a flat Runs
// list/detail. Similarity metrics (vectorSimilarity/jaccard/bleu/rouge) and Sovereignty &
// Portability model comparison are accepted on both dataset and standalone-config payloads but not
// acted on, same as core/evaluate/datasets.ts's CreateDatasetInput - out of scope for this pass,
// see plan task #109. Dataset/config edit-history version tracking IS built (core/evaluate/
// versions.ts, the /versions routes below) - real snapshots, real diffs, real deletes. Still not
// built: anything tied to AgentX's native agent-building/config-branching system
// (agentConfigVersion, robotConfigBranch, evaluationSettingsConfigVersion, datasetConfigVersion,
// agent/team-scoped run endpoints) - self-host has no agent/team registry or config-branching, so
// those fields are simply omitted rather than faked, and pinning a run to the exact edit-history
// version it graded against is a separate, not-yet-built feature from the edit history itself. See
// README's Status section.
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
// merged into one EvaluationSettings-shaped wire object - mirrors the hosted SaaS's
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
    codeScorers: (settingsRow!.codeScorers as CodeScorerConfig[] | null) ?? undefined,
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
// configs (no dataset twin - see listStandaloneEvaluationSettings), "all" (default) merges both,
// matching AgentX-web-front's EvaluationSettingsKind contract exactly (useGetAllEvaluationSettings.ts).
evaluateDashboardRouter.get("/evaluationSettings", async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const kind = req.query.kind;
  let all: unknown[];
  if (kind === "config") {
    all = await listStandaloneConfigsWire(scopedDb(req));
  } else if (kind === "dataset") {
    all = await listMergedEvaluationSettings(scopedDb(req));
  } else {
    const [datasets, configs] = await Promise.all([listMergedEvaluationSettings(scopedDb(req)), listStandaloneConfigsWire(scopedDb(req))]);
    all = [...datasets, ...configs].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }
  const { page: evaluationSettings, pagination } = paginate(all, page, limit);
  res.status(200).json({ evaluationSettings, pagination });
});

// Edit history (core/evaluate/versions.ts) - one entry per save that actually changed a tracked
// field, plus one seeded at creation, so it's never empty right after a dataset/config is first
// made. /batch/versions must come before the /:id/versions route below: Express matches by full
// path shape (both are 2 segments after /evaluationSettings), so declaration order decides which
// one "/evaluationSettings/batch/versions" actually hits - kept first for that reason.
evaluateDashboardRouter.get("/evaluationSettings/batch/versions", async (req: Request, res: Response) => {
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
  const versionCounts = await getEvaluationSettingsVersionCounts(scopedDb(req), ids);
  res.status(200).json({ versionCounts });
});

evaluateDashboardRouter.get("/evaluationSettings/:id/versions", async (req: Request, res: Response) => {
  const versions = await listEvaluationSettingsVersions(scopedDb(req), req.params.id!);
  res.status(200).json(versions.map(v => ({ ...v, creator: LOCAL_USER })));
});

evaluateDashboardRouter.delete("/evaluationSettings/:id/versions/:versionId", async (req: Request, res: Response) => {
  const deleted = await deleteEvaluationSettingsVersion(scopedDb(req), req.params.id!, req.params.versionId!);
  res.status(200).json({ deleted });
});

// Same batch-before-:id ordering as /evaluationSettings/batch/versions above.
// Curation (production -> golden dataset): same three handlers the SDK-facing router mounts,
// see curationHandlers.ts. The dashboard's Add-to-dataset dialog calls these.
evaluateDashboardRouter.post("/datasets/case-preview", handleCasePreview);
evaluateDashboardRouter.post("/datasets/suggest-expected", handleSuggestExpected);
evaluateDashboardRouter.post("/datasets/:id/cases", handleAddCase);

evaluateDashboardRouter.get("/datasets/batch/versions", async (req: Request, res: Response) => {
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
  const versionCounts = await getDatasetVersionCounts(scopedDb(req), ids);
  res.status(200).json({ versionCounts });
});

evaluateDashboardRouter.get("/datasets/:id/versions", async (req: Request, res: Response) => {
  const versions = await listDatasetVersions(scopedDb(req), req.params.id!);
  res.status(200).json(versions.map(v => ({ ...v, creator: LOCAL_USER })));
});

evaluateDashboardRouter.delete("/datasets/:id/versions/:versionId", async (req: Request, res: Response) => {
  const deleted = await deleteDatasetVersion(scopedDb(req), req.params.id!, req.params.versionId!);
  res.status(200).json({ deleted });
});

// Not the same concept as the /versions routes above (that's dataset *edit* history). This is the
// external-agent analog to native autotune's baseline-vs-candidate comparison: group
// this dataset's runs by the version label their evaluationSubject was tagged with (see
// core/evaluate/runs.ts's extractVersion/getVersionComparison), average ratings per version, and
// report whether the most recent version beat the one before it.
evaluateDashboardRouter.get("/datasets/:datasetId/run-comparison", async (req: Request, res: Response) => {
  res.status(200).json(await getVersionComparison(scopedDb(req), req.params.datasetId!));
});

// Improvement Inbox: proposals the background sweep generated + validated on its own, awaiting
// human review. See core/evaluate/improvementSweep.ts for thresholds/cooldowns/spend caps.
evaluateDashboardRouter.get("/improve/inbox", async (req: Request, res: Response) => {
  res.status(200).json({ proposals: await listImprovementProposals(scopedDb(req)) });
});

evaluateDashboardRouter.post("/improve/inbox/:id/dismiss", async (req: Request, res: Response) => {
  const result = await dismissImprovementProposal(scopedDb(req), req.params.id!);
  if (!result) {
    res.status(404).json({ error: "No pending proposal with that id" });
    return;
  }
  res.status(200).json({ proposal: result });
});

evaluateDashboardRouter.post("/improve/inbox/:id/publish", async (req: Request, res: Response) => {
  const result = await publishImprovementProposal(scopedDb(req), req.params.id!);
  if (!result) {
    res.status(404).json({ error: "No pending proposal with that id" });
    return;
  }
  res.status(200).json({ proposal: result });
});

// Manual trigger, scoped to the caller's project - the demo/test path, and the escape hatch when
// AGENTX_IMPROVEMENT_SWEEP=false disables the background interval.
evaluateDashboardRouter.post("/improve/inbox/sweep/run", async (req: Request, res: Response) => {
  res.status(200).json(await sweepImprovementsOnce(scopedDb(req)));
});

// CI Gates page: recorded gate history (real CI verdicts, written by the SDK-facing gate route
// with record=true) plus a compute-only preview of "would the latest run pass these thresholds".
evaluateDashboardRouter.get("/ci/gates", async (req: Request, res: Response) => {
  const db = scopedDb(req);
  const [gates, datasets] = await Promise.all([listGateResults(db), listDatasets(db)]);
  const nameById = new Map(datasets.map(d => [d._id, d.name]));
  res.status(200).json({
    gates: gates.map(g => ({
      _id: g.id,
      runId: g.runId,
      datasetId: g.datasetId,
      datasetName: nameById.get(g.datasetId) ?? g.datasetId,
      passed: g.passed,
      averageRating: g.averageRating,
      baselineAverage: g.baselineAverage,
      checks: g.checks,
      caller: g.caller,
      createdAt: g.createdAt,
    })),
  });
});

evaluateDashboardRouter.get("/ci/gates/preview", async (req: Request, res: Response) => {
  const { datasetId } = req.query;
  if (typeof datasetId !== "string" || !datasetId) {
    res.status(400).json({ error: "datasetId is required" });
    return;
  }
  const failUnderRaw = req.query.failUnder;
  const failUnder = typeof failUnderRaw === "string" && failUnderRaw !== "" ? Number(failUnderRaw) : null;
  const noRegression = req.query.noRegression === "true" || req.query.noRegression === "1";
  if (failUnder != null && !Number.isFinite(failUnder)) {
    res.status(400).json({ error: "failUnder must be a number" });
    return;
  }
  if (failUnder == null && !noRegression) {
    res.status(400).json({ error: "At least one check is required: failUnder and/or noRegression" });
    return;
  }
  const result = await previewLatestRunGate(scopedDb(req), datasetId, { failUnder, noRegression });
  if ("error" in result) {
    res.status(422).json(result);
    return;
  }
  res.status(200).json(result);
});

// Per-case drill-down under the aggregate verdict above: which cases exactly regressed between
// two runs of the same dataset, with both outputs. See core/evaluate/runs.ts's compareRuns.
evaluateDashboardRouter.get("/runs/compare", async (req: Request, res: Response) => {
  const { baseline, candidate } = req.query;
  if (typeof baseline !== "string" || typeof candidate !== "string" || !baseline || !candidate) {
    res.status(400).json({ error: "baseline and candidate run ids are required" });
    return;
  }
  const result = await compareRuns(scopedDb(req), baseline, candidate);
  if ("error" in result) {
    res.status(result.error === "Run not found" ? 404 : 400).json(result);
    return;
  }
  res.status(200).json(result);
});

// Agent Connectors (core/evaluate/agentConnectors.ts) - "how to invoke my deployed agent," a
// plain webhook config, same shape as Monitor's Custom Evaluators (core/monitor/customEvaluators.ts)
// but returning an answer instead of a verdict. Lets a dataset be run end to end from the
// dashboard (see run-with-connector below) instead of requiring a human to manually run the agent
// and push results via the SDK first.
evaluateDashboardRouter.get("/agent-connectors", async (req: Request, res: Response) => {
  res.status(200).json({ connectors: await listAgentConnectorsWire(scopedDb(req)) });
});

evaluateDashboardRouter.post("/agent-connectors", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (typeof body.url !== "string" || !body.url.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const connector = await createAgentConnector(scopedDb(req), {
    name: body.name,
    url: body.url,
    headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  });
  res.status(201).json({ connector });
});

evaluateDashboardRouter.put("/agent-connectors/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const connector = await updateAgentConnector(scopedDb(req), req.params.id!, {
    name: typeof body.name === "string" ? body.name : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  });
  if (!connector) {
    res.status(404).json({ error: "Agent connector not found" });
    return;
  }
  res.status(200).json({ connector });
});

evaluateDashboardRouter.delete("/agent-connectors/:id", async (req: Request, res: Response) => {
  const deleted = await deleteAgentConnector(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Agent connector not found" });
    return;
  }
  res.status(200).json({ success: true });
});

// "Test connection" (the dashboard's connector form) - a synthetic ping before the connector is
// ever used in a real run. Always 200s: testAgentConnectorConnection itself never throws, same
// posture as core/evaluate/models.ts's testCustomModelConnection.
evaluateDashboardRouter.post("/agent-connectors/test-connection", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.url !== "string" || !body.url.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const result = await testAgentConnectorConnection({
    url: body.url,
    headers: body.headers && typeof body.headers === "object" ? body.headers : null,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 30000,
  });
  res.status(200).json(result);
});

// Drives every question in a dataset through the given connector, scoring each result through the
// exact same pipeline an SDK-pushed run uses (core/evaluate/connectorRun.ts). Long-running (one
// real agent call per question) - fires and returns the new runId immediately; the dashboard
// polls the existing GET /:id route below for progress, same as it already does for an SDK-driven
// run in progress, no new polling infrastructure needed.
evaluateDashboardRouter.post("/datasets/:datasetId/run-with-connector", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.connectorId !== "string" || !body.connectorId.trim()) {
    res.status(400).json({ error: "connectorId is required" });
    return;
  }
  const connector = await getAgentConnectorRow(scopedDb(req), body.connectorId);
  if (!connector) {
    res.status(404).json({ error: "Agent connector not found" });
    return;
  }
  const result = await startConnectorRun(scopedDb(req), req.params.datasetId!, body.connectorId);
  if (!result) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  res.status(202).json(result);
});

// Interactive Playground (core/evaluate/playground.ts) - run one (prompt, model, dataset
// question) combination for real and return it, no persistence, same "compute and return"
// posture as the portability routes below. One call per grid cell; the frontend fans a whole
// questions × models grid out to this single-cell endpoint itself rather than this route doing
// its own batch orchestration.
evaluateDashboardRouter.post("/playground/run", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.model !== "string" || !body.model.trim()) {
    res.status(400).json({ error: "model is required" });
    return;
  }
  if (typeof body.query !== "string" || !body.query.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: "messages must be an array" });
    return;
  }
  const extractIds = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const ids = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return ids.length > 0 ? ids : undefined;
  };
  const result = await runPlayground(scopedDb(req), {
    model: body.model,
    messages: body.messages,
    query: body.query,
    expected: typeof body.expected === "string" ? body.expected : undefined,
    judgeGuideline: typeof body.judgeGuideline === "string" ? body.judgeGuideline : undefined,
    judgeCriteria: body.judgeCriteria && typeof body.judgeCriteria === "object" ? body.judgeCriteria : undefined,
    codeScorers: extractCodeScorers(body),
    tools: extractPlaygroundTools(body),
    patternIds: extractIds(body.patternIds),
    onlineEvaluatorIds: extractIds(body.onlineEvaluatorIds),
    maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
  });
  res.status(200).json(result);
});

// Synthetic golden-case generation (core/evaluate/synthesize.ts): paste a source document, get
// grounded test cases back for review - compute-and-return, the dashboard appends kept cases via
// the normal dataset update.
evaluateDashboardRouter.post("/synthesize-cases", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.sourceText !== "string" || !body.sourceText.trim()) {
    res.status(400).json({ error: "sourceText is required" });
    return;
  }
  try {
    const result = await generateSyntheticCases(scopedDb(req), {
      sourceText: body.sourceText,
      count: typeof body.count === "number" ? body.count : 5,
      guidance: typeof body.guidance === "string" ? body.guidance : undefined,
      // Optional: an existing dataset to few-shot style from (absent in create-dataset mode).
      datasetId: typeof body.datasetId === "string" && body.datasetId ? body.datasetId : undefined,
    });
    if ("error" in result) {
      res.status(422).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Case generation failed" });
  }
});

// Conversation simulation (core/evaluate/simulation.ts): a simulated user (persona + goal)
// converses with the Playground's current prompt/model/tools for up to maxTurns; each turn is
// recorded through the real ingest path under one sim-<id> session unless record=false. Bounded
// and synchronous (turn cap + per-call timeouts), same "compute and return" posture as
// /playground/run above.
evaluateDashboardRouter.post("/playground/simulate", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.model !== "string" || !body.model.trim()) {
    res.status(400).json({ error: "model is required" });
    return;
  }
  if (typeof body.persona !== "string" || !body.persona.trim()) {
    res.status(400).json({ error: "persona is required" });
    return;
  }
  if (typeof body.goal !== "string" || !body.goal.trim()) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: "messages must be an array" });
    return;
  }
  const simulationInput = {
    model: body.model,
    messages: body.messages,
    persona: body.persona,
    goal: body.goal,
    maxTurns: typeof body.maxTurns === "number" ? body.maxTurns : undefined,
    userModel: typeof body.userModel === "string" ? body.userModel : undefined,
    tools: extractPlaygroundTools(body),
    evaluationSettingsId:
      typeof body.evaluationSettingsId === "string" && body.evaluationSettingsId.trim()
        ? body.evaluationSettingsId
        : undefined,
    agentName: typeof body.agentName === "string" ? body.agentName : undefined,
    record: body.record !== false,
    maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
  };

  // stream: true - Server-Sent Events so the dashboard renders the conversation turn by turn as
  // it happens ({type:"turn"} per completed exchange, one final {type:"result"}). The plain JSON
  // response below stays for the SDK/back-compat.
  if (body.stream === true) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      const result = await runConversationSimulation(scopedDb(req), simulationInput, callPlaygroundTool, (turn, index) =>
        send({ type: "turn", turn, index })
      );
      send({ type: "result", result });
    } catch (err) {
      send({ type: "error", error: err instanceof Error ? err.message.slice(0, 300) : "Simulation failed" });
    }
    res.end();
    return;
  }

  const result = await runConversationSimulation(scopedDb(req), simulationInput, callPlaygroundTool);
  res.status(200).json(result);
});

// Playground's own run history (core/evaluate/playgroundRuns.ts) - a persistence layer next to,
// not inside, /playground/run above: lets the dashboard survive a refresh and browse past runs
// without turning a single model call into a persisted resource. No workspaceId - self-host has
// no real multi-tenant concept (see playgroundRuns.ts's header comment).
evaluateDashboardRouter.post("/playground/runs", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.snapshot || typeof body.snapshot !== "object") {
    res.status(400).json({ error: "snapshot is required" });
    return;
  }
  const promptId = typeof body.promptId === "string" && body.promptId.trim() ? body.promptId : null;
  // kind "simulation" stores a Simulate-conversation transcript in the same history log; results
  // may then be sent inline (a simulation is complete when saved, unlike a streaming grid).
  const kind = body.kind === "simulation" ? ("simulation" as const) : ("grid" as const);
  const results = body.results && typeof body.results === "object" ? body.results : {};
  const created = await createPlaygroundRun(scopedDb(req), body.snapshot, promptId, kind, results);
  res.status(201).json({ _id: created.id, createdAt: created.createdAt });
});

evaluateDashboardRouter.patch("/playground/runs/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.results || typeof body.results !== "object") {
    res.status(400).json({ error: "results is required" });
    return;
  }
  await updatePlaygroundRunResults(scopedDb(req), req.params.id!, body.results);
  res.status(200).json({ ok: true });
});

evaluateDashboardRouter.get("/playground/runs", async (req: Request, res: Response) => {
  const runs = await listPlaygroundRuns(scopedDb(req));
  res.status(200).json({ runs });
});

evaluateDashboardRouter.get("/playground/runs/:id", async (req: Request, res: Response) => {
  const run = await getPlaygroundRun(scopedDb(req), req.params.id!);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json(run);
});

evaluateDashboardRouter.delete("/playground/runs/:id", async (req: Request, res: Response) => {
  const deleted = await deletePlaygroundRun(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.status(200).json({ deleted: true });
});

// Prompt registry dashboard routes (core/evaluate/prompts.ts) - the external-agent analog to
// native autotune's config-mutation step: AgentX doesn't own the agent's code, so instead of
// branching/applying a RobotConfig, it becomes the prompt's source of truth (see LangSmith Prompt
// Hub / Langfuse Prompt Management), and a human approves every write. Registered before the
// catch-all GET "/:id" route below so "/prompts" (a bare list) isn't swallowed by it.
evaluateDashboardRouter.get("/prompts", async (req: Request, res: Response) => {
  res.status(200).json({ prompts: await listPromptsWire(scopedDb(req)) });
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
  const prompt = await createPrompt(scopedDb(req), { name, text, description });
  res.status(201).json(prompt);
});

// Tool/skill schema registry (core/evaluate/toolSchemas.ts) - the Prompt Registry's routes
// mirrored for tool definitions. Same "the only write path for a new version is the explicit
// human-triggered versions POST" rule as prompts.
evaluateDashboardRouter.get("/tool-schemas", async (req: Request, res: Response) => {
  res.status(200).json({ toolSchemas: await listToolSchemasWire(scopedDb(req)) });
});

evaluateDashboardRouter.post("/tool-schemas", async (req: Request, res: Response) => {
  const { name, definition, description, testEndpointUrl } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required (must match the traced tool-call name exactly)" });
    return;
  }
  if (typeof definition !== "string" || !definition.trim()) {
    res.status(400).json({ error: "definition is required" });
    return;
  }
  if (testEndpointUrl !== undefined && testEndpointUrl !== null && testEndpointUrl !== "" && !isHttpUrl(testEndpointUrl)) {
    res.status(400).json({ error: "testEndpointUrl must be an http(s) URL" });
    return;
  }
  const toolSchema = await createToolSchema(scopedDb(req), {
    name: name.trim(),
    definition,
    description,
    testEndpointUrl: typeof testEndpointUrl === "string" ? testEndpointUrl : undefined,
  });
  res.status(201).json(toolSchema);
});

// Set or clear a registered tool's Playground test endpoint - the one mutable field outside the
// versioned definition. Null/empty clears it.
// Metadata edits (description / test endpoint) from the tool detail dialog - never touches the
// version log; definition changes go through POST /tool-schemas/:id/versions.
evaluateDashboardRouter.patch("/tool-schemas/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const input: { description?: string | null; testEndpointUrl?: string | null } = {};
  if ("description" in body) {
    input.description = typeof body.description === "string" ? body.description : null;
  }
  if ("testEndpointUrl" in body) {
    if (typeof body.testEndpointUrl === "string" && body.testEndpointUrl.trim() && !isHttpUrl(body.testEndpointUrl)) {
      res.status(400).json({ error: "testEndpointUrl must be an http(s) URL" });
      return;
    }
    input.testEndpointUrl = typeof body.testEndpointUrl === "string" ? body.testEndpointUrl : null;
  }
  const ok = await updateToolSchemaMeta(scopedDb(req), req.params.id!, input);
  if (!ok) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(200).json({ ok: true });
});

evaluateDashboardRouter.patch("/tool-schemas/:id/test-endpoint", async (req: Request, res: Response) => {
  const raw = req.body?.testEndpointUrl;
  if (raw !== undefined && raw !== null && raw !== "" && !isHttpUrl(raw)) {
    res.status(400).json({ error: "testEndpointUrl must be an http(s) URL" });
    return;
  }
  const updated = await updateToolSchemaTestEndpoint(scopedDb(req), req.params.id!, typeof raw === "string" ? raw : null);
  if (!updated) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(200).json(updated);
});

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Remote MCP introspection for Register Tool (core/evaluate/mcp.ts): connect, tools/list, hand
// the shapes back for review. headers = the dialog's key-value pairs (sent as HTTP headers -
// the only channel a remote server has). Nothing is registered by this route; the dialog
// registers the reviewed selection through the ordinary POST /tool-schemas.
evaluateDashboardRouter.post("/mcp/tools", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.serverUrl !== "string" || !body.serverUrl.trim()) {
    res.status(400).json({ error: "serverUrl is required" });
    return;
  }
  const headers: Record<string, string> = {};
  if (Array.isArray(body.headers)) {
    for (const pair of body.headers) {
      if (pair && typeof pair === "object" && typeof pair.key === "string" && pair.key.trim() && typeof pair.value === "string") {
        headers[pair.key.trim()] = pair.value;
      }
    }
  }
  // The OAuth redirect URI must be browser-reachable: explicit AGENTX_PUBLIC_URL wins (proxied
  // deployments), else the origin this request arrived on (localhost self-host).
  const base = process.env.AGENTX_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`;
  const result = await loadMcpTools({
    serverUrl: body.serverUrl,
    headers,
    callbackUrl: `${base.replace(/\/$/, "")}/api/v1/mcp-oauth/callback`,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
  });
  if ("error" in result) {
    res.status(502).json(result);
    return;
  }
  res.status(200).json(result);
});

// Registered BEFORE /tool-schemas/:id so "unregistered" isn't captured as an id. See
// core/evaluate/toolSchemas.ts's listUnregisteredTools - the on-ramp for tools already failing
// in traffic that nobody has registered yet.
evaluateDashboardRouter.get("/tool-schemas/unregistered", async (req: Request, res: Response) => {
  const windowDays = req.query.window === "24h" ? 1 : req.query.window === "30d" ? 30 : 7;
  res.status(200).json({ unregistered: await listUnregisteredTools(scopedDb(req), windowDays) });
});

evaluateDashboardRouter.get("/tool-schemas/:id", async (req: Request, res: Response) => {
  const toolSchema = await getToolSchemaWithVersionsWire(scopedDb(req), req.params.id!);
  if (!toolSchema) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(200).json(toolSchema);
});

evaluateDashboardRouter.post("/tool-schemas/:id/versions", async (req: Request, res: Response) => {
  const { definition, source, reasoning, basedOnVersion, resolvedExampleIds } = req.body ?? {};
  if (typeof definition !== "string" || !definition.trim()) {
    res.status(400).json({ error: "definition is required" });
    return;
  }
  const toolSchema = await publishToolSchemaVersion(scopedDb(req), req.params.id!, {
    definition,
    source: source === "proposed" ? "proposed" : "manual",
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
    basedOnVersion: typeof basedOnVersion === "number" ? basedOnVersion : undefined,
    resolvedExampleIds: Array.isArray(resolvedExampleIds)
      ? resolvedExampleIds.filter((id: unknown): id is string => typeof id === "string")
      : undefined,
  });
  if (!toolSchema) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(201).json(toolSchema);
});

// Same ?window=24h|7d|30d convention as the prompt-examples route - mapped to days here since
// toolSchemas.ts's evidence gathering takes a day count directly.
const toolSchemaWindowDays = (req: Request): number => {
  const raw = req.query.window;
  return raw === "24h" ? 1 : raw === "30d" ? 30 : 7;
};

evaluateDashboardRouter.get("/tool-schemas/:id/examples", async (req: Request, res: Response) => {
  const result = await getToolFailureExamples(scopedDb(req), req.params.id!, toolSchemaWindowDays(req));
  if (!result) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(200).json(result);
});

evaluateDashboardRouter.post("/tool-schemas/:id/propose", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const exampleIds = Array.isArray(body.exampleIds)
    ? body.exampleIds.filter((id: unknown): id is string => typeof id === "string")
    : undefined;
  try {
    const result = await proposeToolSchemaImprovement(scopedDb(req), req.params.id!, {
      windowDays: body.window === "24h" ? 1 : body.window === "30d" ? 30 : 7,
      exampleIds,
    });
    if (!result) {
      res.status(404).json({ error: "Tool schema not found" });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Proposal failed" });
  }
});

// Propose -> VALIDATE -> publish: run a proposal's candidate definition against real queries
// (dataset cases, or this tool's own production failure evidence) on both the current and the
// candidate definition, and return the measured comparison. See proposalValidation.ts.
evaluateDashboardRouter.post("/tool-schemas/:id/proposals/validate", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.candidateDefinition !== "string" || !body.candidateDefinition.trim()) {
    res.status(400).json({ error: "candidateDefinition is required" });
    return;
  }
  try {
    const result = await validateToolSchemaProposal(scopedDb(req), req.params.id!, {
      candidateDefinition: body.candidateDefinition,
      datasetId: typeof body.datasetId === "string" && body.datasetId ? body.datasetId : undefined,
      model: typeof body.model === "string" && body.model ? body.model : undefined,
      maxCases: typeof body.maxCases === "number" ? body.maxCases : undefined,
    });
    if ("error" in result) {
      res.status(422).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Validation failed" });
  }
});

evaluateDashboardRouter.delete("/tool-schemas/:id", async (req: Request, res: Response) => {
  const deleted = await deleteToolSchema(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Tool schema not found" });
    return;
  }
  res.status(200).json({ success: true });
});

// Metadata edits (description) from the prompt detail dialog - mirrors PATCH /tool-schemas/:id.
evaluateDashboardRouter.patch("/prompts/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const input: { description?: string | null } = {};
  if ("description" in body) {
    input.description = typeof body.description === "string" ? body.description : null;
  }
  const ok = await updatePromptMeta(scopedDb(req), req.params.id!, input);
  if (!ok) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json({ ok: true });
});

evaluateDashboardRouter.get("/prompts/:id", async (req: Request, res: Response) => {
  const prompt = await getPromptWithVersionsWire(scopedDb(req), req.params.id!);
  if (!prompt) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json(prompt);
});

// Manual edit and accept-a-proposal both land here - the only write path for a new version, so
// a judge-proposed rewrite never reaches storage without this explicit human-triggered call.
evaluateDashboardRouter.post("/prompts/:id/versions", async (req: Request, res: Response) => {
  const { text, source, reasoning, basedOnVersion } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const prompt = await publishPromptVersion(scopedDb(req), req.params.id!, {
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
// do its own reasoning instead of this engine's - see core/evaluate/prompts.ts's
// getWorstRatedExamples for why this is a real evidence feed rather than a second stub.
evaluateDashboardRouter.get("/prompts/:id/examples", async (req: Request, res: Response) => {
  const datasetId = req.query.datasetId;
  const gathered = await getWorstRatedExamples(scopedDb(req), req.params.id!, {
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
    const result = await getFailureThemes(scopedDb(req), req.params.id!, {
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

// Never writes on its own - returns a suggestion for the dashboard to show, which the human then
// accepts via POST /prompts/:id/versions (source: "proposed") or discards outright.
// Prompt twin of /tool-schemas/:id/proposals/validate above: candidate system prompt vs the
// current published version, graded against a golden dataset's cases (multi-turn cases played
// in full) with that dataset's own judge config. See proposalValidation.ts.
evaluateDashboardRouter.post("/prompts/:id/proposals/validate", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.candidateText !== "string" || !body.candidateText.trim()) {
    res.status(400).json({ error: "candidateText is required" });
    return;
  }
  if (typeof body.datasetId !== "string" || !body.datasetId) {
    res.status(400).json({ error: "datasetId is required" });
    return;
  }
  try {
    const result = await validatePromptProposal(scopedDb(req), req.params.id!, {
      candidateText: body.candidateText,
      datasetId: body.datasetId,
      model: typeof body.model === "string" && body.model ? body.model : undefined,
      maxCases: typeof body.maxCases === "number" ? body.maxCases : undefined,
    });
    if ("error" in result) {
      res.status(422).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Validation failed" });
  }
});

evaluateDashboardRouter.post("/prompts/:id/propose", async (req: Request, res: Response) => {
  const { datasetId, includeAllVersions, exampleIds } = req.body ?? {};
  try {
    const proposal = await proposePromptImprovement(scopedDb(req), req.params.id!, {
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
    // callJudgeJson throws a clear setup error for that) - surfaced to the dialog instead of
    // hanging or 500ing opaquely.
    res.status(422).json({ error: err instanceof Error ? err.message : "Unable to generate a proposal" });
  }
});

evaluateDashboardRouter.delete("/prompts/:id", async (req: Request, res: Response) => {
  const deleted = await deletePrompt(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Prompt not found" });
    return;
  }
  res.status(200).json({ success: true });
});

// Self-host's own "Analyze" - one synchronous judge call, not the hosted SaaS's multi-judge job
// pipeline. See core/evaluate/analysis.ts's top comment for the full scope explanation. Always
// "completed" (or "failed") by the time this returns, since there's no background job to poll.
evaluateDashboardRouter.post("/analyze/:id", async (req: Request, res: Response) => {
  const { judges, qualityMode } = req.body ?? {};
  try {
    const result = await runEvaluationAnalysis(scopedDb(req), req.params.id!, {
      judges: Array.isArray(judges)
        ? judges.filter((j: unknown): j is { model: string } => !!j && typeof (j as { model?: unknown }).model === "string")
        : undefined,
      qualityMode: qualityMode === "quality_first" ? "quality_first" : "balanced",
    });
    if (!result) {
      res.status(404).json({ error: "Evaluation not found" });
      return;
    }
    res.status(200).json({
      evaluationId: result.evaluationId,
      jobId: result.evaluationId,
      status: result.status,
      mode: "sync",
      qualityMode: qualityMode === "quality_first" ? "quality_first" : "balanced",
    });
  } catch (err) {
    // Most commonly a missing OPENAI_API_KEY/ANTHROPIC_API_KEY (core/evaluate/judge.ts's
    // callJudgeJson throws a clear setup error for that) - surfaced to the panel instead of
    // hanging or 500ing opaquely.
    res.status(422).json({ error: err instanceof Error ? err.message : "Unable to analyze the evaluation results" });
  }
});

evaluateDashboardRouter.get("/analyze/:id/status", async (req: Request, res: Response) => {
  const status = await getEvaluationAnalysisStatus(scopedDb(req), req.params.id!);
  res.status(200).json(status);
});

evaluateDashboardRouter.get("/analyze/:id/metrics", async (req: Request, res: Response) => {
  const metrics = await getEvaluationAnalysisMetrics(scopedDb(req), req.params.id!);
  if (!metrics) {
    res.status(404).json({ error: "No analysis found for this evaluation" });
    return;
  }
  res.status(200).json(metrics);
});

evaluateDashboardRouter.get("/evaluationSettings/:id", async (req: Request, res: Response) => {
  const settings = await getMergedEvaluationSettings(scopedDb(req), req.params.id!);
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
    codeScorers: extractCodeScorers(body),
    acceptanceCriteria: body.acceptanceCriteria as string | undefined,
    rejectionCriteria: body.rejectionCriteria as string | undefined,
    evaluationCriteria: body.evaluationCriteria as string | undefined,
  };
  const [datasetWire] = await Promise.all([
    createDataset(scopedDb(req), { ...shared, questions }),
    createEvaluationSettings(scopedDb(req), shared),
  ]);
  res.status(201).json({ ...datasetWire, creator: LOCAL_USER });
});

// A standalone, reusable grading config - no dataset/questions attached, no twin (see this file's
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
  const settings = await createEvaluationSettings(scopedDb(req), {
    name: body.name as string,
    description: body.description as string | undefined,
    numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
    similarityConfig: extractSimilarityConfig(body),
    codeScorers: extractCodeScorers(body),
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
  // payloads like `{ isDefault: true }` from "Make default" - see patchEvaluationSettings's
  // comment for why that needs sparse-merge semantics instead of updateEvaluationSettings's full
  // replace). Branch on whether a dataset row actually exists for this id.
  const existingDataset = await getDataset(scopedDb(req), id);
  if (!existingDataset) {
    const updated = await patchEvaluationSettings(scopedDb(req), id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: body.description as string | undefined,
      numberOfRequests: typeof body.numberOfRequests === "number" ? body.numberOfRequests : undefined,
      similarityConfig: extractSimilarityConfig(body),
      codeScorers: extractCodeScorers(body),
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
    codeScorers: extractCodeScorers(body),
    acceptanceCriteria: body.acceptanceCriteria as string | undefined,
    rejectionCriteria: body.rejectionCriteria as string | undefined,
    evaluationCriteria: body.evaluationCriteria as string | undefined,
  };
  const [datasetWire] = await Promise.all([
    updateDataset(scopedDb(req), id, { ...shared, questions }),
    updateEvaluationSettings(scopedDb(req), id, shared),
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
// dataset's questions - needed because a standalone grading config (evaluationSettings/create-
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
    codeScorerResults: r.codeScorerResults ?? undefined,
  };
}

// includeResults controls only whether the raw per-question array is embedded in the response
// (the list endpoint omits it, same as the hosted SaaS does for scale reasons) - liveStatistics is
// always computed from the real result rows regardless, since the table's rating column reads
// liveStatistics.averageRating, not results.length, and a rating of exactly 0 (e.g. an errored
// result) must not be treated as "no rating yet" (0 !== null).
async function toEvaluateWire(db: Db, run: FullRunRow, includeResults: boolean) {
  const [dataset, evaluationSettings, results, analysisRow] = await Promise.all([
    getDataset(db, run.datasetId),
    getMergedEvaluationSettings(db, run.evaluationSettingsId ?? run.datasetId),
    getRunResults(db, run.id),
    getEvaluationAnalysisRow(db, run.id),
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
    // Frontend's AnalysisPanel reads this straight off the evaluation object (evaluation.analysis),
    // not off the /analyze/:id/status or /metrics endpoints - those only drive polling and the
    // judge-evidence table. See core/evaluate/analysis.ts's top comment for what's in/out of scope.
    analysis: analysisRow
      ? {
          evaluationId: analysisRow.evaluationId,
          query: "",
          statistics: analysisRow.statistics ?? { numberOfRuns: 0, averageRating: 0, minRating: 0, maxRating: 0, ratingVariance: 0 },
          analysis: analysisRow.analysis ?? undefined,
          status: analysisRow.status,
        }
      : undefined,
    evaluationSubject: run.evaluationSubject ?? undefined,
    runSource: run.runSource ?? "sdk",
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
  };
}

evaluateDashboardRouter.get("/list", async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const allRows = await listRunRows(scopedDb(req));
  const { page: rows, pagination } = paginate(allRows, page, limit);
  const evaluations = await Promise.all(rows.map(run => toEvaluateWire(scopedDb(req), run, false)));
  res.status(200).json({ evaluations, pagination: { ...pagination, limit } });
});

evaluateDashboardRouter.get("/:id", async (req: Request, res: Response) => {
  const run = await getRunRowFull(scopedDb(req), req.params.id!);
  if (!run) {
    res.status(404).json({ error: "Evaluation not found" });
    return;
  }
  const evaluation = await toEvaluateWire(scopedDb(req), run, true);
  res.status(200).json(evaluation);
});
