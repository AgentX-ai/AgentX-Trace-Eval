import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { listPatternsWire } from "../core/monitor/patterns.js";
import { builtInPatternsWire } from "../core/monitor/detect.js";
import { listSignals } from "../core/monitor/signals.js";

// Mounted at /api/v1/agent-monitoring — the paths AgentX-web-front's dashboard actually calls
// (src/data/apiPaths.ts's getMonitoringSignals/getMonitoringPatterns), a different dialect from
// the SDK-facing /api/v1/monitor router (routes/monitor.ts): same underlying data
// (listSignals/listPatternsWire/builtInPatternsWire, all reused as-is), different response
// envelope/query params to match what the dashboard's data hooks expect. Read-only for this
// first slice (Observe tab): pattern/profile CRUD from the dashboard UI is a later pass, see the
// plan's "explicit follow-ups" note.
export const agentMonitoringDashboardRouter = Router();

agentMonitoringDashboardRouter.get("/signals", async (req: Request, res: Response) => {
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

agentMonitoringDashboardRouter.get("/patterns", async (_req: Request, res: Response) => {
  const custom = await listPatternsWire(getDb());
  res.status(200).json({ patterns: [...builtInPatternsWire(), ...custom] });
});
