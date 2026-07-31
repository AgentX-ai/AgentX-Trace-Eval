import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { createPattern, getPattern, listPatternsWire, legacyPayloadToConditions } from "../core/monitor/patterns.js";
import { builtInPatternsWire } from "../core/monitor/detect.js";
import { getProfile, updateProfile } from "../core/monitor/profiles.js";
import { listSignals, getSignal } from "../core/monitor/signals.js";

// Mounted at /api/v1/monitor, matching AgentX-Python's MonitorClient base URL
// (agentx/monitor/client.py appends "/monitor" to AGENTX_API_BASE_URL if not already present).
export const monitorRouter = Router();

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
  const pattern = await createPattern(getDb(), {
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

monitorRouter.get("/patterns", async (_req: Request, res: Response) => {
  const custom = await listPatternsWire(getDb());
  res.status(200).json({ patterns: [...builtInPatternsWire(), ...custom] });
});

monitorRouter.get("/patterns/:id", async (req: Request, res: Response) => {
  const pattern = await getPattern(getDb(), req.params.id!);
  if (!pattern) {
    res.status(404).json({ error: "Pattern not found" });
    return;
  }
  res.status(200).json({ pattern });
});

monitorRouter.get("/profiles/:agentId", async (req: Request, res: Response) => {
  const profile = await getProfile(getDb(), req.params.agentId!);
  res.status(200).json({ profile: profile ?? null });
});

monitorRouter.put("/profiles/:agentId", async (req: Request, res: Response) => {
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
    approvalPolicy: body.approvalPolicy,
  });
  res.status(200).json({ profile });
});

monitorRouter.get("/signals", async (req: Request, res: Response) => {
  const { severity, status, agentId, limit } = req.query;
  const signals = await listSignals(
    getDb(),
    {
      severity: typeof severity === "string" ? severity : undefined,
      status: typeof status === "string" ? status : undefined,
      agentId: typeof agentId === "string" ? agentId : undefined,
    },
    limit ? Math.min(Number(limit) || 50, 100) : 50
  );
  res.status(200).json({ signals });
});

monitorRouter.get("/signals/:id", async (req: Request, res: Response) => {
  const signal = await getSignal(getDb(), req.params.id!);
  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }
  res.status(200).json({ signal });
});
