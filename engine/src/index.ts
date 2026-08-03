import path from "node:path";
import type { Server } from "node:http";
import express, { type Express } from "express";
import { ensureLocalApiKey, requireApiKey } from "./auth/apiKey.js";
import { ingestRouter } from "./routes/ingest.js";
import { evaluationsRouter } from "./routes/evaluations.js";
import { monitorRouter } from "./routes/monitor.js";
import { agentMonitoringDashboardRouter } from "./routes/agentMonitoringDashboard.js";
import { evaluateDashboardRouter } from "./routes/evaluateDashboard.js";
import { otlpRouter } from "./routes/otlp.js";
import { initDb, closeDb } from "./storage/db.js";
import { findWebIndexHtml } from "./web.js";

const PORT = Number(process.env.PORT || 4700);
const isDev = process.argv.includes("--dev");

// Plain app.listen(port) has no error handler, so a bind failure is an unhandled 'error' event —
// Node throws and kills the whole process. That's the actual cause of a real bug hit repeatedly
// this session: `tsx watch` fires a new restart (new file save) before the *previous* restart
// cycle has fully settled — the old process is still in the middle of releasing the port when the
// new one tries to bind — and a transient EADDRINUSE crashes the watcher outright instead of just
// failing one restart. Almost always resolves within a few hundred ms on its own (this is the old
// process finishing its own shutdown, not a real conflict), so retry for a few seconds instead of
// crashing; a port that's still in use after that is treated as a real conflict and surfaces the
// original error normally (main()'s own top-level .catch below). Even in a worse-than-realistic
// stress test — five file saves ~1.2s apart, faster than any actual edit-and-check workflow — this
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
  const apiKey = ensureLocalApiKey();
  // Awaited once here (picks better-sqlite3 vs bun:sqlite depending on runtime, see db.ts) so
  // every route handler can call the synchronous getDb() without needing to know that.
  await initDb();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Access log (method, path, status, duration) for every request. No morgan dependency here —
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

  app.use("/api/v1/ingest", requireApiKey(apiKey), ingestRouter);
  app.use("/api/v1/custom-agent-evaluations", requireApiKey(apiKey), evaluationsRouter);
  app.use("/api/v1/monitor", requireApiKey(apiKey), monitorRouter);
  app.use("/api/v1/agent-monitoring", requireApiKey(apiKey), agentMonitoringDashboardRouter);
  app.use("/api/v1/evaluate", requireApiKey(apiKey), evaluateDashboardRouter);
  app.use("/api/v1/otel", requireApiKey(apiKey), otlpRouter);

  // Unauthenticated on purpose: self-host has no multi-tenant boundary the API key protects
  // across (one local instance = one implicit tenant, see plan's "Auth" decision), so letting the
  // dashboard fetch its own key on load isn't exposing anything a browser on this machine
  // couldn't already reach some other way. Lets the dashboard skip a login step entirely.
  app.get("/api/v1/dev/bootstrap", (_req, res) => res.status(200).json({ apiKey }));

  // The dashboard bundle is AgentX's real, full frontend (see README's "Open source scope"), so
  // it still calls a handful of hosted-SaaS-only endpoints this engine doesn't implement
  // (subscription plans, misc app config, a news feed, ...) as background/best-effort calls.
  // Registered after every real /api/v1/* route above, so it only ever catches genuinely
  // unimplemented ones. Matters because AgentX-web-front's axios interceptor only treats a 404 as
  // safe-to-ignore (no toast) when the response body has `statusCode: 404` (see its
  // initAxios.ts) — Express's default 404 page is HTML with no such field, so without this every
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
  console.log(`AgentX self-host engine listening on http://localhost:${PORT}`);
  console.log(`Local API key: ${apiKey}`);
  console.log(`Point the SDK here with:`);
  console.log(`  AGENTX_API_BASE_URL=http://localhost:${PORT}/api/v1`);
  console.log(`  AGENTX_API_KEY=${apiKey}`);
  if (isDev && !webIndexHtml) {
    console.log(`Dev mode: web UI not found (expected web/index.html next to this checkout).`);
  }

  // Ctrl+C (SIGINT) / `kill` (SIGTERM, also what `tsx watch` sends the old process on every file
  // save before spawning the new one) otherwise hard-kill the process mid-request and leave
  // SQLite's WAL file unflushed. Stop accepting new connections, let in-flight ones finish, then
  // release the DB handle.
  //
  // server.close()'s callback only fires once every *existing* connection closes on its own —
  // Node's http.Server doesn't drop idle keep-alive sockets just because you stopped listening,
  // and a dashboard tab left open (or the SDK's own keep-alive HTTP client) can easily hold one
  // open indefinitely. In production that's the right default; here it's the actual cause of a
  // real bug hit repeatedly this session: tsx watch's restart sends SIGTERM, close() never
  // resolves before tsx watch's own patience runs out and SIGKILLs the old process instead
  // (skipping this handler entirely), and the new process's app.listen() then races the OS for a
  // port the old one hasn't fully released yet — an unhandled EADDRINUSE 'error' event, which
  // crashes the whole watcher rather than just failing one restart.
  //
  // closeIdleConnections() (Node 18.2+) fires right away and unblocks the common case (no request
  // actually in flight, just an idle keep-alive socket) immediately. A short fallback escalates to
  // closeAllConnections() (drops even active requests) if something is still genuinely in flight,
  // well before tsx watch's own patience — and before the final hard exit, which should now be
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
