import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { getDb, type Db } from "../storage/db.js";
import { scopedDb } from "../auth/apiKey.js";
import { createPattern, updatePattern, deletePattern, listPatternsWire, legacyPayloadToConditions } from "../core/monitor/patterns.js";
import { BUILT_IN_MONITOR_PATTERNS, builtInPatternsWire } from "../core/monitor/detect.js";
import { validateConditionRegexes } from "../core/monitor/regexSafety.js";
import { listSignals, getSignal, updateSignal, signalCountsByPatternKey } from "../core/monitor/signals.js";
import { updateProfile, listProfilesWire } from "../core/monitor/profiles.js";
import {
  listAgentsWire,
  createAgent,
  getAgent,
  getAgentNamesById,
  resolveAgentId,
  resolveExistingAgentId,
  resolveAgentIds,
} from "../core/monitor/agents.js";
import { getPerformance } from "../core/monitor/performance.js";
import { getAttentionDigest } from "../core/monitor/attention.js";
import { createFeedback, listFeedbackForSignal } from "../core/monitor/feedback.js";
import { generateRegex, suggestHumanFeedback, suggestExpectedResults } from "../core/monitor/suggestions.js";
import {
  getKpis,
  getTrend,
  getTopFailing,
  getOnlineEvaluatorRatings,
  getOnlineEvaluatorEvents,
  getCustomEvaluatorEvents,
  listTraceEvaluations,
  type MonitoringWindow,
  getScorerActivity,
} from "../core/monitor/events.js";
import { getTopicsTrend, getTopIntents, getIssueBreakdown, getTopicsMap } from "../core/monitor/topics.js";
import { getJudgeCalibration } from "../core/monitor/outcomeCalibration.js";
import { getEvaluatorCalibration, proposeJudgeTuning, validateJudgeTuning } from "../core/monitor/judgeTuning.js";
import { getModelComparison } from "../core/monitor/modelComparison.js";
import { listSessionScores } from "../core/monitor/sessionScores.js";
import { listSessions } from "../core/monitor/sessions.js";
import {
  sweepSessionsOnce,
  runSessionBaselineCheck,
  runSessionEvaluatorCheck,
  isSessionScoreFresh,
} from "../core/monitor/sessionSweep.js";
import { getCostTrend, listUnpricedModels } from "../core/monitor/cost.js";
import { listDatasets, createDataset, updateDataset } from "../core/evaluate/datasets.js";
import {
  createOnlineEvaluator,
  updateOnlineEvaluator,
  deleteOnlineEvaluator,
  listOnlineEvaluatorsWire,
  getOnlineEvaluatorRow,
  InvalidEvaluationSettingsIdError,
  ReferenceCentricScorerError,
} from "../core/monitor/onlineEvaluators.js";
import {
  BuiltinJudgeScorerError,
  createJudgeScorer,
  deleteJudgeScorer,
  getJudgePreviewContext,
  getJudgeScorer,
  listJudgeScorers,
  previewJudgeScore,
  updateJudgeScorer,
  type JudgeScorerOnlineInput,
} from "../core/monitor/judgeScorers.js";
import { patchEvaluationSettings } from "../core/evaluate/evaluationSettings.js";
import {
  createCustomEvaluator,
  updateCustomEvaluator,
  deleteCustomEvaluator,
  listCustomEvaluatorsWire,
  callCustomEvaluator,
  type CustomEvaluatorRequest,
} from "../core/monitor/customEvaluators.js";
import { runScriptScorer } from "../core/monitor/scriptScorer.js";
import { getPortabilityPreview, runModelPortabilityCheck } from "../core/evaluate/portability.js";
import { getMonitorMetrics, parseMetricsRange } from "../core/monitor/metrics.js";
import {
  listPortabilityModels,
  createPortabilityModel,
  updatePortabilityModel,
  deletePortabilityModel,
  testCustomModelConnection,
} from "../core/evaluate/models.js";
import { getAppSettings, updateAppSettings } from "../core/settings/appSettings.js";
import {
  getProject,
  regenerateProjectApiKey,
  getMonitoringDefaults,
  updateMonitoringDefaults,
} from "../core/project/projects.js";
import { maskSecret } from "../core/shared/maskSecret.js";
import { validateSeverityParam } from "../core/shared/severity.js";
import { z } from "zod";
import { validateBody } from "./validateBody.js";
import { createRule, deleteRule, getRule, listRules, updateRule } from "../core/monitor/rules.js";
import {
  REVIEW_QUEUE_PENDING_CAP,
  deleteReviewItem,
  labelReviewItem,
  listReviewQueue,
  queueTraceForReview,
} from "../core/monitor/reviewQueue.js";
import { validateSampleRateParam } from "../core/shared/sampleRate.js";

// Mounted at /api/v1/agent-monitoring - the paths AgentX-web-front's dashboard actually calls
// (src/data/apiPaths.ts's getMonitoring*/*MonitoringProfile/*MonitoringPattern), a different
// dialect from the SDK-facing /api/v1/monitor router (routes/monitor.ts): same underlying core
// logic, different response envelope/query params to match what the dashboard's data hooks
// expect. Grown in slices: Observe-only (signals/patterns listing), AgentsTab + pattern CRUD,
// signal detail/triage/feedback + the two LLM-assist endpoints (regex generation, feedback
// drafting) + a credit-estimate stub (self-host has no billing, see /estimate below),
// create-evaluator-from-signal/suggest-expected-results (production-to-dataset, reusing
// core/evaluate/datasets.ts), kpis/trend/top-failing (core/monitor/events.ts's per-occurrence
// log), and online-evaluators (continuous judge scoring on sampled live traffic - LangSmith's
// actual "online evals", distinct from pattern-matching; no dashboard UI for this yet, backend
// only for now). Still out of scope: the autotune/"Improve" proposal system, tied to AgentX's
// native agent config-branching, which self-host doesn't have. See README's Status section.
export const agentMonitoringDashboardRouter = asyncRouter();

// Reject invalid severities once for every mutating route on this router (pattern / online
// evaluator / custom evaluator create+update, signal triage edits) - the dashboard's pickers
// already restrict to the four valid values, this closes the REST gap where any string produced
// signals the severity chips and filters can't render.
agentMonitoringDashboardRouter.use((req: Request, res: Response, next) => {
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const check = validateSeverityParam(req.body?.severity);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    // Same gap: routing.ts reads anything <= 0, or any non-number, as "never run" - a check that
    // shows enabled and never fires. See core/shared/sampleRate.ts.
    const sampleRate = validateSampleRateParam(req.body?.sampleRate);
    if (!sampleRate.ok) {
      res.status(400).json({ error: sampleRate.error });
      return;
    }
  }
  next();
});


// ---------------------------------------------------------------------------
// Automation rules (core/monitor/rules.ts): filter + sample + action. Rules ROUTE traffic (into
// the review queue, a dataset, or a webhook); scorers SCORE it. Keeping the two separate is why
// enabling a rule can never change what a judge costs.
// ---------------------------------------------------------------------------
const ruleFilterSchema = z
  .object({
    scopeMode: z.enum(["all", "selected"]).optional(),
    agentIds: z.array(z.string()).optional(),
    model: z.string().optional(),
    status: z.enum(["any", "error"]).optional(),
    contains: z.string().optional(),
  })
  .strip();

const ruleActionConfigSchema = z.object({ datasetId: z.string().optional(), url: z.string().url().optional() }).strip();

const createRuleSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    filter: ruleFilterSchema.optional(),
    sampleRate: z.number().min(0).max(1).optional(),
    action: z.enum(["review", "dataset", "webhook"]),
    actionConfig: ruleActionConfigSchema.optional(),
  })
  .strip();

const updateRuleSchema = createRuleSchema.partial().strip();

// An action whose config is missing is a rule that would silently do nothing every time it
// matches - refused at the door instead.
function ruleConfigError(action: string | undefined, config: { datasetId?: string; url?: string } | undefined) {
  if (action === "dataset" && !config?.datasetId) return "A dataset rule needs actionConfig.datasetId";
  if (action === "webhook" && !config?.url) return "A webhook rule needs actionConfig.url";
  return null;
}

agentMonitoringDashboardRouter.get("/rules", async (req: Request, res: Response) => {
  res.status(200).json({ rules: await listRules(scopedDb(req)) });
});

agentMonitoringDashboardRouter.post("/rules", validateBody(createRuleSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof createRuleSchema>;
  const configError = ruleConfigError(body.action, body.actionConfig);
  if (configError) {
    res.status(400).json({ error: configError });
    return;
  }
  res.status(201).json({ rule: await createRule(scopedDb(req), body) });
});

agentMonitoringDashboardRouter.put("/rules/:id", validateBody(updateRuleSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof updateRuleSchema>;
  const existing = await getRule(scopedDb(req), req.params.id!);
  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  const configError = ruleConfigError(
    body.action ?? existing.action,
    body.actionConfig ?? existing.actionConfig
  );
  if (configError) {
    res.status(400).json({ error: configError });
    return;
  }
  res.status(200).json({ rule: await updateRule(scopedDb(req), req.params.id!, body) });
});

agentMonitoringDashboardRouter.delete("/rules/:id", async (req: Request, res: Response) => {
  const deleted = await deleteRule(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Human-review queue (core/monitor/reviewQueue.ts): traces that raised no signal but still want a
// human verdict - sent by a person, or sampled by an automation rule. Signals reach Review on
// their own; these rows are how ordinary traffic gets labeled, and a label with a judge score
// beside it is a calibration pair.
// ---------------------------------------------------------------------------
agentMonitoringDashboardRouter.get("/review-queue", async (req: Request, res: Response) => {
  const { status, source, limit } = req.query;
  const result = await listReviewQueue(
    scopedDb(req),
    {
      status: typeof status === "string" ? status : undefined,
      source: typeof source === "string" ? source : undefined,
    },
    limit ? Math.min(Number(limit) || 100, 200) : 100
  );
  res.status(200).json(result);
});

const queueForReviewSchema = z
  .object({
    traceId: z.string().min(1),
    source: z.enum(["manual", "rule", "signal"]).optional(),
    note: z.string().optional(),
  })
  .strip();

agentMonitoringDashboardRouter.post(
  "/review-queue",
  validateBody(queueForReviewSchema),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof queueForReviewSchema>;
    const result = await queueTraceForReview(scopedDb(req), {
      traceId: body.traceId,
      source: body.source ?? "manual",
      note: body.note,
    });
    if (!result.ok) {
      // Each refusal is a distinct, actionable condition - never a silent success.
      const status = result.reason === "trace_not_found" ? 404 : result.reason === "already_queued" ? 409 : 429;
      const error =
        result.reason === "trace_not_found"
          ? "Trace not found"
          : result.reason === "already_queued"
            ? "That trace is already waiting for a verdict in the review queue"
            : `Review queue is full (${result.pending} pending, cap ${REVIEW_QUEUE_PENDING_CAP}) - label or dismiss some items first`;
      res.status(status).json({ error, reason: result.reason });
      return;
    }
    res.status(201).json({ item: result.item });
  }
);

const labelReviewSchema = z
  .object({
    label: z.enum(["good", "bad"]).optional(),
    correctedScore: z.number().min(0).max(10).nullable().optional(),
    note: z.string().optional(),
    status: z.enum(["pending", "labeled", "skipped"]).optional(),
  })
  .strip();

agentMonitoringDashboardRouter.patch(
  "/review-queue/:id",
  validateBody(labelReviewSchema),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof labelReviewSchema>;
    const item = await labelReviewItem(scopedDb(req), req.params.id!, {
      ...body,
      // Auth mode records who labeled it; disabled mode leaves it null rather than inventing a user.
      reviewedBy: (req as Request & { user?: { id?: string } }).user?.id ?? null,
    });
    if (!item) {
      res.status(404).json({ error: "Review item not found" });
      return;
    }
    res.status(200).json({ item });
  }
);

agentMonitoringDashboardRouter.delete("/review-queue/:id", async (req: Request, res: Response) => {
  const deleted = await deleteReviewItem(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Review item not found" });
    return;
  }
  res.status(204).end();
});

agentMonitoringDashboardRouter.get("/signals", async (req: Request, res: Response) => {
  const { severity, status, agentId, polarity, limit } = req.query;
  const signals = await listSignals(
    scopedDb(req),
    {
      severity: typeof severity === "string" ? severity : undefined,
      status: typeof status === "string" ? status : undefined,
      agentId: typeof agentId === "string" ? await resolveExistingAgentId(scopedDb(req), agentId) : undefined,
      polarity: typeof polarity === "string" ? polarity : undefined,
    },
    limit ? Math.min(Number(limit) || 50, 100) : 50
  );
  res.status(200).json({ signals });
});

// Overview's "Needs attention" digest - see core/monitor/attention.ts.
agentMonitoringDashboardRouter.get("/overview/attention", async (req: Request, res: Response) => {
  res.status(200).json(await getAttentionDigest(scopedDb(req)));
});

agentMonitoringDashboardRouter.get("/patterns", async (req: Request, res: Response) => {
  const [custom, defaults, signalCounts] = await Promise.all([
    listPatternsWire(scopedDb(req)),
    getMonitoringDefaults(scopedDb(req)),
    signalCountsByPatternKey(scopedDb(req)),
  ]);
  // The catalog's Signals column: attach per-key tallies to built-in and custom rows alike
  // (both key spaces are what signals record as patternKey).
  const withCounts = <T extends { key: string }>(row: T) => {
    const counts = signalCounts.get(row.key) ?? { total: 0, open: 0 };
    return { ...row, totalSignals: counts.total, openSignals: counts.open };
  };
  res.status(200).json({
    patterns: [...builtInPatternsWire(defaults.enabledBuiltinPatterns).map(withCounts), ...custom.map(withCounts)],
  });
});

agentMonitoringDashboardRouter.post("/patterns", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Pattern name is required" });
    return;
  }
  const conditions = legacyPayloadToConditions(body);
  if (conditions.length === 0) {
    res.status(400).json({ error: "Add at least one condition (includeTerms, regex, or semanticPrompt)" });
    return;
  }
  const regexCheck = validateConditionRegexes(conditions);
  if (!regexCheck.ok) {
    res.status(400).json({ error: regexCheck.error });
    return;
  }
  const pattern = await createPattern(scopedDb(req), {
    name: body.name,
    description: body.description,
    category: body.category,
    detectorKind: body.detectorKind,
    conditions,
    severity: body.severity,
    polarity: body.polarity,
    enabled: body.enabled,
    sampleRate: body.sampleRate,
    scopeMode: body.scopeMode,
    agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
  });
  res.status(201).json({ pattern });
});

agentMonitoringDashboardRouter.put("/patterns/:patternId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  // A dashboard edit always submits the full form (see updatePattern's comment on why this is a
  // full replace, not a sparse patch), so conditions are re-derived the same way createPattern
  // derives them, from whatever shape (multi-condition builder or legacy fields) was submitted.
  const conditions = legacyPayloadToConditions(body);
  const regexCheck = validateConditionRegexes(conditions);
  if (!regexCheck.ok) {
    res.status(400).json({ error: regexCheck.error });
    return;
  }
  const pattern = await updatePattern(scopedDb(req), req.params.patternId!, {
    name: body.name,
    description: body.description,
    category: body.category,
    detectorKind: body.detectorKind,
    conditions: conditions.length > 0 ? conditions : undefined,
    severity: body.severity,
    polarity: body.polarity,
    enabled: body.enabled,
    sampleRate: body.sampleRate,
    scopeMode: body.scopeMode,
    agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
  });
  if (!pattern) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }
  res.status(200).json({ pattern });
});

agentMonitoringDashboardRouter.post("/patterns/generate-regex", async (req: Request, res: Response) => {
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!description) {
    res.status(400).json({ error: "description is required" });
    return;
  }
  try {
    const regex = await generateRegex(description);
    res.status(200).json({ regex });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Failed to generate regex" });
  }
});

agentMonitoringDashboardRouter.delete("/patterns/:patternId", async (req: Request, res: Response) => {
  const deleted = await deletePattern(scopedDb(req), req.params.patternId!);
  if (!deleted) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }
  res.status(204).send();
});

agentMonitoringDashboardRouter.get("/agents", async (req: Request, res: Response) => {
  const agents = await listAgentsWire(scopedDb(req));
  res.status(200).json({ agents });
});

// Explicit registration - always creates a new row, even if an agent with this name already
// exists. This is the only way to end up with two agents sharing a display name; the implicit
// path (tracing under a name with no explicit agent_id) keeps resolving to a single, stable agent
// per distinct name via resolveAgentId (core/monitor/agents.ts), unchanged from before this
// registry existed.
agentMonitoringDashboardRouter.post("/agents", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const agent = await createAgent(scopedDb(req), body.name.trim());
  res.status(201).json({ agent });
});

agentMonitoringDashboardRouter.get("/agents/:id", async (req: Request, res: Response) => {
  const agent = await getAgent(scopedDb(req), req.params.id!);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.status(200).json({ agent });
});

agentMonitoringDashboardRouter.get("/profiles", async (req: Request, res: Response) => {
  const profiles = await listProfilesWire(scopedDb(req));
  res.status(200).json({ profiles });
});

agentMonitoringDashboardRouter.put("/profiles/:agentId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const agentId = await resolveAgentId(scopedDb(req), req.params.agentId!);
  const profile = await updateProfile(scopedDb(req), agentId, {
    enabled: body.enabled,
    failureDetectionEnabled: body.failureDetectionEnabled,
    infoDetectionEnabled: body.infoDetectionEnabled,
    topicsEnabled: body.topicsEnabled,
    coverageMode: body.coverageMode,
    sampleRate: body.sampleRate,
    retentionDays: body.retentionDays,
    thresholdOverrides: body.thresholdOverrides,
    channels: body.channels,
  });
  // Bare profile object, not { profile }: matches useUpdateMonitoringProfile.ts's
  // restClient.put<AgentMonitoringProfile>(...) exactly (unlike the SDK-facing /monitor router,
  // which does wrap - two different dialects, see this file's header comment).
  res.status(200).json(profile);
});

agentMonitoringDashboardRouter.patch("/profiles/:agentId/approval-policy", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const agentId = await resolveAgentId(scopedDb(req), req.params.agentId!);
  const profile = await updateProfile(scopedDb(req), agentId, { approvalPolicy: body.approvalPolicy });
  res.status(200).json(profile);
});

agentMonitoringDashboardRouter.get("/performance", async (req: Request, res: Response) => {
  const performance = await getPerformance(scopedDb(req));
  res.status(200).json(performance);
});

// OverviewTab's KPI strip/trend chart/top-failing breakdown (src/data/queries/agentMonitoring/
// useGetMonitoringKpis|Trend|TopFailing.ts) - windowed, unlike /performance above (all-time),
// backed by core/monitor/events.ts's monitor_events log rather than monitor_signals' deduped
// aggregates. workspaceId accepted for wire compatibility with the hosted SaaS's payload shape,
// unused (self-host is single-tenant).
function parseWindow(req: Request): MonitoringWindow {
  const raw = req.query.window;
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

// The Monitor metrics grid (spans/latency/cost/tokens/tools/platforms per bucket, with
// agent/model/tool/framework/status filters) - see core/monitor/metrics.ts.
agentMonitoringDashboardRouter.get("/metrics", async (req: Request, res: Response) => {
  res.status(200).json(
    await getMonitorMetrics(scopedDb(req), parseMetricsRange(req.query as Record<string, unknown>), {
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      model: typeof req.query.model === "string" ? req.query.model : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      // Folded like stored values (ingest normalizes to lowercase), so ?framework=LangChain matches.
      framework: typeof req.query.framework === "string" ? req.query.framework.trim().toLowerCase() : undefined,
    })
  );
});

agentMonitoringDashboardRouter.get("/kpis", async (req: Request, res: Response) => {
  res.status(200).json(await getKpis(scopedDb(req), parseWindow(req)));
});

agentMonitoringDashboardRouter.get("/trend", async (req: Request, res: Response) => {
  res.status(200).json(await getTrend(scopedDb(req), parseWindow(req)));
});

// Per-scorer signal activity (count + daily buckets) for the Scorers page's payoff column.
agentMonitoringDashboardRouter.get("/scorer-activity", async (req: Request, res: Response) => {
  res.status(200).json(await getScorerActivity(scopedDb(req), parseWindow(req)));
});

agentMonitoringDashboardRouter.get("/top-failing", async (req: Request, res: Response) => {
  res.status(200).json(await getTopFailing(scopedDb(req), parseWindow(req)));
});

// Judge calibration (core/monitor/outcomeCalibration.ts) - how often AgentX's own verdict agreed
// with a real-world outcome reported later via POST /api/v1/outcomes. Sits alongside
// /kpis/trend/top-failing since it's the same "aggregate over a window" shape, just measuring
// AgentX against ground truth instead of measuring the agent itself.
agentMonitoringDashboardRouter.get("/calibration", async (req: Request, res: Response) => {
  res.status(200).json(await getJudgeCalibration(scopedDb(req), parseWindow(req)));
});

// Per-model production comparison (core/monitor/modelComparison.ts) - quality/latency/cost/volume
// side by side for every model seen in the window's real traffic.
agentMonitoringDashboardRouter.get("/model-comparison", async (req: Request, res: Response) => {
  res.status(200).json(await getModelComparison(scopedDb(req), parseWindow(req)));
});

// On-demand Session Baseline Judge run (core/monitor/sessionSweep.ts's runSessionBaselineCheck):
// one real judge call over the whole assembled session against the built-in evaluator's config
// (rubric lives there, not in code). Route path kept from the old hardcoded coherence check for
// wire compat. 502 for a judge failure (missing key, provider outage) with the underlying
// message, same convention as the suggest-human-feedback route above.
agentMonitoringDashboardRouter.post("/sessions/:sessionId/coherence-check", async (req: Request, res: Response) => {
  try {
    const score = await runSessionBaselineCheck(scopedDb(req), req.params.sessionId!);
    if (!score) {
      res.status(404).json({ error: "Session not found, has no spans, or the Session Baseline Judge is missing" });
      return;
    }
    res.status(201).json({ score });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Baseline check failed" });
  }
});

// Per-evaluator on-demand session judging (the session detail's per-judge "Re-run" button) -
// generalizes /coherence-check above to any session-scoped evaluator. ?ifStale=true makes it a
// no-op when the evaluator already scored the session after its last activity (the sweep's own
// freshness rule) - importers judging backfilled sessions use this so a session the 24h sweep
// also covers is never judged twice.
agentMonitoringDashboardRouter.post(
  "/sessions/:sessionId/judge/:evaluatorId",
  async (req: Request, res: Response) => {
    try {
      if (req.query.ifStale === "true" && (await isSessionScoreFresh(scopedDb(req), req.params.sessionId!, req.params.evaluatorId!))) {
        res.status(200).json({ skipped: true });
        return;
      }
      const score = await runSessionEvaluatorCheck(scopedDb(req), req.params.sessionId!, req.params.evaluatorId!);
      if (!score) {
        res.status(404).json({ error: "Session not found, has no spans, or no such session-scoped evaluator" });
        return;
      }
      res.status(201).json({ score });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Session judging failed" });
    }
  }
);

agentMonitoringDashboardRouter.get("/sessions/:sessionId/scores", async (req: Request, res: Response) => {
  res.status(200).json({ scores: await listSessionScores(scopedDb(req), req.params.sessionId!) });
});

// The Sessions table under Observe (core/monitor/sessions.ts) - one row per conversation,
// aggregated from the window's traces, with each session's latest coherence snapshot. Registered
// after the two parameterized /sessions/:sessionId routes above purely for reading order; Express
// matches literal "/sessions" before ":sessionId" either way.
agentMonitoringDashboardRouter.get("/sessions", async (req: Request, res: Response) => {
  res.status(200).json(await listSessions(scopedDb(req), parseWindow(req)));
});

// Manual trigger for the idle-session sweep (core/monitor/sessionSweep.ts) - the production path
// is the 60s interval started at boot; this exists for tests and demos that shouldn't have to
// wait a tick. Sweeps ALL projects (the sweep is instance-wide by design), auth still required.
agentMonitoringDashboardRouter.post("/session-sweep/run", async (_req: Request, res: Response) => {
  res.status(200).json(await sweepSessionsOnce());
});

// Overview's "Total LLM cost" chart (core/monitor/cost.ts) - stacked by model, priced from Model
// Portability's own $/M-token table.
agentMonitoringDashboardRouter.get("/cost-trend", async (req: Request, res: Response) => {
  res.status(200).json(await getCostTrend(scopedDb(req), parseWindow(req)));
});

// Automatic per-trace classification (core/monitor/topics.ts) - opt-in via
// AgentMonitoringProfile.topicsEnabled, one combined payload since it's all one "Topics" sub-view.
agentMonitoringDashboardRouter.get("/topics", async (req: Request, res: Response) => {
  const window = parseWindow(req);
  const [trend, topIntents, issueBreakdown] = await Promise.all([
    getTopicsTrend(scopedDb(req), window),
    getTopIntents(scopedDb(req), window),
    getIssueBreakdown(scopedDb(req), window),
  ]);
  res.status(200).json({ trend, topIntents, issueBreakdown });
});

// Topics "Map" view - a real UMAP projection of each classified trace's stored embedding, kept as
// its own route rather than folded into GET /topics above: this is genuinely heavier compute
// (fitting UMAP over up to 300 points) than the three cheap aggregations that endpoint already
// combines, so a caller only pays for it when the Map tab is actually open.
agentMonitoringDashboardRouter.get("/topics/map", async (req: Request, res: Response) => {
  const window = parseWindow(req);
  res.status(200).json(await getTopicsMap(scopedDb(req), window));
});

// Online evaluators (core/monitor/onlineEvaluators.ts): LangSmith's actual "online evals" -
// a judge scored continuously against sampled live traffic, distinct from pattern-matching above.
// CRUD mirrors /patterns exactly (same routing/sampling shape, see core/monitor/routing.ts).
agentMonitoringDashboardRouter.get("/online-evaluators", async (req: Request, res: Response) => {
  const evaluators = await listOnlineEvaluatorsWire(scopedDb(req));
  res.status(200).json({ evaluators });
});

agentMonitoringDashboardRouter.post("/online-evaluators", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Online evaluator name is required" });
    return;
  }
  if (typeof body.evaluationSettingsId !== "string" || !body.evaluationSettingsId.trim()) {
    res.status(400).json({ error: "evaluationSettingsId is required" });
    return;
  }
  try {
    const evaluator = await createOnlineEvaluator(scopedDb(req), {
      name: body.name,
      evaluationSettingsId: body.evaluationSettingsId,
      sampleRate: body.sampleRate,
      scopeMode: body.scopeMode,
      agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
      enabled: body.enabled,
      alertThreshold: body.alertThreshold,
      severity: body.severity,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      idleSeconds: typeof body.idleSeconds === "number" ? body.idleSeconds : undefined,
    });
    res.status(201).json({ evaluator });
  } catch (err) {
    if (err instanceof InvalidEvaluationSettingsIdError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ReferenceCentricScorerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

agentMonitoringDashboardRouter.put("/online-evaluators/:evaluatorId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.evaluationSettingsId !== undefined && (typeof body.evaluationSettingsId !== "string" || !body.evaluationSettingsId.trim())) {
    res.status(400).json({ error: "evaluationSettingsId must be a non-empty string" });
    return;
  }
  try {
    const evaluator = await updateOnlineEvaluator(scopedDb(req), req.params.evaluatorId!, {
      name: body.name,
      evaluationSettingsId: body.evaluationSettingsId,
      sampleRate: body.sampleRate,
      scopeMode: body.scopeMode,
      agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
      enabled: body.enabled,
      alertThreshold: body.alertThreshold,
      severity: body.severity,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      idleSeconds: typeof body.idleSeconds === "number" ? body.idleSeconds : undefined,
    });
    if (!evaluator) {
      res.status(404).json({ error: "Online evaluator not found" });
      return;
    }
    res.status(200).json({ evaluator });
  } catch (err) {
    if (err instanceof InvalidEvaluationSettingsIdError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ReferenceCentricScorerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

agentMonitoringDashboardRouter.delete("/online-evaluators/:evaluatorId", async (req: Request, res: Response) => {
  const deleted = await deleteOnlineEvaluator(scopedDb(req), req.params.evaluatorId!);
  if (!deleted) {
    res.status(404).json({ error: "Online evaluator not found" });
    return;
  }
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// LLM Judge Scorers - the unified surface (core/monitor/judgeScorers.ts): one entity carrying
// the judge rubric plus its offline (dataset-run) and optional online (live-traffic) profiles.
// The legacy /online-evaluators and /evaluate/evaluationSettings routes above/elsewhere stay
// wire-compatible; this is the surface the dashboard's Scorers page and the SDK's
// client.monitor.judge_scorers use. camelCase only, per the project's wire convention.
// ---------------------------------------------------------------------------

function parseOnlineSection(body: Record<string, unknown>): { ok: true; online: JudgeScorerOnlineInput | null | undefined } | { ok: false } {
  const online = body.online;
  if (online === undefined) return { ok: true, online: undefined };
  if (online === null) return { ok: true, online: null };
  if (typeof online !== "object" || Array.isArray(online)) return { ok: false };
  return { ok: true, online: online as JudgeScorerOnlineInput };
}

agentMonitoringDashboardRouter.get("/judge-scorers", async (req: Request, res: Response) => {
  res.status(200).json({ judgeScorers: await listJudgeScorers(scopedDb(req)) });
});

// "Try it on a real trace" (Judge Scorer editor): the sample trace + recent traffic volume.
// Registered BEFORE /judge-scorers/:id so "preview-context" is not captured as an id.
agentMonitoringDashboardRouter.get("/judge-scorers/preview-context", async (req: Request, res: Response) => {
  res.status(200).json(await getJudgePreviewContext(scopedDb(req)));
});

// One reference-free judge call on one trace with an UNSAVED draft rubric. Judge failures
// (missing API key, provider outage) surface as 502 with the message, not a crash.
agentMonitoringDashboardRouter.post("/judge-scorers/preview-score", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const judge = body.judge && typeof body.judge === "object" ? body.judge : {};
  try {
    const result = await previewJudgeScore(scopedDb(req), judge, {
      traceId: typeof body.traceId === "string" ? body.traceId : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    });
    if (!result) {
      res.status(404).json({ error: "Nothing captured to score yet" });
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Judge call failed" });
  }
});

agentMonitoringDashboardRouter.get("/judge-scorers/:id", async (req: Request, res: Response) => {
  const judgeScorer = await getJudgeScorer(scopedDb(req), req.params.id!);
  if (!judgeScorer) {
    res.status(404).json({ error: "Judge scorer not found" });
    return;
  }
  res.status(200).json({ judgeScorer });
});

agentMonitoringDashboardRouter.post("/judge-scorers", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Judge scorer name is required" });
    return;
  }
  const parsed = parseOnlineSection(body);
  if (!parsed.ok) {
    res.status(400).json({ error: "online must be an object or null" });
    return;
  }
  const online = parsed.online
    ? { ...parsed.online, agentIds: await resolveAgentIds(scopedDb(req), parsed.online.agentIds) }
    : parsed.online;
  try {
    const judgeScorer = await createJudgeScorer(scopedDb(req), {
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description : undefined,
      judge: body.judge && typeof body.judge === "object" ? body.judge : undefined,
      offline: body.offline && typeof body.offline === "object" ? body.offline : undefined,
      online,
    });
    res.status(201).json({ judgeScorer });
  } catch (err) {
    if (err instanceof ReferenceCentricScorerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

agentMonitoringDashboardRouter.put("/judge-scorers/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const parsed = parseOnlineSection(body);
  if (!parsed.ok) {
    res.status(400).json({ error: "online must be an object or null" });
    return;
  }
  const online = parsed.online
    ? { ...parsed.online, agentIds: await resolveAgentIds(scopedDb(req), parsed.online.agentIds) }
    : parsed.online;
  try {
    const judgeScorer = await updateJudgeScorer(scopedDb(req), req.params.id!, {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      judge: body.judge && typeof body.judge === "object" ? body.judge : undefined,
      offline: body.offline && typeof body.offline === "object" ? body.offline : undefined,
      online,
    });
    if (!judgeScorer) {
      res.status(404).json({ error: "Judge scorer not found" });
      return;
    }
    res.status(200).json({ judgeScorer });
  } catch (err) {
    if (err instanceof BuiltinJudgeScorerError || err instanceof ReferenceCentricScorerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

agentMonitoringDashboardRouter.delete("/judge-scorers/:id", async (req: Request, res: Response) => {
  try {
    const deleted = await deleteJudgeScorer(scopedDb(req), req.params.id!);
    if (!deleted) {
      res.status(404).json({ error: "Judge scorer not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    if (err instanceof BuiltinJudgeScorerError || err instanceof ReferenceCentricScorerError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Every online-evaluator verdict for one trace - the trace dialog's "Judge scores" section
// (evaluator-centric views exist above; this is the trace-centric complement).
agentMonitoringDashboardRouter.get("/traces/:traceId/evaluations", async (req: Request, res: Response) => {
  res.status(200).json({ evaluations: await listTraceEvaluations(scopedDb(req), req.params.traceId!) });
});

agentMonitoringDashboardRouter.get("/online-evaluators/:evaluatorId/ratings", async (req: Request, res: Response) => {
  res.status(200).json(await getOnlineEvaluatorRatings(scopedDb(req), req.params.evaluatorId!, parseWindow(req)));
});

// Individual scored traces behind the ratings chart above, worst-rated first - lets a low point
// on that chart be traced back to exactly which conversation(s) caused it and why.
agentMonitoringDashboardRouter.get("/online-evaluators/:evaluatorId/events", async (req: Request, res: Response) => {
  const result = await getOnlineEvaluatorEvents(scopedDb(req), req.params.evaluatorId!, parseWindow(req));
  res.status(200).json(result);
});

// Judge tuning (core/monitor/judgeTuning.ts): measure this evaluator against recorded reality
// (triage corrections, outcomes, end-user votes), propose a rewrite of its criteria from the
// disagreements, validate the candidate by exact re-judging, publish through the evaluator's
// evaluation-settings config (version history included via patchEvaluationSettings).
agentMonitoringDashboardRouter.get(
  "/online-evaluators/:evaluatorId/calibration",
  async (req: Request, res: Response) => {
    const result = await getEvaluatorCalibration(scopedDb(req), req.params.evaluatorId!, parseWindow(req));
    if (!result) {
      res.status(404).json({ error: "Online evaluator not found" });
      return;
    }
    res.status(200).json(result);
  }
);

agentMonitoringDashboardRouter.post("/online-evaluators/:evaluatorId/tune", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  try {
    const result = await proposeJudgeTuning(scopedDb(req), req.params.evaluatorId!, {
      window: body.window === "24h" || body.window === "30d" ? body.window : "7d",
      caseEventIds: Array.isArray(body.caseEventIds)
        ? body.caseEventIds.filter((id: unknown): id is string => typeof id === "string")
        : undefined,
    });
    if (!result) {
      res.status(404).json({ error: "Online evaluator (or its evaluator config) not found" });
      return;
    }
    if ("error" in result) {
      res.status(422).json(result);
      return;
    }
    res.status(200).json({ proposal: result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Tuning proposal failed" });
  }
});

agentMonitoringDashboardRouter.post(
  "/online-evaluators/:evaluatorId/tune/validate",
  async (req: Request, res: Response) => {
    const body = req.body ?? {};
    for (const key of ["acceptanceCriteria", "rejectionCriteria", "evaluationCriteria"]) {
      if (typeof body[key] !== "string") {
        res.status(400).json({ error: `${key} (string) is required` });
        return;
      }
    }
    try {
      const result = await validateJudgeTuning(
        scopedDb(req),
        req.params.evaluatorId!,
        {
          acceptanceCriteria: body.acceptanceCriteria,
          rejectionCriteria: body.rejectionCriteria,
          evaluationCriteria: body.evaluationCriteria,
          judgePrompt: typeof body.judgePrompt === "string" ? body.judgePrompt : undefined,
        },
        { window: body.window === "24h" || body.window === "30d" ? body.window : "7d" }
      );
      if (!result) {
        res.status(404).json({ error: "Online evaluator (or its evaluator config) not found" });
        return;
      }
      if ("error" in result) {
        res.status(422).json(result);
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Validation failed" });
    }
  }
);

agentMonitoringDashboardRouter.post(
  "/online-evaluators/:evaluatorId/tune/publish",
  async (req: Request, res: Response) => {
    const body = req.body ?? {};
    for (const key of ["acceptanceCriteria", "rejectionCriteria", "evaluationCriteria"]) {
      if (typeof body[key] !== "string") {
        res.status(400).json({ error: `${key} (string) is required` });
        return;
      }
    }
    const evaluator = await getOnlineEvaluatorRow(scopedDb(req), req.params.evaluatorId!);
    if (!evaluator?.evaluationSettingsId) {
      res.status(404).json({ error: "Online evaluator (or its evaluator config) not found" });
      return;
    }
    // Provenance gate: publishing a tuned rubric requires the validation that measured it
    // (POST .../tune/validate's verdict + counts), and a measured REGRESSION is refused unless
    // the caller explicitly forces it. The verdict is stamped into the version history, so a
    // tuned-and-validated rubric change is distinguishable from a hand edit forever after.
    const validation = body.validation as
      | { verdict?: string; netAgreementGain?: number; fixed?: number; brokenControls?: number }
      | undefined;
    const force = body.force === true;
    if (!force) {
      if (!validation || typeof validation.verdict !== "string") {
        res.status(409).json({
          error:
            "Publishing tuned criteria requires the validation result (run POST .../tune/validate and pass its verdict as `validation`), or force: true to publish unvalidated.",
        });
        return;
      }
      if (validation.verdict === "regressed") {
        res.status(409).json({
          error:
            "Validation measured a net regression on this judge's own cases - not published. Re-generate the proposal, or pass force: true to publish anyway.",
        });
        return;
      }
    }
    const provenance = validation?.verdict
      ? `[judge tuning: validated ${validation.verdict}${
          typeof validation.netAgreementGain === "number" ? `, net agreement ${validation.netAgreementGain >= 0 ? "+" : ""}${validation.netAgreementGain}` : ""
        }]`
      : "[judge tuning: published without validation]";
    const updated = await patchEvaluationSettings(
      scopedDb(req),
      evaluator.evaluationSettingsId,
      {
        acceptanceCriteria: body.acceptanceCriteria,
        rejectionCriteria: body.rejectionCriteria,
        evaluationCriteria: body.evaluationCriteria,
        // Only when the tuning proposal actually revised the prompt - an absent field leaves the
        // config's prompt untouched, so criteria-only tunes keep their old publish behavior.
        ...(typeof body.judgePrompt === "string" && body.judgePrompt.trim() ? { judgePrompt: body.judgePrompt } : {}),
      },
      { versionProvenance: provenance }
    );
    if (!updated) {
      res.status(404).json({ error: "Evaluator config not found" });
      return;
    }
    res.status(200).json({ evaluationSettings: updated });
  }
);

// Custom evaluators (core/monitor/customEvaluators.ts): promoted out of Pattern's condition-row
// "external" detector - a URL the user controls, POSTed the trace, expected to answer
// {matches, reason}. CRUD mirrors /online-evaluators exactly, minus the evaluationSettingsId
// reference (there's no judge config here, just the URL itself).
function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

agentMonitoringDashboardRouter.get("/custom-evaluators", async (req: Request, res: Response) => {
  const evaluators = await listCustomEvaluatorsWire(scopedDb(req));
  res.status(200).json({ evaluators });
});

agentMonitoringDashboardRouter.post("/custom-evaluators", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Custom evaluator name is required" });
    return;
  }
  const isCode = body.kind === "code";
  if (isCode) {
    if (typeof body.script !== "string" || !body.script.trim()) {
      res.status(400).json({ error: "A code scorer needs a script defining handler(...)" });
      return;
    }
    if (body.language !== "javascript" && body.language !== "python") {
      res.status(400).json({ error: 'language must be "javascript" or "python"' });
      return;
    }
  } else if (!isValidHttpUrl(body.url)) {
    res.status(400).json({ error: "A valid http:// or https:// url is required" });
    return;
  }
  const evaluator = await createCustomEvaluator(scopedDb(req), {
    name: body.name,
    url: body.url,
    sampleRate: body.sampleRate,
    scopeMode: body.scopeMode,
    agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
    enabled: body.enabled,
    invertMatch: body.invertMatch,
    severity: body.severity,
    kind: body.kind,
    language: body.language,
    script: body.script,
    alertBelow: body.alertBelow,
  });
  res.status(201).json({ evaluator });
});

agentMonitoringDashboardRouter.put("/custom-evaluators/:evaluatorId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.url !== undefined && !isValidHttpUrl(body.url)) {
    res.status(400).json({ error: "A valid http:// or https:// url is required" });
    return;
  }
  const evaluator = await updateCustomEvaluator(scopedDb(req), req.params.evaluatorId!, {
    name: body.name,
    url: body.url,
    sampleRate: body.sampleRate,
    scopeMode: body.scopeMode,
    agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
    enabled: body.enabled,
    invertMatch: body.invertMatch,
    severity: body.severity,
    language: body.language,
    script: body.script,
    alertBelow: body.alertBelow,
  });
  if (!evaluator) {
    res.status(404).json({ error: "Custom evaluator not found" });
    return;
  }
  res.status(200).json({ evaluator });
});

agentMonitoringDashboardRouter.delete("/custom-evaluators/:evaluatorId", async (req: Request, res: Response) => {
  const deleted = await deleteCustomEvaluator(scopedDb(req), req.params.evaluatorId!);
  if (!deleted) {
    res.status(404).json({ error: "Custom evaluator not found" });
    return;
  }
  res.status(204).send();
});

// Individual checked traces for one custom evaluator, newest first - the call-history counterpart
// to /online-evaluators/:id/events.
agentMonitoringDashboardRouter.get("/custom-evaluators/:evaluatorId/events", async (req: Request, res: Response) => {
  const result = await getCustomEvaluatorEvents(scopedDb(req), req.params.evaluatorId!, parseWindow(req));
  res.status(200).json(result);
});

// Transient, not persisted - tests a URL before the user saves it as a real evaluator, or
// re-tests an already-saved one's URL from the edit dialog. Always 200: the *content* signals
// success/failure (same "never throw, always renderable" posture testCustomModelConnection uses
// in core/evaluate/models.ts for the Model Portability "Load model" check), since a dead/slow
// endpoint is an expected, common outcome here, not a server error.
agentMonitoringDashboardRouter.post("/custom-evaluators/dry-run", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const sampleInput = "Sample user question: Can you help me reset my password?";
  const sampleOutput =
    "Sample assistant response: Sure - I can help with that. Go to Settings > Security and click " +
    "\"Reset password\". You'll get an email with a reset link that's valid for 24 hours.";
  const sampleSpans = [
    {
      span_id: "dry-root",
      parent_span_id: null,
      name: "dry-run-agent",
      type: "span",
      input: sampleInput,
      output: sampleOutput,
      error: null,
      model: null,
      latency_ms: 1450,
      input_tokens: null,
      output_tokens: null,
      tool_calls: null,
      metadata: null,
      started_at: null,
    },
    {
      span_id: "dry-llm",
      parent_span_id: "dry-root",
      name: "LLM Call 1",
      type: "llm",
      input: sampleInput,
      output: sampleOutput,
      error: null,
      model: "gpt-4o-mini",
      latency_ms: 900,
      input_tokens: 220,
      output_tokens: 64,
      tool_calls: null,
      metadata: null,
      started_at: null,
    },
  ];
  const startedAt = Date.now();

  // Code kind: execute the script against the same sample the external dry run sends.
  if (body.kind === "code") {
    if (typeof body.script !== "string" || !body.script.trim()) {
      res.status(400).json({ error: "A code scorer needs a script defining handler(...)" });
      return;
    }
    const result = await runScriptScorer(
      {
        name: typeof body.name === "string" ? body.name : "Dry run",
        language: body.language === "python" ? "python" : "javascript",
        script: body.script,
      },
      { input: sampleInput, output: sampleOutput, expected: null, metadata: {}, spans: sampleSpans }
    );
    if (result.error) {
      res.status(200).json({ ok: false, error: result.error, latencyMs: Date.now() - startedAt });
      return;
    }
    res.status(200).json({
      ok: true,
      latencyMs: Date.now() - startedAt,
      // Shaped like the external response so the dialog renders both kinds the same way:
      // "matches" here means "would raise a signal at the given threshold".
      response: {
        matches: result.score !== null && result.score < (typeof body.alertBelow === "number" ? body.alertBelow : 0.5),
        score: result.score ?? undefined,
        reason: result.score === null ? "handler returned null - trace skipped" : undefined,
      },
    });
    return;
  }

  if (!isValidHttpUrl(body.url)) {
    res.status(400).json({ error: "A valid http:// or https:// url is required" });
    return;
  }
  const samplePayload: CustomEvaluatorRequest = {
    schemaVersion: 2,
    evaluatorId: null,
    evaluatorName: typeof body.name === "string" && body.name.trim() ? body.name : "Dry run",
    agentId: null,
    traceId: null,
    trace: {
      input: sampleInput,
      output: sampleOutput,
      error: null,
      toolCalls: [],
      name: "dry-run-agent",
      model: null,
      framework: null,
      sessionId: null,
      spanId: "dry-root",
      latencyMs: 1450,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      metadata: null,
      startedAt: null,
      createdAt: null,
    },
    spans: sampleSpans,
  };
  try {
    // callCustomEvaluator only distinguishes ok/not-ok (any non-2xx throws with the status folded
    // into the error message) rather than surfacing the exact status code - good enough for this
    // onboarding check, where "did it work and what did it say" matters more than the literal code.
    const response = await callCustomEvaluator(body.url, samplePayload);
    res.status(200).json({ ok: true, latencyMs: Date.now() - startedAt, response });
  } catch (err) {
    res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

agentMonitoringDashboardRouter.get("/signals/:signalId", async (req: Request, res: Response) => {
  const signal = await getSignal(scopedDb(req), req.params.signalId!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  const feedback = await listFeedbackForSignal(scopedDb(req), req.params.signalId!);
  res.status(200).json({ signal, feedback });
});

// Triage lifecycle, validated: the status enum was previously unchecked free text on the field
// every triage filter keys on. "resolved" requires a reason ("fixed" | "false_positive" |
// "wont_fix") - the GitHub code-scanning dismissal model - so fixed-rate and false-positive-rate
// stay queryable facts. "archived" remains accepted for legacy rows; new closes should be
// resolved + wont_fix.
const signalPatchSchema = z
  .object({
    status: z.enum(["open", "triaged", "resolved", "archived", "reopened"]).optional(),
    severity: z.string().optional(),
    reviewStatus: z.string().optional(),
    recommendedActions: z.array(z.string()).optional(),
    resolutionReason: z.enum(["fixed", "false_positive", "wont_fix"]).optional(),
  })
  .strip();

agentMonitoringDashboardRouter.patch("/signals/:signalId", validateBody(signalPatchSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof signalPatchSchema>;
  if (body.status === "resolved" && !body.resolutionReason) {
    res.status(400).json({ error: 'Resolving a signal requires resolutionReason: "fixed", "false_positive", or "wont_fix"' });
    return;
  }
  const signal = await updateSignal(scopedDb(req), req.params.signalId!, {
    status: body.status,
    severity: body.severity,
    reviewStatus: body.reviewStatus,
    recommendedActions: body.recommendedActions,
    resolutionReason: body.resolutionReason,
  });
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  // Bare signal object, matching useUpdateMonitoringSignal.ts, same convention as the profile
  // PUT/PATCH routes above.
  res.status(200).json(signal);
});

agentMonitoringDashboardRouter.post("/signals/:signalId/feedback", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.metric !== "string" || !body.metric.trim() || typeof body.rationale !== "string" || !body.rationale.trim()) {
    res.status(400).json({ error: "metric and rationale are required" });
    return;
  }
  const signal = await getSignal(scopedDb(req), req.params.signalId!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  const feedback = await createFeedback(scopedDb(req), req.params.signalId!, {
    metric: body.metric,
    rationale: body.rationale,
    occurrenceId: typeof body.occurrenceId === "string" ? body.occurrenceId : undefined,
    originalScore: body.originalScore,
    correctedScore: body.correctedScore,
    queuedForAutotune: body.queuedForAutotune,
  });
  res.status(201).json(feedback);
});

agentMonitoringDashboardRouter.post("/signals/:signalId/suggest-human-feedback", async (req: Request, res: Response) => {
  const occurrenceId = typeof req.body?.occurrenceId === "string" ? req.body.occurrenceId : undefined;
  try {
    const suggestedFeedback = await suggestHumanFeedback(scopedDb(req), req.params.signalId!, occurrenceId);
    res.status(200).json({ suggestedFeedback });
  } catch (err) {
    const status = err instanceof Error && err.message === "Signal not found" ? 404 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : "Failed to draft feedback" });
  }
});

agentMonitoringDashboardRouter.post("/signals/:signalId/suggest-expected-results", async (req: Request, res: Response) => {
  // humanFeedback may be empty - suggestExpectedResults also accepts operator feedback already
  // recorded on this occurrence (via the "unify" write path, see feedback.ts) as sufficient input,
  // and throws its own error if genuinely nothing is available.
  const humanFeedback = typeof req.body?.humanFeedback === "string" ? req.body.humanFeedback.trim() : "";
  const occurrenceId = typeof req.body?.occurrenceId === "string" ? req.body.occurrenceId : undefined;
  try {
    const result = await suggestExpectedResults(scopedDb(req), req.params.signalId!, humanFeedback, occurrenceId);
    res.status(200).json(result);
  } catch (err) {
    const status =
      err instanceof Error && err.message === "Signal not found"
        ? 404
        : err instanceof Error && err.message === "No feedback available for this occurrence yet"
          ? 400
          : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : "Failed to draft expected results" });
  }
});

// The production-to-dataset action (DraftEvaluatorDialog.tsx / useCreateMonitoringEvaluatorFromSignal.ts):
// turns a flagged signal into a new golden test case. The dialog never sends a datasetId (confirmed
// by reading DraftEvaluatorDialogBody - the hosted SaaS resolves the target dataset server-side),
// so self-host does the same via a deterministic per-agent convention: one dataset named
// "Monitor findings: <agent name>", created on first use, appended to on every call after that.
// Named by the agent's display name, not its (now opaque, generated) id - two agents sharing a
// name land in the same findings dataset, an acceptable minor ambiguity for an internal, low-stakes
// naming convention, not worth a real disambiguator here.
async function resolveMonitorFindingsDataset(db: Db, agentId: string) {
  const agentName = (await getAgentNamesById(db, [agentId])).get(agentId) ?? agentId;
  const name = `Monitor findings: ${agentName}`;
  const existing = (await listDatasets(db)).find(d => d.name === name);
  if (existing) {
    return existing;
  }
  return createDataset(db, {
    name,
    description: `Test cases created from Monitor signals flagged on "${agentName}".`,
    questions: [],
  });
}

agentMonitoringDashboardRouter.post("/signals/:signalId/create-evaluator", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const expectedResults = typeof body.expectedResults === "string" ? body.expectedResults.trim() : "";
  if (!expectedResults) {
    res.status(400).json({ error: "expectedResults is required" });
    return;
  }

  const signal = await getSignal(scopedDb(req), req.params.signalId!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }

  const agentId: string | undefined =
    typeof body.agentId === "string" && body.agentId
      ? body.agentId
      : typeof signal.agentId === "object" && signal.agentId
        ? (signal.agentId as { _id: string })._id
        : undefined;
  if (!agentId) {
    res.status(400).json({ error: "Unable to determine which agent to draft this evaluator for" });
    return;
  }

  // signal.evidence is last-write-wins (only the latest occurrence - see signals.ts's upsertSignal),
  // so a reviewer who picked an earlier occurrence in the dialog's picker needs that occurrence's
  // own captured input, not whatever most recently overwrote the signal's top-level evidence.
  const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId : undefined;
  const occurrence = occurrenceId ? signal.occurrences?.find(o => o.id === occurrenceId) : undefined;
  const evidence = signal.evidence as { input?: unknown } | undefined;
  const query =
    occurrence?.query !== undefined
      ? occurrence.query
      : typeof evidence?.input === "string"
        ? evidence.input
        : JSON.stringify(evidence?.input ?? "");
  const newQuestion = { main_question: { query, expectedResults }, follow_up_questions: [] };

  const dataset = await resolveMonitorFindingsDataset(scopedDb(req), agentId);
  const questions = [...(dataset.questions as unknown[]), newQuestion];
  const updated = await updateDataset(scopedDb(req), dataset._id, {
    name: dataset.name,
    description: dataset.description,
    acceptanceCriteria: dataset.acceptanceCriteria,
    rejectionCriteria: dataset.rejectionCriteria,
    evaluationCriteria: dataset.evaluationCriteria,
    questions,
  });
  if (!updated) {
    res.status(500).json({ error: "Failed to save the new test case" });
    return;
  }

  res.status(200).json({
    signal,
    draft: {
      status: "created",
      evaluationSettingsId: updated._id,
      questionIndex: questions.length - 1,
      message: `Added a new test case to "${dataset.name}".`,
    },
  });
});

// Self-host has no billing/credits concept at all - this only exists so
// DraftEvaluatorDialog.tsx's unconditional on-mount estimate call doesn't 404. Confirmed the
// frontend only reads `estimatedCredits` behind a `typeof === "number"` guard and renders nothing
// when it's absent, so a flat 0 is enough to keep that dialog's UI correct rather than
// implementing a self-host credit system that doesn't apply here.
agentMonitoringDashboardRouter.post("/estimate", async (req: Request, res: Response) => {
  res.status(200).json({ action: req.body?.action, estimatedCredits: 0 });
});

// Model portability (core/evaluate/portability.ts) - an input-only replay of a captured trace
// against alternative models, not a full agent re-run (self-host doesn't own the agent). Explicit,
// per-trace, user-triggered only: never runs automatically, and nothing about the *comparison
// itself* is persisted (a disclosed scope cut, matching /prompts/:id/propose's same "compute and
// return, don't write" posture) - but the candidate models + pricing this reads from ARE
// dashboard-editable (portability_models table, core/evaluate/models.ts), seeded once with a
// small default set on first boot rather than a hardcoded array a code change was needed to fix.
agentMonitoringDashboardRouter.get("/portability/models", async (req: Request, res: Response) => {
  res.status(200).json({ models: await listPortabilityModels(scopedDb(req)) });
});

// Models seen on token-bearing traces (30d) with no catalog pricing - the Settings pricing panel
// lists them with a one-click add so unpriced spend is visible instead of a silent $0.
agentMonitoringDashboardRouter.get("/portability/models/unpriced", async (req: Request, res: Response) => {
  res.status(200).json({ models: await listUnpricedModels(scopedDb(req)) });
});

const VALID_PROVIDERS = ["openai", "anthropic", "gemini", "custom"];

agentMonitoringDashboardRouter.post("/portability/models", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.id !== "string" || !body.id.trim()) {
    res.status(400).json({ error: "id is required (the exact model string sent to the provider's API)" });
    return;
  }
  if (!VALID_PROVIDERS.includes(body.provider)) {
    res.status(400).json({ error: 'provider must be "openai", "anthropic", "gemini", or "custom"' });
    return;
  }
  if (typeof body.label !== "string" || !body.label.trim()) {
    res.status(400).json({ error: "label is required" });
    return;
  }
  if (typeof body.pricePerMInputTokens !== "number" || typeof body.pricePerMOutputTokens !== "number") {
    res.status(400).json({ error: "pricePerMInputTokens and pricePerMOutputTokens must be numbers" });
    return;
  }
  if (body.provider === "custom" && (typeof body.baseUrl !== "string" || !body.baseUrl.trim())) {
    res.status(400).json({ error: "baseUrl is required for a custom model" });
    return;
  }
  const existing = await listPortabilityModels(scopedDb(req));
  if (existing.some(m => m.id === body.id)) {
    res.status(409).json({ error: `A model with id "${body.id}" already exists` });
    return;
  }
  const model = await createPortabilityModel(scopedDb(req), {
    id: body.id,
    provider: body.provider,
    label: body.label,
    pricePerMInputTokens: body.pricePerMInputTokens,
    pricePerMOutputTokens: body.pricePerMOutputTokens,
    pricePerMCacheReadTokens: typeof body.pricePerMCacheReadTokens === "number" ? body.pricePerMCacheReadTokens : null,
    pricePerMCacheWriteTokens: typeof body.pricePerMCacheWriteTokens === "number" ? body.pricePerMCacheWriteTokens : null,
    isDefault: body.isDefault === true,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    apiKey: typeof body.apiKey === "string" ? body.apiKey : null,
  });
  res.status(201).json({ model });
});

agentMonitoringDashboardRouter.put("/portability/models/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!VALID_PROVIDERS.includes(body.provider)) {
    res.status(400).json({ error: 'provider must be "openai", "anthropic", "gemini", or "custom"' });
    return;
  }
  if (typeof body.label !== "string" || !body.label.trim()) {
    res.status(400).json({ error: "label is required" });
    return;
  }
  if (typeof body.pricePerMInputTokens !== "number" || typeof body.pricePerMOutputTokens !== "number") {
    res.status(400).json({ error: "pricePerMInputTokens and pricePerMOutputTokens must be numbers" });
    return;
  }
  if (body.provider === "custom" && (typeof body.baseUrl !== "string" || !body.baseUrl.trim())) {
    res.status(400).json({ error: "baseUrl is required for a custom model" });
    return;
  }
  const model = await updatePortabilityModel(scopedDb(req), req.params.id!, {
    provider: body.provider,
    label: body.label,
    pricePerMInputTokens: body.pricePerMInputTokens,
    pricePerMOutputTokens: body.pricePerMOutputTokens,
    pricePerMCacheReadTokens: typeof body.pricePerMCacheReadTokens === "number" ? body.pricePerMCacheReadTokens : null,
    pricePerMCacheWriteTokens: typeof body.pricePerMCacheWriteTokens === "number" ? body.pricePerMCacheWriteTokens : null,
    isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    // Only included when the dashboard form actually had a non-empty value typed in - see
    // UpdatePortabilityModelInput's comment on why "omitted" (vs. an explicit "") matters here.
    ...(typeof body.apiKey === "string" && body.apiKey.trim() ? { apiKey: body.apiKey } : {}),
  });
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  res.status(200).json({ model });
});

agentMonitoringDashboardRouter.delete("/portability/models/:id", async (req: Request, res: Response) => {
  const deleted = await deletePortabilityModel(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  res.status(200).json({ success: true });
});

// "Load model" (PortabilityModelsPanel.tsx) - tests whatever's currently in the add/edit form,
// before it's saved. Always 200s: testCustomModelConnection itself never throws, so any failure
// reads as {live: false, error} rather than a scary 500.
agentMonitoringDashboardRouter.post("/portability/models/test-connection", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
    res.status(400).json({ error: "baseUrl is required" });
    return;
  }
  if (typeof body.modelId !== "string" || !body.modelId.trim()) {
    res.status(400).json({ error: "modelId is required" });
    return;
  }
  const result = await testCustomModelConnection({
    baseUrl: body.baseUrl,
    modelId: body.modelId,
    apiKey: typeof body.apiKey === "string" ? body.apiKey : null,
  });
  res.status(200).json(result);
});

// Platform Settings (AgentX-web-front's PlatformSettingsPage) - the current project's own
// dashboard/SDK API key, plus the LLM provider keys judge.ts's getOpenAI()/getAnthropic() now
// check before falling back to OPENAI_API_KEY/ANTHROPIC_API_KEY (instance-wide, not per-project -
// see appSettings' own schema comment). Never returns a stored LLM key raw once set - only masked
// (last 4 chars, see maskSecret) - unlike the requesting project's own key, which it's already
// authenticated with (showing it back to the same caller isn't a leak; showing a *different*
// project's key here would be, which is why this reads req.projectId, never another project's row).
agentMonitoringDashboardRouter.get("/settings", async (req: Request, res: Response) => {
  const settings = await getAppSettings(getDb());
  const project = await getProject(getDb(), req.projectId!);
  const monitoringDefaults = await getMonitoringDefaults(scopedDb(req));
  res.status(200).json({
    apiKey: project?.apiKey ?? null,
    monitoringDefaults,
    llm: {
      openai: { configured: !!settings.openaiApiKey, masked: settings.openaiApiKey ? maskSecret(settings.openaiApiKey) : null },
      anthropic: {
        configured: !!settings.anthropicApiKey,
        masked: settings.anthropicApiKey ? maskSecret(settings.anthropicApiKey) : null,
      },
      gemini: { configured: !!settings.geminiApiKey, masked: settings.geminiApiKey ? maskSecret(settings.geminiApiKey) : null },
    },
  });
});

// Project-level monitoring defaults (coverage/sample rate/retention -
// see core/project/projects.ts's MonitoringDefaults) - moved here from being per-agent
// AgentMonitoringProfile fields, see core/monitor/profiles.ts's toWire comment.
// The exemplar for validateBody: shape/range checks live in the schema (a mistyped field is a
// named 400, not the old silent typeof-skip), unknown keys are stripped for legacy clients, and
// only cross-data checks (the known-scorer-keys list) stay in the handler.
// coverageMode/sampleRate are LEGACY: stored for old clients, read by no monitoring consumer
// (see schema.sqlite.ts's projects.coverageMode block).
const monitoringDefaultsPatchSchema = z
  .object({
    coverageMode: z.enum(["all", "sampled"]).optional(),
    sampleRate: z.number().min(0).max(1).optional(),
    retentionDays: z.number().int().min(0).optional(),
    latencyThresholdMs: z.number().int().min(0).optional(),
    topicsEnabled: z.boolean().optional(),
    topicsSampleRate: z.number().min(0).max(1).optional(),
    coherenceSweepEnabled: z.boolean().optional(),
    enabledBuiltinPatterns: z.array(z.string()).optional(),
  })
  .strip();

agentMonitoringDashboardRouter.put(
  "/settings/monitoring-defaults",
  validateBody(monitoringDefaultsPatchSchema),
  async (req: Request, res: Response) => {
    const patch = req.body as z.infer<typeof monitoringDefaultsPatchSchema>;
    if (patch.enabledBuiltinPatterns) {
      // Reject unknown keys instead of storing them: a typo'd key used to be accepted verbatim,
      // enable nothing, and report nothing - the config-as-code caller believed a scorer was on
      // while nothing ran (deep-dive round 3, bug #2). Silent no-op config is the same failure
      // class the removed redaction placebo was.
      const known = new Set<string>(BUILT_IN_MONITOR_PATTERNS.map(p => p.key));
      const unknown = patch.enabledBuiltinPatterns.filter(k => !known.has(k));
      if (unknown.length > 0) {
        res.status(400).json({
          error: `Unknown template scorer key(s): ${unknown.join(", ")}`,
          knownKeys: [...known],
        });
        return;
      }
    }
    const monitoringDefaults = await updateMonitoringDefaults(scopedDb(req), patch);
    res.status(200).json({ monitoringDefaults });
  }
);

agentMonitoringDashboardRouter.put("/settings/llm-keys", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const patch: { openaiApiKey?: string | null; anthropicApiKey?: string | null; geminiApiKey?: string | null } = {};
  if ("openaiApiKey" in body) {
    patch.openaiApiKey = typeof body.openaiApiKey === "string" ? body.openaiApiKey : null;
  }
  if ("anthropicApiKey" in body) {
    patch.anthropicApiKey = typeof body.anthropicApiKey === "string" ? body.anthropicApiKey : null;
  }
  if ("geminiApiKey" in body) {
    patch.geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey : null;
  }
  const settings = await updateAppSettings(getDb(), patch);
  res.status(200).json({
    llm: {
      openai: { configured: !!settings.openaiApiKey, masked: settings.openaiApiKey ? maskSecret(settings.openaiApiKey) : null },
      anthropic: {
        configured: !!settings.anthropicApiKey,
        masked: settings.anthropicApiKey ? maskSecret(settings.anthropicApiKey) : null,
      },
      gemini: { configured: !!settings.geminiApiKey, masked: settings.geminiApiKey ? maskSecret(settings.geminiApiKey) : null },
    },
  });
});

agentMonitoringDashboardRouter.post("/settings/api-key/regenerate", async (req: Request, res: Response) => {
  const project = await regenerateProjectApiKey(getDb(), req.projectId!);
  res.status(200).json({ apiKey: project?.apiKey ?? null });
});

// Reconstruction only, no model calls, no cost - lets the dashboard show "here's what we'll send"
// before the user commits to spending money on the real comparison below.
agentMonitoringDashboardRouter.get("/traces/:traceId/portability-preview", async (req: Request, res: Response) => {
  const preview = await getPortabilityPreview(scopedDb(req), req.params.traceId!);
  if (!preview) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.status(200).json(preview);
});

agentMonitoringDashboardRouter.post("/traces/:traceId/portability", async (req: Request, res: Response) => {
  const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter((id: unknown) => typeof id === "string") : [];
  if (modelIds.length === 0) {
    res.status(400).json({ error: "modelIds must be a non-empty array" });
    return;
  }
  const result = await runModelPortabilityCheck(scopedDb(req), req.params.traceId!, modelIds);
  if (!result) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.status(200).json(result);
});
