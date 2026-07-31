import path from "node:path";
import express from "express";
import { ensureLocalApiKey, requireApiKey } from "./auth/apiKey.js";
import { ingestRouter } from "./routes/ingest.js";
import { evaluationsRouter } from "./routes/evaluations.js";
import { monitorRouter } from "./routes/monitor.js";
import { agentMonitoringDashboardRouter } from "./routes/agentMonitoringDashboard.js";
import { initDb } from "./storage/db.js";
import { findWebIndexHtml } from "./web.js";

const PORT = Number(process.env.PORT || 4700);
const isDev = process.argv.includes("--dev");

async function main() {
  const apiKey = ensureLocalApiKey();
  // Awaited once here (picks better-sqlite3 vs bun:sqlite depending on runtime, see db.ts) so
  // every route handler can call the synchronous getDb() without needing to know that.
  await initDb();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Unauthenticated: lets `agentx-server --dev` (and the CLI's launch check) confirm the engine
  // is actually up without needing the API key.
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  app.use("/api/v1/ingest", requireApiKey(apiKey), ingestRouter);
  app.use("/api/v1/custom-agent-evaluations", requireApiKey(apiKey), evaluationsRouter);
  app.use("/api/v1/monitor", requireApiKey(apiKey), monitorRouter);
  app.use("/api/v1/agent-monitoring", requireApiKey(apiKey), agentMonitoringDashboardRouter);

  // Unauthenticated on purpose: self-host has no multi-tenant boundary the API key protects
  // across (one local instance = one implicit tenant, see plan's "Auth" decision), so letting the
  // dashboard fetch its own key on load isn't exposing anything a browser on this machine
  // couldn't already reach some other way. Lets the dashboard skip a login step entirely.
  app.get("/api/v1/dev/bootstrap", (_req, res) => res.status(200).json({ apiKey }));

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

  app.listen(PORT, () => {
    console.log(`AgentX self-host engine listening on http://localhost:${PORT}`);
    console.log(`Local API key: ${apiKey}`);
    console.log(`Point the SDK here with:`);
    console.log(`  AGENTX_API_BASE_URL=http://localhost:${PORT}/api/v1`);
    console.log(`  AGENTX_API_KEY=${apiKey}`);
    if (isDev && !webIndexHtml) {
      console.log(`Dev mode: web UI not found (expected web/index.html next to this checkout).`);
    }
  });
}

main().catch(err => {
  console.error("agentx engine failed to start:", err);
  process.exit(1);
});
