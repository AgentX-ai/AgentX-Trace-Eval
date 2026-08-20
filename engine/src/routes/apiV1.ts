import type { Express, RequestHandler } from "express";
import { Router } from "express";
import { toNodeHandler } from "better-auth/node";
import { asyncHandler } from "./asyncRouter.js";
import { ingestRouter } from "./ingest.js";
import { evaluationsRouter } from "./evaluations.js";
import { monitorRouter } from "./monitor.js";
import { agentsRouter } from "./agents.js";
import { outcomesRouter } from "./outcomes.js";
import { feedbackRouter } from "./feedback.js";
import { agentMonitoringDashboardRouter } from "./agentMonitoringDashboard.js";
import { evaluateDashboardRouter } from "./evaluateDashboard.js";
import { otlpRouter } from "./otlp.js";
import { getDb, withProjectId } from "../storage/db.js";
import {
  createProject,
  listProjectsWire,
  listProjectsWireForOrgs,
  resolveProjectByApiKey,
} from "../core/project/projects.js";
import { ensureSessionBaselineJudge } from "../core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs } from "../core/evaluate/metricPack.js";
import { finishMcpAuth } from "../core/evaluate/mcp.js";
import {
  authMode,
  getAuth,
  getSessionUser,
  getUserOrganizationIds,
  needsSetup,
} from "../auth/betterAuth.js";

export type ApiV1Deps = {
  credentialLimit: RequestHandler;
  dataPlaneLimit: RequestHandler;
  apiKey: RequestHandler;
};

export function registerAuthRoutes(app: Express, credentialLimit: RequestHandler): void {

  app.get("/api/v1/auth/config", credentialLimit, asyncHandler(async (_req, res) => {
    const mode = authMode();
    res.status(200).json({
      mode,
      needsSetup: mode === "enabled" ? await needsSetup(getDb()) : false,
    });
  }));
  if (authMode() === "enabled") {
    app.all("/api/v1/auth/*", credentialLimit, toNodeHandler(getAuth()));
  }
}

export function registerApiV1(app: Express, deps: ApiV1Deps): void {
  const { credentialLimit, dataPlaneLimit, apiKey } = deps;
  const router = Router();

  router.get("/mcp-oauth/callback", credentialLimit, asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const fail = (message: string) =>
      res
        .status(400)
        .send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>Authorization failed</h3><p>${message.replace(/</g, "&lt;")}</p><p>Close this window and try again.</p></body>`);
    if (!code || !state) {
      fail(typeof req.query.error_description === "string" ? req.query.error_description : "Missing code or state");
      return;
    }
    const result = await finishMcpAuth(state, code);
    if ("error" in result) {
      fail(result.error);
      return;
    }
    res
      .status(200)
      .send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>Authorized</h3><p>You can close this window - the dashboard will continue automatically.</p><script>setTimeout(function(){window.close()},800)</script></body>`);
  }));

  router.post("/projects", credentialLimit, asyncHandler(async (req, res) => {
    let organizationId: string | null = null;
    if (authMode() === "enabled") {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Sign in to create a project" });
        return;
      }
      const orgs = await getUserOrganizationIds(user.id);
      if (orgs.length === 0) {
        res.status(403).json({ error: "No organization membership" });
        return;
      }
      organizationId = orgs[0] ?? null;
    }
    const body = req.body ?? {};
    if (typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const project = await createProject(getDb(), body.name.trim(), organizationId);
    await ensureSessionBaselineJudge(withProjectId(getDb(), project._id));
    await ensureMetricPackConfigs(withProjectId(getDb(), project._id));
    res.status(201).json({ project });
  }));

  router.get("/projects", credentialLimit, asyncHandler(async (req, res) => {
    if (authMode() === "enabled") {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Sign in to list projects" });
        return;
      }
      const projects = await listProjectsWireForOrgs(getDb(), await getUserOrganizationIds(user.id));
      res.status(200).json({ projects });
      return;
    }
    const provided = req.header("x-api-key");
    const caller = provided ? await resolveProjectByApiKey(getDb(), provided) : null;
    if (!caller) {
      res.status(401).json({ error: "Provide a valid project API key (printed at engine startup)" });
      return;
    }
    const projects = await listProjectsWire(getDb());
    res.status(200).json({ projects });
  }));

  router.use("/ingest", dataPlaneLimit, apiKey, ingestRouter);
  router.use("/custom-agent-evaluations", dataPlaneLimit, apiKey, evaluationsRouter);
  router.use("/monitor", dataPlaneLimit, apiKey, monitorRouter);
  router.use("/agents", dataPlaneLimit, apiKey, agentsRouter);
  router.use("/outcomes", dataPlaneLimit, apiKey, outcomesRouter);
  router.use("/feedback", dataPlaneLimit, apiKey, feedbackRouter);
  router.use("/agent-monitoring", dataPlaneLimit, apiKey, agentMonitoringDashboardRouter);
  router.use("/evaluate", dataPlaneLimit, apiKey, evaluateDashboardRouter);
  router.use("/otel", dataPlaneLimit, apiKey, otlpRouter);

  app.use("/api/v1", router);
}
