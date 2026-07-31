import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { createPattern, updatePattern, deletePattern, listPatternsWire, legacyPayloadToConditions } from "../core/monitor/patterns.js";
import { builtInPatternsWire } from "../core/monitor/detect.js";
import { listSignals, getSignal, updateSignal } from "../core/monitor/signals.js";
import { updateProfile, listProfilesWire } from "../core/monitor/profiles.js";
import { listAgentsWire } from "../core/monitor/agents.js";
import { getPerformance } from "../core/monitor/performance.js";
import { createFeedback, listFeedbackForSignal } from "../core/monitor/feedback.js";
import { generateRegex, suggestHumanFeedback } from "../core/monitor/suggestions.js";

// Mounted at /api/v1/agent-monitoring — the paths AgentX-web-front's dashboard actually calls
// (src/data/apiPaths.ts's getMonitoring*/*MonitoringProfile/*MonitoringPattern), a different
// dialect from the SDK-facing /api/v1/monitor router (routes/monitor.ts): same underlying core
// logic, different response envelope/query params to match what the dashboard's data hooks
// expect. Third slice: the first was Observe-only (signals/patterns listing), the second added
// AgentsTab + pattern CRUD, this one adds signal detail/triage/feedback + the two LLM-assist
// endpoints (regex generation, feedback drafting) + a credit-estimate stub (self-host has no
// billing, see /estimate below). Still out of scope: create-evaluator-from-signal and
// suggest-expected-results (both depend on Evaluate, which doesn't exist on this engine yet),
// the autotune/"Improve" proposal system, and OverviewTab's kpis/trend/top-failing (needs a
// proper per-occurrence event log to compute honestly over time windows — the current
// monitor_signals table only stores deduped aggregates, not a timestamped history). See README's
// Status section.
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

// Self-host has no billing/credits concept at all — this only exists so
// DraftEvaluatorDialog.tsx's unconditional on-mount estimate call doesn't 404. Confirmed the
// frontend only reads `estimatedCredits` behind a `typeof === "number"` guard and renders nothing
// when it's absent, so a flat 0 is enough to keep that dialog's UI correct rather than
// implementing a self-host credit system that doesn't apply here.
agentMonitoringDashboardRouter.post("/estimate", async (req: Request, res: Response) => {
  res.status(200).json({ action: req.body?.action, estimatedCredits: 0 });
});
