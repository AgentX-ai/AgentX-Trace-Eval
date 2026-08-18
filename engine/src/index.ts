import path from "node:path";
import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { requireApiKey } from "./auth/apiKey.js";
import { asyncHandler } from "./routes/asyncRouter.js";
import { rateLimit, CREDENTIAL_LIMIT, DATA_PLANE_LIMIT } from "./auth/rateLimit.js";
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
import { finishMcpAuth } from "./core/evaluate/mcp.js";
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
import { findWebIndexHtml, downloadWebBundle } from "./web.js";
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

  // Two ceilings, see auth/rateLimit.ts. credentialLimit covers anything that hands out or is
  // guarded by a credential; dataPlaneLimit sits far above any real SDK burst, because throttling
  // ingest would drop the telemetry this engine exists to keep.
  const credentialLimit = rateLimit(CREDENTIAL_LIMIT);
  const dataPlaneLimit = rateLimit(DATA_PLANE_LIMIT);

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

  app.use(express.json({ limit: "10mb" }));

  // Remote-MCP OAuth callback (core/evaluate/mcp.ts): the consent popup's redirect target.
  // Unauthenticated by necessity - the MCP server's authorization server redirects the USER'S
  // BROWSER here with only code+state; state is the engine-minted session id, and the session
  // store (15-minute TTL, in-memory) is the actual authority on what the code can do.
  app.get("/api/v1/mcp-oauth/callback", credentialLimit, asyncHandler(async (req, res) => {
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
  app.get("/health", dataPlaneLimit, (_req, res) => res.status(200).json({ status: "ok" }));

  // requireApiKey() is async too (it reads the projects table), so it can reject the same way a
  // route handler can - see routes/asyncRouter.ts.
  const apiKey = asyncHandler(requireApiKey());

  app.use("/api/v1/ingest", dataPlaneLimit, apiKey, ingestRouter);
  app.use("/api/v1/custom-agent-evaluations", dataPlaneLimit, apiKey, evaluationsRouter);
  app.use("/api/v1/monitor", dataPlaneLimit, apiKey, monitorRouter);
  app.use("/api/v1/agents", dataPlaneLimit, apiKey, agentsRouter);
  app.use("/api/v1/outcomes", dataPlaneLimit, apiKey, outcomesRouter);
  app.use("/api/v1/feedback", dataPlaneLimit, apiKey, feedbackRouter);
  app.use("/api/v1/agent-monitoring", dataPlaneLimit, apiKey, agentMonitoringDashboardRouter);
  app.use("/api/v1/evaluate", dataPlaneLimit, apiKey, evaluateDashboardRouter);
  app.use("/api/v1/otel", dataPlaneLimit, apiKey, otlpRouter);

  // Unauthenticated on purpose, same "skip a login step entirely" zero-setup UX the single-key
  // model always had - now specifically hands back the *Default* project's key (whichever project
  // the one-time migration created first, core/project/projects.ts's getDefaultProject). Any
  // additional project you register is only reachable via its own key from then on; this endpoint
  // never lists or exposes every project's key, only the one a fresh/never-configured client
  // should bootstrap into.
  app.get("/api/v1/dev/bootstrap", credentialLimit, asyncHandler(async (_req, res) => {
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
  }));

  // Unauthenticated for the same reason /dev/bootstrap is: self-host's whole security model is
  // "if you can reach this local port, you're trusted" (one machine, one operator) - gatekeeping
  // *creating* a new project specifically wouldn't protect anything /dev/bootstrap's already-open
  // key doesn't already expose. No rename/delete routes yet - full project-management UI is still
  // follow-up work. Returns the new project's key in full since the caller just created it and has
  // to learn it from somewhere.
  app.post("/api/v1/projects", credentialLimit, asyncHandler(async (req, res) => {
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
  }));

  // The frontend's project switcher's list source (AgentX-web-front's ProjectProvider) - same
  // unauthenticated posture as the two routes above, deliberately includes every project's own
  // apiKey so the switcher can hold each project's key up front and swap the x-api-key header on
  // switch, with no separate per-project auth handshake.
  app.get("/api/v1/projects", credentialLimit, asyncHandler(async (req, res) => {
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
  }));

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

  // Dev mode with no web/ (fresh source checkout): fetch the released dashboard bundle once so
  // `yarn dev --dev` boots with the full UI instead of API-only plus a manual curl|tar step.
  let webIndexHtml = findWebIndexHtml();
  if (!webIndexHtml && isDev) {
    webIndexHtml = await downloadWebBundle();
  }
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

  // Last stop for anything a handler threw or rejected with. Registered after every route,
  // because Express only reaches an error handler that comes AFTER the failing layer. Same
  // statusCode-carrying JSON shape as the /api 404 above (AgentX-web-front's axios interceptor
  // reads it). `next` is unused but must stay declared - Express detects error middleware by arity.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // %s placeholders, not interpolation: a URL containing "%s" would otherwise be read as a
    // format specifier and swallow the error argument that follows.
    console.error("Unhandled error in %s %s:", req.method, req.originalUrl, err);
    // Handlers that respond and then keep working (routes/ingest.ts's POST /traces) can fail with
    // the response already on the wire - nothing left to send.
    if (res.headersSent) {
      return;
    }
    // body-parser throws with its own 4xx status (400 parse.failed, 413 too.large, 415 charset).
    // Flattening those to 500 would blame the server for the client's bad request.
    const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ statusCode: status, message: err instanceof Error ? err.message : "Bad request" });
      return;
    }
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  });

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
    console.log(`Fetch it manually with:`);
    console.log(
      `  mkdir -p web && curl -fsSL https://github.com/AgentX-ai/AgentX-Trace-Eval/releases/latest/download/agentx-web.tar.gz | tar -xz -C web`
    );
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

// Defence in depth behind the per-request handling above. Node exits on an unhandled rejection,
// which turns any one missed `await` - a background sweep, a detached check, a library's timer -
// into an outage for every project on the box. Log it loudly and keep serving.
process.on("unhandledRejection", reason => {
  console.error("Unhandled promise rejection (engine kept running):", reason);
});
// An uncaught exception keeps Node's fatal default: it can leave whatever threw halfway through,
// and carrying on from there is how a crash becomes silent corruption. This only adds the log
// line. (SQLite is safe: WAL mode is crash-safe, it is the checkpoint that is skipped.)
process.on("uncaughtException", err => {
  console.error("Uncaught exception, exiting:", err);
  process.exit(1);
});

main().catch(err => {
  console.error("agentx engine failed to start:", err);
  process.exit(1);
});
