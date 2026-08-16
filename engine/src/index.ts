import path from "node:path";
import type { Server } from "node:http";
import express, { type Express } from "express";
import { requireApiKey } from "./auth/apiKey.js";
import { ingestRouter } from "./routes/ingest.js";
import { evaluationsRouter } from "./routes/evaluations.js";
import { monitorRouter } from "./routes/monitor.js";
import { agentsRouter } from "./routes/agents.js";
import { outcomesRouter } from "./routes/outcomes.js";
import { feedbackRouter } from "./routes/feedback.js";
import { agentMonitoringDashboardRouter } from "./routes/agentMonitoringDashboard.js";
import { evaluateDashboardRouter } from "./routes/evaluateDashboard.js";
import { otlpRouter } from "./routes/otlp.js";
import { initDb, closeDb, getDb, withProjectId } from "./storage/db.js";
import { getDefaultProject, createProject, listProjectsWire, listProjectsWireForOrgs, listProjectRows } from "./core/project/projects.js";
import { ensureSessionBaselineJudge } from "./core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs, metricPackBackfillDone, markMetricPackBackfillDone } from "./core/evaluate/metricPack.js";
import {
  authMode,
  initAuth,
  getAuth,
  getSessionUser,
  getUserOrganizationIds,
  needsSetup,
  resolveAuthSecret,
} from "./auth/betterAuth.js";
import { toNodeHandler } from "better-auth/node";
import { findWebIndexHtml } from "./web.js";
import { startSessionSweep } from "./core/monitor/sessionSweep.js";
import { startImprovementSweep } from "./core/evaluate/improvementSweep.js";

const PORT = Number(process.env.PORT || 4700);
const isDev = process.argv.includes("--dev");

// Plain app.listen(port) has no error handler, so a bind failure is an unhandled 'error' event -
// Node throws and kills the whole process. That's the actual cause of a real bug hit repeatedly
// this session: `tsx watch` fires a new restart (new file save) before the *previous* restart
// cycle has fully settled - the old process is still in the middle of releasing the port when the
// new one tries to bind - and a transient EADDRINUSE crashes the watcher outright instead of just
// failing one restart. Almost always resolves within a few hundred ms on its own (this is the old
// process finishing its own shutdown, not a real conflict), so retry for a few seconds instead of
// crashing; a port that's still in use after that is treated as a real conflict and surfaces the
// original error normally (main()'s own top-level .catch below). Even in a worse-than-realistic
// stress test - five file saves ~1.2s apart, faster than any actual edit-and-check workflow - this
// still recovers within a couple of retries with zero manual intervention, instead of the old
// behavior of an unhandled crash that killed tsx watch outright and needed a manual `lsof|kill`.
function listenWithRetry(app: Express, port: number, maxAttempts = 20, delayMs = 300): Promise<Server> {
  return new Promise((resolve, reject) => {
    const tryListen = (attempt: number) => {
      const server = app.listen(port);
      server.once("listening", () => resolve(server));
      server.once("error", (err: NodeJS.ErrnoException) => {
        server.removeAllListeners();
        if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
          setTimeout(() => tryListen(attempt + 1), delayMs);
          return;
        }
        reject(err);
      });
    };
    tryListen(1);
  });
}

async function main() {
  // Awaited once here (picks better-sqlite3 vs bun:sqlite depending on runtime, see db.ts) so
  // every route handler can call the synchronous getDb() without needing to know that. Also runs
  // the one-time migration that creates the "Default" project (reusing config.json's pre-existing
  // key if this is an upgrade, see db.ts's backfillDefaultProjectSqlite) - no separate
  // ensureLocalApiKey() step needed anymore, that migration is now self-sufficient for both a
  // fresh install and an upgrade.
  await initDb();

  const app = express();

  // Dashboard auth (core/auth/betterAuth.ts): AGENTX_AUTH=enabled turns on users/orgs/sessions;
  // the default (disabled) keeps the zero-setup "reachable port = trusted" self-host posture with
  // none of this initialized. The auth handler is mounted BEFORE express.json - better-auth reads
  // the raw request body itself, and a pre-consumed stream breaks its sign-in/sign-up routes.
  // /api/v1/auth/config stays OURS (registered first so the wildcard never swallows it) and
  // exists in both modes: it's how the SPA decides between login, owner setup, and no-auth.
  if (authMode() === "enabled") {
    initAuth(getDb(), {
      secret: await resolveAuthSecret(getDb()),
      baseURL: process.env.AGENTX_PUBLIC_URL?.trim() || undefined,
      trustedOrigins: process.env.AGENTX_TRUSTED_ORIGINS?.split(",").map(o => o.trim()).filter(Boolean),
    });
  }
  app.get("/api/v1/auth/config", async (_req, res) => {
    const mode = authMode();
    res.status(200).json({
      mode,
      needsSetup: mode === "enabled" ? await needsSetup(getDb()) : false,
    });
  });
  if (authMode() === "enabled") {
    app.all("/api/v1/auth/*", toNodeHandler(getAuth()));
  }

  app.use(express.json({ limit: "10mb" }));

  // Access log (method, path, status, duration) for every request. No morgan dependency here -
  // engine/ compiles to a single Bun binary (see package.json's `compile` script), so this stays
  // a few plain lines instead of pulling in a package, matching every other log line in this repo
  // (console.log/console.error, no logging framework). Registered first so it covers every
  // request, including ones the catch-all 404 handler below ends up serving.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  // Unauthenticated: lets `agentx-server --dev` (and the CLI's launch check) confirm the engine
  // is actually up without needing the API key.
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use("/api/v1/ingest", requireApiKey(), ingestRouter);
  app.use("/api/v1/custom-agent-evaluations", requireApiKey(), evaluationsRouter);
  app.use("/api/v1/monitor", requireApiKey(), monitorRouter);
  app.use("/api/v1/agents", requireApiKey(), agentsRouter);
  app.use("/api/v1/outcomes", requireApiKey(), outcomesRouter);
  app.use("/api/v1/feedback", requireApiKey(), feedbackRouter);
  app.use("/api/v1/agent-monitoring", requireApiKey(), agentMonitoringDashboardRouter);
  app.use("/api/v1/evaluate", requireApiKey(), evaluateDashboardRouter);
  app.use("/api/v1/otel", requireApiKey(), otlpRouter);

  // Unauthenticated on purpose, same "skip a login step entirely" zero-setup UX the single-key
  // model always had - now specifically hands back the *Default* project's key (whichever project
  // the one-time migration created first, core/project/projects.ts's getDefaultProject). Any
  // additional project you register is only reachable via its own key from then on; this endpoint
  // never lists or exposes every project's key, only the one a fresh/never-configured client
  // should bootstrap into.
  app.get("/api/v1/dev/bootstrap", async (_req, res) => {
    // Enabled-auth mode has no anonymous key handout - that's the whole point of the mode. The
    // dashboard gets keys via the session-guarded /projects route instead.
    if (authMode() === "enabled") {
      res.status(403).json({ error: "Disabled while AGENTX_AUTH=enabled - sign in and use /api/v1/projects" });
      return;
    }
    const defaultProject = await getDefaultProject(getDb());
    if (!defaultProject) {
      res.status(500).json({ error: "No default project - this shouldn't happen after initDb() has run" });
      return;
    }
    res.status(200).json({ apiKey: defaultProject.apiKey });
  });

  // Unauthenticated for the same reason /dev/bootstrap is: self-host's whole security model is
  // "if you can reach this local port, you're trusted" (one machine, one operator) - gatekeeping
  // *creating* a new project specifically wouldn't protect anything /dev/bootstrap's already-open
  // key doesn't already expose. No rename/delete routes yet - full project-management UI is still
  // follow-up work. Returns the new project's key in full since the caller just created it and has
  // to learn it from somewhere.
  app.post("/api/v1/projects", async (req, res) => {
    // Enabled-auth mode: creating a project requires a signed-in user, and the project is owned
    // by their organization from birth.
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
    // Every project ships with its system evaluators and metric-pack configs from birth.
    await ensureSessionBaselineJudge(withProjectId(getDb(), project._id));
    await ensureMetricPackConfigs(withProjectId(getDb(), project._id));
    res.status(201).json({ project });
  });

  // The frontend's project switcher's list source (AgentX-web-front's ProjectProvider) - same
  // unauthenticated posture as the two routes above, deliberately includes every project's own
  // apiKey so the switcher can hold each project's key up front and swap the x-api-key header on
  // switch, with no separate per-project auth handshake.
  app.get("/api/v1/projects", async (req, res) => {
    // Enabled-auth mode: this route hands out project API keys, so it's the one the session
    // strictly guards - keys are scoped to the caller's organizations. Disabled mode keeps the
    // original unauthenticated listing.
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
    const projects = await listProjectsWire(getDb());
    res.status(200).json({ projects });
  });

  // The dashboard bundle is AgentX's real, full frontend (see README's "Open source scope"), so
  // it still calls a handful of hosted-SaaS-only endpoints this engine doesn't implement
  // (subscription plans, misc app config, a news feed, ...) as background/best-effort calls.
  // Registered after every real /api/v1/* route above, so it only ever catches genuinely
  // unimplemented ones. Matters because AgentX-web-front's axios interceptor only treats a 404 as
  // safe-to-ignore (no toast) when the response body has `statusCode: 404` (see its
  // initAxios.ts) - Express's default 404 page is HTML with no such field, so without this every
  // one of those calls surfaced a scary "An error occurred" toast on every page load. Confirmed
  // via a real headless-browser run against this exact bundle, not just curl.
  app.use("/api", (_req, res) => {
    res.status(404).json({ statusCode: 404, message: "Not found" });
  });

  const webIndexHtml = findWebIndexHtml();
  if (webIndexHtml) {
    const webDir = path.dirname(webIndexHtml);
    // express.static serves real built assets (JS/CSS bundles, etc.) and calls next() for
    // anything it doesn't find, falling through to the catch-all below.
    app.use(express.static(webDir));
    // AgentX-web-front uses client-side routing (React Router), so a direct load of e.g.
    // /governance?tab=observe has to still serve index.html, not 404, and let the app's own
    // router take over from there. Registered last, after every /api/v1/* route above, so it
    // only ever catches non-API GETs.
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(webIndexHtml));
  }

  const server = await listenWithRetry(app, PORT);
  // System evaluators, ensured per existing project before the sweeps start (a new project gets
  // its own at creation in POST /projects above). Idempotent - a fast no-op on every boot after
  // the first.
  for (const project of await listProjectRows(getDb())) {
    await ensureSessionBaselineJudge(withProjectId(getDb(), project.id));
  }
  // One-time metric-pack backfill for projects that predate it - flag-gated so a user deleting a
  // pack config afterwards stays deleted (new projects seed at creation instead).
  if (!(await metricPackBackfillDone(getDb()))) {
    for (const project of await listProjectRows(getDb())) {
      await ensureMetricPackConfigs(withProjectId(getDb(), project.id));
    }
    await markMetricPackBackfillDone(getDb());
  }
  // Idle-session sweep for session-scoped Online Evaluators (core/monitor/sessionSweep.ts) -
  // unref'd interval, so it never blocks shutdown. AGENTX_SESSION_SWEEP=false disables.
  startSessionSweep();
  startImprovementSweep();
  const defaultProject = await getDefaultProject(getDb());
  console.log(`AgentX self-host engine listening on http://localhost:${PORT}`);
  console.log(`Default project API key: ${defaultProject?.apiKey}`);
  console.log(`Point the SDK here with:`);
  console.log(`  AGENTX_API_BASE_URL=http://localhost:${PORT}/api/v1`);
  console.log(`  AGENTX_API_KEY=${defaultProject?.apiKey}`);
  if (isDev && !webIndexHtml) {
    console.log(`Dev mode: web UI not found (expected web/index.html next to this checkout).`);
  }

  // Ctrl+C (SIGINT) / `kill` (SIGTERM, also what `tsx watch` sends the old process on every file
  // save before spawning the new one) otherwise hard-kill the process mid-request and leave
  // SQLite's WAL file unflushed. Stop accepting new connections, let in-flight ones finish, then
  // release the DB handle.
  //
  // server.close()'s callback only fires once every *existing* connection closes on its own -
  // Node's http.Server doesn't drop idle keep-alive sockets just because you stopped listening,
  // and a dashboard tab left open (or the SDK's own keep-alive HTTP client) can easily hold one
  // open indefinitely. In production that's the right default; here it's the actual cause of a
  // real bug hit repeatedly this session: tsx watch's restart sends SIGTERM, close() never
  // resolves before tsx watch's own patience runs out and SIGKILLs the old process instead
  // (skipping this handler entirely), and the new process's app.listen() then races the OS for a
  // port the old one hasn't fully released yet - an unhandled EADDRINUSE 'error' event, which
  // crashes the whole watcher rather than just failing one restart.
  //
  // closeIdleConnections() (Node 18.2+) fires right away and unblocks the common case (no request
  // actually in flight, just an idle keep-alive socket) immediately. A short fallback escalates to
  // closeAllConnections() (drops even active requests) if something is still genuinely in flight,
  // well before tsx watch's own patience - and before the final hard exit, which should now be
  // unreachable in practice rather than the normal path.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down gracefully...`);
    const forceExit = setTimeout(() => {
      console.error("Shutdown timed out after 10s, forcing exit.");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    const forceAllConnectionsClosed = setTimeout(() => {
      server.closeAllConnections();
    }, 2_000);
    forceAllConnectionsClosed.unref();
    server.close(async err => {
      clearTimeout(forceAllConnectionsClosed);
      if (err) {
        console.error("Error while closing HTTP server:", err);
      }
      try {
        await closeDb();
      } catch (dbErr) {
        console.error("Error while closing database:", dbErr);
      }
      clearTimeout(forceExit);
      console.log("Shutdown complete.");
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  console.error("agentx engine failed to start:", err);
  process.exit(1);
});
