#!/usr/bin/env node
// The capacity benchmark (phase 5 of docs/adr - see docs/capacity-slos.md): generates a
// production-shaped span mix against a RUNNING engine, sustains load, then times the dashboard
// query set. Prints a JSON report and exits non-zero if a floor is violated.
//
//   node scripts/bench.mjs --base http://localhost:4700 --seconds 30 --concurrency 32 \
//     --floor-ingest-rps 200 --floor-ack-p95-ms 250 --floor-dash-p95-ms 1000
//
// The floors default to 0 (record-only). The nightly workflow sets real ones per backend; a
// regression beyond a floor fails the run - benchmarks are a gate, not a dashboard.

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean)
);
const BASE = args.base ?? "http://localhost:4700";
const SECONDS = Number(args.seconds ?? 30);
const CONCURRENCY = Number(args.concurrency ?? 32);
const FLOOR_RPS = Number(args["floor-ingest-rps"] ?? 0);
const FLOOR_ACK_P95 = Number(args["floor-ack-p95-ms"] ?? 0);
const FLOOR_DASH_P95 = Number(args["floor-dash-p95-ms"] ?? 0);

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

// Deterministic-ish payload mix per docs/capacity-slos.md: 20% tool spans, 10% retrieval,
// session ids on 40%, payload sizes drawn from a long-tailed distribution.
function makeSpan(i) {
  const r = i % 10;
  const size = r === 9 ? 8_000 : r >= 6 ? 1_200 : 200;
  const body = "x".repeat(size);
  return {
    name: `bench-agent-${i % 4}`,
    input: `question ${i} ${body.slice(0, 120)}`,
    output: body,
    latency_ms: 50 + (i % 400),
    ...(i % 3 === 0 ? { model: "gpt-test" } : {}),
    input_tokens: 200 + (i % 100),
    output_tokens: 80 + (i % 50),
    session_id: i % 5 < 2 ? `bench-sess-${i % 50}` : undefined,
    span_kind: r < 2 ? "tool" : r === 2 ? "retrieval" : undefined,
    tool_calls: r < 2 ? [{ name: `tool-${i % 6}`, success: i % 17 !== 0 }] : undefined,
    span_id: `bench-${process.pid}-${i}`,
    monitor: false,
  };
}

async function main() {
  // Setup: own project so the run is isolated and repeatable.
  const created = await fetch(`${BASE}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `bench-${Date.now()}` }),
  }).then(r => r.json());
  const key = created.project.apiKey;
  const headers = { "content-type": "application/json", "x-api-key": key };

  // ---- sustained ingest ----
  const ackLatencies = [];
  let sent = 0;
  let rejected429 = 0;
  let failed = 0;
  const statusCounts = {};
  const deadline = Date.now() + SECONDS * 1000;
  let counter = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const i = counter++;
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}/api/v1/ingest/traces`, {
          method: "POST",
          headers,
          body: JSON.stringify(makeSpan(i)),
        });
        if (res.status === 429) {
          rejected429++;
          await new Promise(r => setTimeout(r, Number(res.headers.get("retry-after") ?? 1) * 1000));
        } else if (!res.ok) {
          failed++;
          statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        } else {
          sent++;
          lastAck = Date.now();
          ackLatencies.push(performance.now() - t0);
        }
        await res.arrayBuffer();
      } catch {
        failed++;
      }
    }
  }
  const t0 = Date.now();
  let lastAck = t0;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = Math.max(0.001, (lastAck - t0) / 1000);
  ackLatencies.sort((a, b) => a - b);

  // ---- dashboard query set ----
  const dashLatencies = [];
  let dashFailed = 0;
  const queries = [
    "/api/v1/agent-monitoring/metrics?window=24h",
    "/api/v1/ingest/traces?limit=50",
    "/api/v1/ingest/traces?search=question",
    "/api/v1/agent-monitoring/signals",
  ];
  for (let round = 0; round < 5; round++) {
    for (const q of queries) {
      const s = performance.now();
      const res = await fetch(`${BASE}${q}`, { headers });
      await res.arrayBuffer();
      // A broken endpoint answers 404/500 instantly - counting it as a fast success would let
      // the latency floor pass with the dashboard entirely dead.
      if (!res.ok) dashFailed++;
      else dashLatencies.push(performance.now() - s);
    }
  }
  dashLatencies.sort((a, b) => a - b);

  const report = {
    base: BASE,
    seconds: elapsed,
    concurrency: CONCURRENCY,
    ingest: {
      stored: sent,
      ratePerSecond: Math.round(sent / elapsed),
      rejected429,
      failed,
      failureStatuses: statusCounts,
      ackP50Ms: Math.round(pct(ackLatencies, 50) ?? 0),
      ackP95Ms: Math.round(pct(ackLatencies, 95) ?? 0),
    },
    dashboard: {
      p50Ms: Math.round(pct(dashLatencies, 50) ?? 0),
      p95Ms: Math.round(pct(dashLatencies, 95) ?? 0),
      failed: dashFailed,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const violations = [];
  if (FLOOR_RPS && report.ingest.ratePerSecond < FLOOR_RPS) violations.push(`ingest ${report.ingest.ratePerSecond}/s < floor ${FLOOR_RPS}/s`);
  if (FLOOR_ACK_P95 && report.ingest.ackP95Ms > FLOOR_ACK_P95) violations.push(`ack p95 ${report.ingest.ackP95Ms}ms > floor ${FLOOR_ACK_P95}ms`);
  if (FLOOR_DASH_P95 && report.dashboard.p95Ms > FLOOR_DASH_P95) violations.push(`dashboard p95 ${report.dashboard.p95Ms}ms > floor ${FLOOR_DASH_P95}ms`);
  if (failed > sent * 0.01) violations.push(`${failed} hard failures`);
  if (dashFailed > 0) violations.push(`${dashFailed} dashboard queries answered non-2xx`);
  if (violations.length) {
    console.error("BENCH FLOOR VIOLATIONS:\n  " + violations.join("\n  "));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
