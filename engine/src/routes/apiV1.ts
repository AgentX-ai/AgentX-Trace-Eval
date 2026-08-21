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
  deleteProject,
  getDefaultProject,
  getProjectRow,
  listProjectRows,
  listProjectsWire,
  listProjectsWireForOrgs,
  resolveProjectByApiKey,
} from "../core/project/projects.js";
import { ensureSessionBaselineJudge } from "../core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs } from "../core/evaluate/metricPack.js";
import { finishMcpAuth } from "../core/evaluate/mcp.js";
import { authOrgRouter } from "./authOrg.js";
import { adminRouter } from "./admin.js";
import {
  authMode,
  enabledSocialProviders,
  getAuth,
  getSessionUser,
  getUserOrganizationIds,
  needsSetup,
  verificationRequired,
} from "../auth/betterAuth.js";
import { mailerConfigured } from "../auth/mailer.js";

export type ApiV1Deps = {
  credentialLimit: RequestHandler;
  dataPlaneLimit: RequestHandler;
  apiKey: RequestHandler;
};

export function registerAuthRoutes(app: Express, credentialLimit: RequestHandler): void {

  app.get("/api/v1/auth/config", credentialLimit, asyncHandler(async (_req, res) => {
    const mode = authMode();
    // Disabled mode hands the default project's key straight to the dashboard so a fresh
    // install lands on a working screen with zero setup (no paste-the-key stop). Deliberate
    // tradeoff, documented in the README: in disabled mode anyone who can reach this port
    // already owns the instance in practice, so gating the dashboard behind a key the same
    // port would print anyway added a step without adding protection. Multi-user or exposed
    // deployments use AGENTX_AUTH=enabled, where no key is ever handed out.
    const defaultProject = mode === "disabled" ? await getDefaultProject(getDb()) : null;
    res.status(200).json({
      mode,
      needsSetup: mode === "enabled" ? await needsSetup(getDb()) : false,
      ...(defaultProject ? { apiKey: defaultProject.apiKey } : {}),
      // Enabled-mode capabilities the auth screens render from: which social buttons to show,
      // whether "Forgot password?" works (needs a mailer), whether signup requires verification.
      ...(mode === "enabled"
        ? {
            socialProviders: enabledSocialProviders(),
            emailEnabled: mailerConfigured(),
            verificationRequired: verificationRequired(),
          }
        : {}),
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

  // Destructive and irreversible - every trace, agent, dataset, prompt and evaluation scoped to
  // the project goes with it (core/project/projects.ts's deleteProject). Two rows are refused
  // outright rather than left to the caller's judgement: the default project, whose key is what
  // the startup log prints and the SDK docs reference, and the last remaining project, which
  // would leave the instance with no key that resolves at all.
  router.delete("/projects/:id", credentialLimit, asyncHandler(async (req, res) => {
    const id = req.params.id ?? "";
    const target = id ? await getProjectRow(getDb(), id) : null;
    if (!target) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (authMode() === "enabled") {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Sign in to delete a project" });
        return;
      }
      const orgs = await getUserOrganizationIds(user.id);
      if (!target.organizationId || !orgs.includes(target.organizationId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
    } else {
      const provided = req.header("x-api-key");
      const caller = provided ? await resolveProjectByApiKey(getDb(), provided) : null;
      if (!caller) {
        res.status(401).json({ error: "Provide a valid project API key (printed at engine startup)" });
        return;
      }
    }
    if (target.isDefault) {
      res.status(400).json({ error: "The default project cannot be deleted" });
      return;
    }
    if ((await listProjectRows(getDb())).length <= 1) {
      res.status(400).json({ error: "Cannot delete the only remaining project" });
      return;
    }
    await deleteProject(getDb(), id);
    res.status(204).end();
  }));

  router.use("/ingest", dataPlaneLimit, apiKey, ingestRouter);
  router.use("/custom-agent-evaluations", dataPlaneLimit, apiKey, evaluationsRouter);
  router.use("/monitor", dataPlaneLimit, apiKey, monitorRouter);
  router.use("/agents", dataPlaneLimit, apiKey, agentsRouter);
  router.use("/outcomes", dataPlaneLimit, apiKey, outcomesRouter);
  router.use("/feedback", dataPlaneLimit, apiKey, feedbackRouter);
  // Account-plane org/membership routes: session-authenticated, enabled mode only (mounting in
  // disabled mode would just 401 everything - there are no sessions to authenticate).
  if (authMode() === "enabled") {
    router.use("/auth-org", credentialLimit, authOrgRouter);
  }
  // Operator admin (inert without AGENTX_ADMIN_TOKEN - see routes/admin.ts).
  router.use("/admin", credentialLimit, adminRouter);
  router.use("/agent-monitoring", dataPlaneLimit, apiKey, agentMonitoringDashboardRouter);
  router.use("/evaluate", dataPlaneLimit, apiKey, evaluateDashboardRouter);
  router.use("/otel", dataPlaneLimit, apiKey, otlpRouter);

  app.use("/api/v1", router);
}
