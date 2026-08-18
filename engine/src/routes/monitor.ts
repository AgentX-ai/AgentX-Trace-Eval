import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { validateSeverityParam } from "../core/shared/severity.js";
import { scopedDb } from "../auth/apiKey.js";
import { createPattern, getPattern, listPatternsWire, legacyPayloadToConditions } from "../core/monitor/patterns.js";
import { builtInPatternsWire } from "../core/monitor/detect.js";
import { validateConditionRegexes } from "../core/monitor/regexSafety.js";
import { getProfile, updateProfile } from "../core/monitor/profiles.js";
import { resolveAgentId, resolveExistingAgentId, resolveAgentIds } from "../core/monitor/agents.js";
import { listSignals, getSignal } from "../core/monitor/signals.js";
import {
  createOnlineEvaluator,
  listOnlineEvaluatorsWire,
  getOnlineEvaluator,
  updateOnlineEvaluator,
  deleteOnlineEvaluator,
  InvalidEvaluationSettingsIdError,
} from "../core/monitor/onlineEvaluators.js";
import { getOnlineEvaluatorRatings, getOnlineEvaluatorEvents, type MonitoringWindow } from "../core/monitor/events.js";

// Mounted at /api/v1/monitor, matching AgentX-Python's MonitorClient base URL
// (agentx/monitor/client.py appends "/monitor" to AGENTX_API_BASE_URL if not already present).
export const monitorRouter = asyncRouter();

// Reject invalid severities once for every mutating route on this router (pattern / online
// evaluator / custom evaluator create+update, signal triage edits) - the dashboard's pickers
// already restrict to the four valid values, this closes the REST gap where any string produced
// signals the severity chips and filters can't render.
monitorRouter.use((req: Request, res: Response, next) => {
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const check = validateSeverityParam(req.body?.severity);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
  }
  next();
});


monitorRouter.post("/patterns", async (req: Request, res: Response) => {
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
  });
  res.status(201).json({ pattern });
});

monitorRouter.get("/patterns", async (req: Request, res: Response) => {
  const custom = await listPatternsWire(scopedDb(req));
  res.status(200).json({ patterns: [...builtInPatternsWire(), ...custom] });
});

monitorRouter.get("/patterns/:id", async (req: Request, res: Response) => {
  const pattern = await getPattern(scopedDb(req), req.params.id!);
  if (!pattern) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }
  res.status(200).json({ pattern });
});

monitorRouter.get("/profiles/:agentId", async (req: Request, res: Response) => {
  const agentId = await resolveAgentId(scopedDb(req), req.params.agentId!);
  const profile = await getProfile(scopedDb(req), agentId);
  res.status(200).json({ profile: profile ?? null });
});

monitorRouter.put("/profiles/:agentId", async (req: Request, res: Response) => {
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
    redactionMode: body.redactionMode,
    thresholdOverrides: body.thresholdOverrides,
    approvalPolicy: body.approvalPolicy,
  });
  res.status(200).json({ profile });
});

monitorRouter.get("/signals", async (req: Request, res: Response) => {
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

monitorRouter.get("/signals/:id", async (req: Request, res: Response) => {
  const signal = await getSignal(scopedDb(req), req.params.id!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  res.status(200).json({ signal });
});

function parseWindow(req: Request): MonitoringWindow {
  const raw = req.query.window;
  return raw === "24h" || raw === "30d" ? raw : "7d";
}

// Online evaluators (core/monitor/onlineEvaluators.ts): a judge scored continuously against
// sampled live traffic, distinct from pattern-matching above. CRUD mirrors /patterns' shape;
// previously dashboard-only (routes/agentMonitoringDashboard.ts), added here so
// client.monitor.online_evaluators works the same way client.monitor.patterns already does.
monitorRouter.post("/online-evaluators", async (req: Request, res: Response) => {
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

monitorRouter.get("/online-evaluators", async (req: Request, res: Response) => {
  const evaluators = await listOnlineEvaluatorsWire(scopedDb(req));
  res.status(200).json({ evaluators });
});

monitorRouter.get("/online-evaluators/:id", async (req: Request, res: Response) => {
  const evaluator = await getOnlineEvaluator(scopedDb(req), req.params.id!);
  if (!evaluator) {
    res.status(404).json({ error: "Online evaluator not found" });
    return;
  }
  res.status(200).json({ evaluator });
});

monitorRouter.put("/online-evaluators/:id", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.evaluationSettingsId !== undefined && (typeof body.evaluationSettingsId !== "string" || !body.evaluationSettingsId.trim())) {
    res.status(400).json({ error: "evaluationSettingsId must be a non-empty string" });
    return;
  }
  try {
    const evaluator = await updateOnlineEvaluator(scopedDb(req), req.params.id!, {
      name: body.name,
      evaluationSettingsId: body.evaluationSettingsId,
      sampleRate: body.sampleRate,
      scopeMode: body.scopeMode,
      agentIds: await resolveAgentIds(scopedDb(req), body.agentIds),
      enabled: body.enabled,
      alertThreshold: body.alertThreshold,
      severity: body.severity,
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

monitorRouter.delete("/online-evaluators/:id", async (req: Request, res: Response) => {
  const deleted = await deleteOnlineEvaluator(scopedDb(req), req.params.id!);
  if (!deleted) {
    res.status(404).json({ error: "Online evaluator not found" });
    return;
  }
  res.status(204).send();
});

monitorRouter.get("/online-evaluators/:id/ratings", async (req: Request, res: Response) => {
  res.status(200).json(await getOnlineEvaluatorRatings(scopedDb(req), req.params.id!, parseWindow(req)));
});

monitorRouter.get("/online-evaluators/:id/events", async (req: Request, res: Response) => {
  res.status(200).json(await getOnlineEvaluatorEvents(scopedDb(req), req.params.id!, parseWindow(req)));
});
