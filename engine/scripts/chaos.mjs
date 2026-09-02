#!/usr/bin/env node
// Chaos and restore drills (phase 6 of the trace-store plan, docs/runbook.md): kills the
// telemetry store mid-ingest, SIGTERMs the engine mid-burst, and round-trips a ClickHouse
// backup - asserting at each step that the system fails the way the runbook says it does.
// Needs: docker, a free port, and this repo's node_modules. Drives everything itself.
//
//   node scripts/chaos.mjs
//
// Exit 0 = every drill held. Non-zero prints which invariant broke.

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4750;
const CH_PORT = 58124;
const CH_NAME = "agentx-chaos-ch";
const CH_URL = `http://default:agentx@localhost:${CH_PORT}/default`;
const BASE = `http://localhost:${PORT}`;
const HOME = process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/agentx-chaos` : "/tmp/agentx-chaos";

const sh = cmd => execSync(cmd, { stdio: "pipe" }).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures.push(name);
};

let engine = null;
function startEngine() {
  engine = spawn(path.join(ROOT, "../node_modules/.bin/tsx"), [path.join(ROOT, "src/index.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENTX_HOME: HOME,
      AGENTX_RATE_LIMIT: "off",
      AGENTX_TELEMETRY_URL: CH_URL,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  engine.stdout.on("data", d => (out += d));
  engine.stderr.on("data", d => (out += d));
  engine.logs = () => out;
  return engine;
}

async function waitUp(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/v1/auth/config`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function main() {
  // ---- setup ----
  // A leftover engine from a crashed run would answer on our port and invalidate every drill
  // (it did, once): refuse to start over a busy port.
  const busy = await fetch(`${BASE}/api/v1/auth/config`).then(() => true).catch(() => false);
  if (busy) {
    console.error(`Port ${PORT} is already serving - kill the leftover engine first (lsof -ti :${PORT}).`);
    process.exit(2);
  }
  try { sh(`docker rm -f ${CH_NAME}`); } catch {}
  sh(`docker run -d --name ${CH_NAME} -e CLICKHOUSE_PASSWORD=agentx -p ${CH_PORT}:8123 clickhouse/clickhouse-server:24.8-alpine`);
  // Poll for readiness rather than a fixed sleep - a cold CI runner can take longer than any
  // guessed constant, and the engine fails boot loudly on an unreachable backend.
  for (let i = 0; i < 60; i++) {
    const ready = await fetch(`http://localhost:${CH_PORT}/ping`).then(r => r.ok).catch(() => false);
    if (ready) break;
    await sleep(1_000);
  }
  startEngine();
  check("engine boots against ClickHouse", await waitUp());

  const created = await fetch(`${BASE}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "chaos" }),
  }).then(r => r.json());
  const key = created.project.apiKey;
  const headers = { "content-type": "application/json", "x-api-key": key };
  const ingest = (i, extra = {}) =>
    fetch(`${BASE}/api/v1/ingest/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "chaos-agent", input: `q${i}`, output: `a${i}`, span_id: `chaos-${i}`, monitor: false, ...extra }),
    });
  const listCount = async () => {
    const r = await fetch(`${BASE}/api/v1/ingest/traces?limit=100`, { headers }).then(r => r.json());
    return r.traces.length;
  };

  // ---- drill 1: baseline ingest works ----
  for (let i = 0; i < 5; i++) await ingest(i);
  check("baseline: 5 spans stored", (await listCount()) === 5);

  // ---- drill 2: ClickHouse dies mid-traffic -> visible failure, no lies ----
  sh(`docker stop ${CH_NAME}`);
  await sleep(500);
  const down = await ingest(100);
  check("CH down: ingest answers 503, not a fake success", down.status === 503, `got ${down.status}`);
  const downNoSpanId = await fetch(`${BASE}/api/v1/ingest/traces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "chaos-agent", input: "qx", output: "ax", monitor: false }),
  });
  check("CH down: span_id-less ingest also answers 503", downNoSpanId.status === 503, `got ${downNoSpanId.status}`);
  const metrics = await fetch(`${BASE}/metrics`).then(r => r.text());
  const droppedTotal = Number(/agentx_ingest_spans_dropped_total (\d+)/.exec(metrics)?.[1] ?? -1);
  check("CH down: the drop is counted in /metrics", droppedTotal >= 1, `dropped=${droppedTotal}`);
  const cfg = await fetch(`${BASE}/api/v1/auth/config`);
  check("CH down: control plane stays up", cfg.ok);
  // Failure-mode UX: the DASHBOARD's reads during the outage. A span-backed read answers an
  // honest 503 + Retry-After (the storage tier is down, the engine is not) - never a bare 500
  // that reads as an engine bug.
  const tracesDown = await fetch(`${BASE}/api/v1/ingest/traces?limit=5`, { headers });
  check("CH down: trace list reads answer 503, not 500", tracesDown.status === 503, `got ${tracesDown.status}`);
  check("CH down: 503 carries Retry-After", !!tracesDown.headers.get("retry-after"));
  const metricsDown = await fetch(`${BASE}/api/v1/agent-monitoring/metrics?window=1h`, { headers });
  check(
    "CH down: monitor metrics answer 503, not 500",
    metricsDown.status === 503,
    `got ${metricsDown.status}`
  );

  // ---- drill 3: recovery needs no operator action ----
  sh(`docker start ${CH_NAME}`);
  await sleep(6_000);
  let recovered = false;
  for (let attempt = 0; attempt < 10 && !recovered; attempt++) {
    const r = await ingest(200 + attempt);
    if (r.status === 200) recovered = true;
    else await sleep(1_000);
  }
  check("CH back: ingestion resumes by itself", recovered);

  // ---- drill 4: SIGTERM mid-burst -> every ACKED span survives restart ----
  const acked = [];
  const burst = Array.from({ length: 40 }, (_, i) =>
    ingest(300 + i).then(r => {
      if (r.status === 200) acked.push(300 + i);
    })
  );
  await sleep(30);
  engine.kill("SIGTERM");
  await Promise.allSettled(burst);
  await sleep(2_000);
  startEngine();
  check("engine restarts after SIGTERM", await waitUp());
  // Vacuous-pass guard: with zero acks before the kill, "all 0 acked spans survived" proves
  // nothing - the drill must fail loudly so the timing gets retuned, not silently pass.
  check("SIGTERM drill armed (spans acked before the kill)", acked.length > 0);
  const after = await fetch(`${BASE}/api/v1/ingest/traces?limit=200`, { headers }).then(r => r.json());
  const storedIds = new Set(after.traces.map(t => t.input));
  const missing = acked.filter(i => !storedIds.has(`q${i}`));
  check(`SIGTERM drain: all ${acked.length} acked spans survived`, missing.length === 0, `missing ${missing.length}`);

  // ---- drill 5: backup / restore round trip (ClickHouse native format) ----
  const before = await listCount();
  sh(`docker exec ${CH_NAME} clickhouse-client --password agentx --query "SELECT * FROM agentx_spans FORMAT Native" > /tmp/agentx-chaos-backup.native`);
  sh(`docker exec ${CH_NAME} clickhouse-client --password agentx --query "TRUNCATE TABLE agentx_spans"`);
  check("restore drill: table truncated", (await listCount()) === 0);
  sh(`docker exec -i ${CH_NAME} clickhouse-client --password agentx --query "INSERT INTO agentx_spans FORMAT Native" < /tmp/agentx-chaos-backup.native`);
  check("restore drill: backup restores byte-true", (await listCount()) === before, `${await listCount()} != ${before}`);

  // ---- teardown ----
  engine.kill("SIGTERM");
  try { sh(`docker rm -f ${CH_NAME}`); } catch {}

  if (failures.length) {
    console.error(`\n${failures.length} drill(s) failed: ${failures.join("; ")}`);
    console.error(`\n---- engine log (for the CI run that cannot re-run this) ----\n${engine?.logs?.() ?? "(none)"}`);
    try { engine?.kill("SIGKILL"); } catch {}
    process.exit(1);
  }
  console.log("\nAll drills held.");
}

main().catch(err => {
  console.error(err);
  try { engine?.kill("SIGKILL"); } catch {}
  try { sh(`docker rm -f ${CH_NAME}`); } catch {}
  process.exit(1);
});
