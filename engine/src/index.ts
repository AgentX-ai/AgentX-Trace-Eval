import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { requireApiKey } from "./auth/apiKey.js";
import { asyncHandler } from "./routes/asyncRouter.js";
import { rateLimit, CREDENTIAL_LIMIT, DATA_PLANE_LIMIT } from "./auth/rateLimit.js";
import { initDb, closeDb, getDb, withProjectId } from "./storage/db.js";
import { getDefaultProject, listProjectRows } from "./core/project/projects.js";
import { ensureSessionBaselineJudge } from "./core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs, metricPackBackfillDone, markMetricPackBackfillDone } from "./core/evaluate/metricPack.js";
import { authMode, initAuth, resolveAuthSecret } from "./auth/betterAuth.js";
import { registerAuthRoutes, registerApiV1 } from "./routes/apiV1.js";
import { findWebIndexHtml, downloadWebBundle } from "./web.js";
import { startSessionSweep } from "./core/monitor/sessionSweep.js";
import { startImprovementSweep } from "./core/evaluate/improvementSweep.js";
import { logger } from "./log.js";

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
  // Boot-window shutdown: the port starts answering (listenWithRetry below) BEFORE the real
  // drain-and-flush handlers register at the end of main, and the per-project bootstraps in
  // between can take real time (slower still under coverage instrumentation). A SIGTERM landing
  // in that window - a container manager stopping a just-started engine, the test harness - used
  // to take Node's default disposition: hard kill, exit 143, WAL unflushed. These early handlers
  // close the DB and exit 0; the real handlers replace them once the server can drain properly.
  const earlyShutdown = (signal: NodeJS.Signals) => {
    logger.info(`${signal} received during boot, closing the database and exiting.`);
    void Promise.resolve()
      .then(() => closeDb())
      .catch((err: unknown) => logger.error({ err }, "Error closing database during boot shutdown"))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", earlyShutdown);
  process.on("SIGTERM", earlyShutdown);

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

  registerAuthRoutes(app, credentialLimit);

  app.use(express.json({ limit: "10mb" }));

  const ACCESS_LOG_IGNORE = ["/health"];
  app.use((req, res, next) => {
    const start = Date.now();
    // One structured line per request with a correlation id; the id is echoed in the
    // X-Request-Id header so an operator can match a browser failure to its log line.
    const reqId = randomUUID();
    res.setHeader("X-Request-Id", reqId);
    res.on("finish", () => {
      if (ACCESS_LOG_IGNORE.includes(req.path)) return;
      logger.info(
        {
          reqId,
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          ms: Date.now() - start,
          projectId: (req as Request & { projectId?: string }).projectId ?? null,
        },
        "request"
      );
    });
    next();
  });

  app.get("/health", dataPlaneLimit, (_req, res) => res.status(200).json({ status: "ok" }));

  const apiKey = asyncHandler(requireApiKey());

  registerApiV1(app, { credentialLimit, dataPlaneLimit, apiKey });

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
    app.use(express.static(webDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(webIndexHtml));
  }

  // Last stop for anything a handler threw or rejected with. Registered after every route,
  // because Express only reaches an error handler that comes AFTER the failing layer. Same
  // statusCode-carrying JSON shape as the /api 404 above (AgentX-web-front's axios interceptor
  // reads it). `next` is unused but must stay declared - Express detects error middleware by arity.
   
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled request error");
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
  logger.info(`AgentX self-host engine listening on http://localhost:${PORT}`);
  logger.info(`Default project API key: ${defaultProject?.apiKey}`);
  logger.info(`Point the SDK here with:`);
  logger.info(`  AGENTX_API_BASE_URL=http://localhost:${PORT}/api/v1`);
  logger.info(`  AGENTX_API_KEY=${defaultProject?.apiKey}`);
  // Printed in both modes, not just dev: web/ isn't committed, so a source checkout started with
  // `yarn start` (no --dev, hence no auto-download) serves the API fine and 404s every non-API
  // GET. Without this the only symptom is a bare "Cannot GET /" in the browser and nothing at all
  // in the log to explain it.
  if (!webIndexHtml) {
    logger.info(`Web UI not found (expected web/index.html next to this checkout) - serving the API only.`);
    logger.info(isDev ? `Fetch it manually with:` : `Start with \`yarn dev --dev\` to fetch it automatically, or fetch it manually with:`);
    logger.info(
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
    logger.info(`\n${signal} received, shutting down gracefully...`);
    const forceExit = setTimeout(() => {
      logger.error("Shutdown timed out after 10s, forcing exit.");
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
        logger.error({ err: err }, "Error while closing HTTP server:");
      }
      try {
        await closeDb();
      } catch (dbErr) {
        logger.error({ err: dbErr }, "Error while closing database:");
      }
      clearTimeout(forceExit);
      logger.info("Shutdown complete.");
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };
  process.removeListener("SIGINT", earlyShutdown);
  process.removeListener("SIGTERM", earlyShutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Defence in depth behind the per-request handling above. Node exits on an unhandled rejection,
// which turns any one missed `await` - a background sweep, a detached check, a library's timer -
// into an outage for every project on the box. Log it loudly and keep serving.
process.on("unhandledRejection", reason => {
  logger.error({ err: reason }, "Unhandled promise rejection (engine kept running):");
});
// An uncaught exception keeps Node's fatal default: it can leave whatever threw halfway through,
// and carrying on from there is how a crash becomes silent corruption. This only adds the log
// line. (SQLite is safe: WAL mode is crash-safe, it is the checkpoint that is skipped.)
process.on("uncaughtException", err => {
  logger.error({ err: err }, "Uncaught exception, exiting:");
  process.exit(1);
});

main().catch(err => {
  logger.error({ err: err }, "agentx engine failed to start:");
  process.exit(1);
});
