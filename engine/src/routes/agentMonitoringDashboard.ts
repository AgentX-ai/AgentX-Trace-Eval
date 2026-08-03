import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { createPattern, updatePattern, deletePattern, listPatternsWire, legacyPayloadToConditions } from "../core/monitor/patterns.js";
import { builtInPatternsWire } from "../core/monitor/detect.js";
import { listSignals, getSignal, updateSignal } from "../core/monitor/signals.js";
import { updateProfile, listProfilesWire } from "../core/monitor/profiles.js";
import { listAgentsWire } from "../core/monitor/agents.js";
import { getPerformance } from "../core/monitor/performance.js";
import { createFeedback, listFeedbackForSignal } from "../core/monitor/feedback.js";
import { generateRegex, suggestHumanFeedback, suggestExpectedResults } from "../core/monitor/suggestions.js";
import { getKpis, getTrend, getTopFailing, getOnlineEvaluatorRatings, type MonitoringWindow } from "../core/monitor/events.js";
import { listDatasets, createDataset, updateDataset } from "../core/evaluate/datasets.js";
import {
  createOnlineEvaluator,
  updateOnlineEvaluator,
  deleteOnlineEvaluator,
  listOnlineEvaluatorsWire,
  InvalidEvaluationSettingsIdError,
} from "../core/monitor/onlineEvaluators.js";
import { getPortabilityPreview, runModelPortabilityCheck } from "../core/evaluate/portability.js";
import {
  listPortabilityModels,
  createPortabilityModel,
  updatePortabilityModel,
  deletePortabilityModel,
} from "../core/evaluate/models.js";

// Mounted at /api/v1/agent-monitoring — the paths AgentX-web-front's dashboard actually calls
// (src/data/apiPaths.ts's getMonitoring*/*MonitoringProfile/*MonitoringPattern), a different
// dialect from the SDK-facing /api/v1/monitor router (routes/monitor.ts): same underlying core
// logic, different response envelope/query params to match what the dashboard's data hooks
// expect. Grown in slices: Observe-only (signals/patterns listing), AgentsTab + pattern CRUD,
// signal detail/triage/feedback + the two LLM-assist endpoints (regex generation, feedback
// drafting) + a credit-estimate stub (self-host has no billing, see /estimate below),
// create-evaluator-from-signal/suggest-expected-results (production-to-dataset, reusing
// core/evaluate/datasets.ts), kpis/trend/top-failing (core/monitor/events.ts's per-occurrence
// log), and online-evaluators (continuous judge scoring on sampled live traffic — LangSmith's
// actual "online evals", distinct from pattern-matching; no dashboard UI for this yet, backend
// only for now). Still out of scope: the autotune/"Improve" proposal system, tied to AgentX's
// native agent config-branching, which self-host doesn't have. See README's Status section.
export const agentMonitoringDashboardRouter = Router();

agentMonitoringDashboardRouter.get("/signals", async (req: Request, res: Response) => {
  const { severity, status, agentId, polarity, limit } = req.query;
  const signals = await listSignals(
    getDb(),
    {
      severity: typeof severity === "string" ? severity : undefined,
      status: typeof status === "string" ? status : undefined,
      agentId: typeof agentId === "string" ? agentId : undefined,
      polarity: typeof polarity === "string" ? polarity : undefined,
    },
    limit ? Math.min(Number(limit) || 50, 100) : 50
  );
  res.status(200).json({ signals });
});

agentMonitoringDashboardRouter.get("/patterns", async (_req: Request, res: Response) => {
  const custom = await listPatternsWire(getDb());
  res.status(200).json({ patterns: [...builtInPatternsWire(), ...custom] });
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
  const pattern = await createPattern(getDb(), {
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
    agentIds: body.agentIds,
  });
  res.status(201).json({ pattern });
});

agentMonitoringDashboardRouter.put("/patterns/:patternId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  // A dashboard edit always submits the full form (see updatePattern's comment on why this is a
  // full replace, not a sparse patch), so conditions are re-derived the same way createPattern
  // derives them, from whatever shape (multi-condition builder or legacy fields) was submitted.
  const conditions = legacyPayloadToConditions(body);
  const pattern = await updatePattern(getDb(), req.params.patternId!, {
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
    agentIds: body.agentIds,
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
  const deleted = await deletePattern(getDb(), req.params.patternId!);
  if (!deleted) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }
  res.status(204).send();
});

agentMonitoringDashboardRouter.get("/agents", async (_req: Request, res: Response) => {
  const agents = await listAgentsWire(getDb());
  res.status(200).json({ agents });
});

agentMonitoringDashboardRouter.get("/profiles", async (_req: Request, res: Response) => {
  const profiles = await listProfilesWire(getDb());
  res.status(200).json({ profiles });
});

agentMonitoringDashboardRouter.put("/profiles/:agentId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const profile = await updateProfile(getDb(), req.params.agentId!, {
    enabled: body.enabled,
    failureDetectionEnabled: body.failureDetectionEnabled,
    infoDetectionEnabled: body.infoDetectionEnabled,
    coverageMode: body.coverageMode,
    sampleRate: body.sampleRate,
    retentionDays: body.retentionDays,
    redactionMode: body.redactionMode,
    thresholdOverrides: body.thresholdOverrides,
    channels: body.channels,
  });
  // Bare profile object, not { profile }: matches useUpdateMonitoringProfile.ts's
  // restClient.put<AgentMonitoringProfile>(...) exactly (unlike the SDK-facing /monitor router,
  // which does wrap — two different dialects, see this file's header comment).
  res.status(200).json(profile);
});

agentMonitoringDashboardRouter.patch("/profiles/:agentId/approval-policy", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const profile = await updateProfile(getDb(), req.params.agentId!, { approvalPolicy: body.approvalPolicy });
  res.status(200).json(profile);
});

agentMonitoringDashboardRouter.get("/performance", async (_req: Request, res: Response) => {
  const performance = await getPerformance(getDb());
  res.status(200).json(performance);
});

// OverviewTab's KPI strip/trend chart/top-failing breakdown (src/data/queries/agentMonitoring/
// useGetMonitoringKpis|Trend|TopFailing.ts) — windowed, unlike /performance above (all-time),
// backed by core/monitor/events.ts's monitor_events log rather than monitor_signals' deduped
// aggregates. workspaceId accepted for wire compatibility with the hosted SaaS's payload shape,
// unused (self-host is single-tenant).
function parseWindow(req: Request): MonitoringWindow {
  const raw = req.query.window;
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

agentMonitoringDashboardRouter.get("/kpis", async (req: Request, res: Response) => {
  res.status(200).json(await getKpis(getDb(), parseWindow(req)));
});

agentMonitoringDashboardRouter.get("/trend", async (req: Request, res: Response) => {
  res.status(200).json(await getTrend(getDb(), parseWindow(req)));
});

agentMonitoringDashboardRouter.get("/top-failing", async (req: Request, res: Response) => {
  res.status(200).json(await getTopFailing(getDb(), parseWindow(req)));
});

// Online evaluators (core/monitor/onlineEvaluators.ts): LangSmith's actual "online evals" —
// a judge scored continuously against sampled live traffic, distinct from pattern-matching above.
// CRUD mirrors /patterns exactly (same routing/sampling shape, see core/monitor/routing.ts).
agentMonitoringDashboardRouter.get("/online-evaluators", async (_req: Request, res: Response) => {
  const evaluators = await listOnlineEvaluatorsWire(getDb());
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
    const evaluator = await createOnlineEvaluator(getDb(), {
      name: body.name,
      evaluationSettingsId: body.evaluationSettingsId,
      sampleRate: body.sampleRate,
      scopeMode: body.scopeMode,
      agentIds: body.agentIds,
      enabled: body.enabled,
    });
    res.status(201).json({ evaluator });
  } catch (err) {
    if (err instanceof InvalidEvaluationSettingsIdError) {
      res.status(400).json({ error: err.message });
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
    const evaluator = await updateOnlineEvaluator(getDb(), req.params.evaluatorId!, {
      name: body.name,
      evaluationSettingsId: body.evaluationSettingsId,
      sampleRate: body.sampleRate,
      scopeMode: body.scopeMode,
      agentIds: body.agentIds,
      enabled: body.enabled,
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
    throw err;
  }
});

agentMonitoringDashboardRouter.delete("/online-evaluators/:evaluatorId", async (req: Request, res: Response) => {
  const deleted = await deleteOnlineEvaluator(getDb(), req.params.evaluatorId!);
  if (!deleted) {
    res.status(404).json({ error: "Online evaluator not found" });
    return;
  }
  res.status(204).send();
});

agentMonitoringDashboardRouter.get("/online-evaluators/:evaluatorId/ratings", async (req: Request, res: Response) => {
  res.status(200).json(await getOnlineEvaluatorRatings(getDb(), req.params.evaluatorId!, parseWindow(req)));
});

agentMonitoringDashboardRouter.get("/signals/:signalId", async (req: Request, res: Response) => {
  const signal = await getSignal(getDb(), req.params.signalId!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  const feedback = await listFeedbackForSignal(getDb(), req.params.signalId!);
  res.status(200).json({ signal, feedback });
});

agentMonitoringDashboardRouter.patch("/signals/:signalId", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const signal = await updateSignal(getDb(), req.params.signalId!, {
    status: body.status,
    severity: body.severity,
    reviewStatus: body.reviewStatus,
    recommendedActions: body.recommendedActions,
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
  const signal = await getSignal(getDb(), req.params.signalId!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  const feedback = await createFeedback(getDb(), req.params.signalId!, {
    metric: body.metric,
    rationale: body.rationale,
    originalScore: body.originalScore,
    correctedScore: body.correctedScore,
    queuedForAutotune: body.queuedForAutotune,
  });
  res.status(201).json(feedback);
});

agentMonitoringDashboardRouter.post("/signals/:signalId/suggest-human-feedback", async (req: Request, res: Response) => {
  try {
    const suggestedFeedback = await suggestHumanFeedback(getDb(), req.params.signalId!);
    res.status(200).json({ suggestedFeedback });
  } catch (err) {
    const status = err instanceof Error && err.message === "Signal not found" ? 404 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : "Failed to draft feedback" });
  }
});

agentMonitoringDashboardRouter.post("/signals/:signalId/suggest-expected-results", async (req: Request, res: Response) => {
  const humanFeedback = typeof req.body?.humanFeedback === "string" ? req.body.humanFeedback.trim() : "";
  if (!humanFeedback) {
    res.status(400).json({ error: "humanFeedback is required" });
    return;
  }
  try {
    const result = await suggestExpectedResults(getDb(), req.params.signalId!, humanFeedback);
    res.status(200).json(result);
  } catch (err) {
    const status = err instanceof Error && err.message === "Signal not found" ? 404 : 502;
    res.status(status).json({ error: err instanceof Error ? err.message : "Failed to draft expected results" });
  }
});

// The production-to-dataset action (DraftEvaluatorDialog.tsx / useCreateMonitoringEvaluatorFromSignal.ts):
// turns a flagged signal into a new golden test case. The dialog never sends a datasetId (confirmed
// by reading DraftEvaluatorDialogBody — the hosted SaaS resolves the target dataset server-side),
// so self-host does the same via a deterministic per-agent convention: one dataset named
// "Monitor findings: <agentId>", created on first use, appended to on every call after that.
async function resolveMonitorFindingsDataset(agentId: string) {
  const name = `Monitor findings: ${agentId}`;
  const existing = (await listDatasets(getDb())).find(d => d.name === name);
  if (existing) {
    return existing;
  }
  return createDataset(getDb(), {
    name,
    description: `Test cases created from Monitor signals flagged on "${agentId}".`,
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

  const signal = await getSignal(getDb(), req.params.signalId!);
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

  const evidence = signal.evidence as { input?: unknown } | undefined;
  const query = typeof evidence?.input === "string" ? evidence.input : JSON.stringify(evidence?.input ?? "");
  const newQuestion = { main_question: { query, expectedResults }, follow_up_questions: [] };

  const dataset = await resolveMonitorFindingsDataset(agentId);
  const questions = [...(dataset.questions as unknown[]), newQuestion];
  const updated = await updateDataset(getDb(), dataset._id, {
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

// Self-host has no billing/credits concept at all — this only exists so
// DraftEvaluatorDialog.tsx's unconditional on-mount estimate call doesn't 404. Confirmed the
// frontend only reads `estimatedCredits` behind a `typeof === "number"` guard and renders nothing
// when it's absent, so a flat 0 is enough to keep that dialog's UI correct rather than
// implementing a self-host credit system that doesn't apply here.
agentMonitoringDashboardRouter.post("/estimate", async (req: Request, res: Response) => {
  res.status(200).json({ action: req.body?.action, estimatedCredits: 0 });
});

// Model portability (core/evaluate/portability.ts) — an input-only replay of a captured trace
// against alternative models, not a full agent re-run (self-host doesn't own the agent). Explicit,
// per-trace, user-triggered only: never runs automatically, and nothing about the *comparison
// itself* is persisted (a disclosed scope cut, matching /prompts/:id/propose's same "compute and
// return, don't write" posture) — but the candidate models + pricing this reads from ARE
// dashboard-editable (portability_models table, core/evaluate/models.ts), seeded once with a
// small default set on first boot rather than a hardcoded array a code change was needed to fix.
agentMonitoringDashboardRouter.get("/portability/models", async (_req: Request, res: Response) => {
  res.status(200).json({ models: await listPortabilityModels(getDb()) });
});

agentMonitoringDashboardRouter.post("/portability/models", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.id !== "string" || !body.id.trim()) {
    res.status(400).json({ error: "id is required (the exact model string sent to the provider's API)" });
    return;
  }
  if (body.provider !== "openai" && body.provider !== "anthropic") {
    res.status(400).json({ error: 'provider must be "openai" or "anthropic"' });
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
  const existing = await listPortabilityModels(getDb());
  if (existing.some(m => m.id === body.id)) {
    res.status(409).json({ error: `A model with id "${body.id}" already exists` });
    return;
  }
  const model = await createPortabilityModel(getDb(), {
    id: body.id,
    provider: body.provider,
    label: body.label,
    pricePerMInputTokens: body.pricePerMInputTokens,
    pricePerMOutputTokens: body.pricePerMOutputTokens,
  });
  res.status(201).json({ model });
});

agentMonitoringDashboardRouter.put("/portability/models/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.provider !== "openai" && body.provider !== "anthropic") {
    res.status(400).json({ error: 'provider must be "openai" or "anthropic"' });
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
  const model = await updatePortabilityModel(getDb(), req.params.id!, {
    provider: body.provider,
    label: body.label,
    pricePerMInputTokens: body.pricePerMInputTokens,
    pricePerMOutputTokens: body.pricePerMOutputTokens,
  });
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  res.status(200).json({ model });
});

agentMonitoringDashboardRouter.delete("/portability/models/:id", async (req: Request, res: Response) => {
  const deleted = await deletePortabilityModel(getDb(), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  res.status(200).json({ success: true });
});

// Reconstruction only, no model calls, no cost — lets the dashboard show "here's what we'll send"
// before the user commits to spending money on the real comparison below.
agentMonitoringDashboardRouter.get("/traces/:traceId/portability-preview", async (req: Request, res: Response) => {
  const preview = await getPortabilityPreview(getDb(), req.params.traceId!);
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
  const result = await runModelPortabilityCheck(getDb(), req.params.traceId!, modelIds);
  if (!result) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.status(200).json(result);
});
