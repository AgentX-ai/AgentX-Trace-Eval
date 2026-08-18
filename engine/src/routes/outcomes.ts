import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import { createOutcomeReport } from "../core/outcomes/outcomeReports.js";

// Mounted at /api/v1/outcomes - a fresh top-level prefix, same reasoning as agents.ts: outcome
// reporting isn't specific to Monitor or Evaluate, it's the fact those two surfaces get measured
// against (core/monitor/outcomeCalibration.ts). The intended caller is a system AgentX doesn't
// own - e.g. a ServiceNow workflow firing on "incident reopened" - reporting a real-world result
// back against a traceId, days or weeks after the original trace/eval ran. Auth is the same
// project API key every other route uses; no separate webhook-signing scheme, matching this
// engine's existing "one API key, no per-integration secrets" posture.
export const outcomesRouter = asyncRouter();

outcomesRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.outcome !== "string" || !body.outcome.trim()) {
    res.status(400).json({ error: "outcome is required" });
    return;
  }
  if (typeof body.isNegative !== "boolean") {
    res.status(400).json({ error: "isNegative (boolean) is required" });
    return;
  }
  if (!body.traceId && !body.evaluationRunResultId) {
    res.status(400).json({ error: "traceId or evaluationRunResultId is required" });
    return;
  }
  const report = await createOutcomeReport(scopedDb(req), {
    traceId: typeof body.traceId === "string" ? body.traceId : undefined,
    evaluationRunResultId: typeof body.evaluationRunResultId === "string" ? body.evaluationRunResultId : undefined,
    outcome: body.outcome,
    isNegative: body.isNegative,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    reportedBy: typeof body.reportedBy === "string" ? body.reportedBy : undefined,
  });
  res.status(201).json({ report });
});
