import { Router, type Request, type Response } from "express";
import { scopedDb } from "../auth/apiKey.js";
import { createAgent, getAgent, listAgentsWire } from "../core/monitor/agents.js";

// Mounted at /api/v1/agents — a fresh top-level prefix, not nested under /monitor (agent identity
// isn't monitor-specific: it's the relation monitor_profiles/monitor_patterns/monitor_signals/
// monitor_classifications all key off, but the concept itself belongs to none of them in
// particular). Matches AgentX-Python's new client.agents (agentx/agents/client.py) the same way
// monitorRouter matches client.monitor.* — a thin router reusing the same core/monitor/agents.ts
// functions the dashboard router (agentMonitoringDashboard.ts) calls, not a separate
// implementation.
export const agentsRouter = Router();

agentsRouter.get("/", async (req: Request, res: Response) => {
  const agents = await listAgentsWire(scopedDb(req));
  res.status(200).json({ agents });
});

// Always creates a new row, even if an agent with this name already exists — the only way to end
// up with two agents sharing a display name (client.agents.register(name=...)). The implicit path
// (tracing under a bare name with no explicit agent_id) keeps resolving to a single, stable agent
// per distinct name via resolveAgentId, unchanged from before this registry existed.
agentsRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const agent = await createAgent(scopedDb(req), body.name.trim());
  res.status(201).json({ agent });
});

agentsRouter.get("/:id", async (req: Request, res: Response) => {
  const agent = await getAgent(scopedDb(req), req.params.id!);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.status(200).json({ agent });
});
