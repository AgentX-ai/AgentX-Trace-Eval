import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Overview's headline numbers - health rate, failure rate, tool failure rate, p95 latency and the
// bucketed trend - are all computed in JS over the monitor_events log (core/monitor/events.ts).
// Nothing about a wrong number here looks wrong: the dashboard renders a plausible percentage
// either way. So this seeds a mix with a known answer and checks the arithmetic exactly.
//
// Everything runs in a project created by the test, because the default project ships with seeded
// example data that would make exact counts impossible.

let engine: TestEngine;
let key: string;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

// 6 clean, 2 tool failures, 1 traced error, 1 empty response = 10 checked runs.
const HEALTHY = 6;
const TOOL_FAILURES = 2;
const OTHER_FAILURES = 2;
const TOTAL = HEALTHY + TOOL_FAILURES + OTHER_FAILURES;

async function seed() {
  const traces: Record<string, unknown>[] = [];
  for (let i = 0; i < HEALTHY; i++) {
    traces.push({ name: "kpi-agent", span_id: `kpi-ok-${i}`, input: "where is my order?", output: "shipped monday", latency_ms: 100 * (i + 1) });
  }
  for (let i = 0; i < TOOL_FAILURES; i++) {
    traces.push({
      name: "kpi-agent",
      span_id: `kpi-tool-${i}`,
      input: "look it up",
      output: "sorry, that did not work",
      latency_ms: 800,
      tool_calls: [{ name: `lookup_${i}`, input: {}, output: null, success: false }],
    });
  }
  traces.push({ name: "kpi-agent", span_id: "kpi-error", input: "q", output: "partial", error: "RateLimitError", latency_ms: 900 });
  traces.push({ name: "kpi-agent", span_id: "kpi-empty", input: "q", output: "   ", latency_ms: 1000 });

  for (const trace of traces) {
    const res = await engine.json("/api/v1/ingest/traces", post(trace, key));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

type Kpis = {
  totalRuns: number;
  healthRate: number | null;
  failureRate: number | null;
  toolFailureRate: number | null;
  downvoteRate: number | null;
  p95LatencyMs: number | null;
  deltas: Record<string, number | null>;
  breakdown: { totalRuns: number; healthyRuns: number; failingRuns: number; systemFailingRuns: number; customFailingRuns: number };
};

async function kpis(window = "7d"): Promise<Kpis> {
  const res = await engine.json(`/api/v1/agent-monitoring/kpis?window=${window}`, { apiKey: key });
  expect(res.status).toBe(200);
  return res.body as Kpis;
}

beforeAll(async () => {
  engine = await startEngine();
  const project = await engine.json("/api/v1/projects", post({ name: "KPI project" }, null));
  expect(project.status).toBe(201);
  key = (project.body as { project: { apiKey: string } }).project.apiKey;

  await seed();
  // The monitor checks run detached from the ingest response; wait for all ten to land.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await kpis()).totalRuns >= TOTAL) break;
    await new Promise(r => setTimeout(r, 200));
  }
}, 120_000);

afterAll(async () => {
  await engine?.stop();
});

describe("KPI arithmetic", () => {
  it("counts every checked run exactly once", async () => {
    const result = await kpis();
    expect(result.totalRuns).toBe(TOTAL);
    expect(result.breakdown.healthyRuns).toBe(HEALTHY);
    expect(result.breakdown.failingRuns).toBe(TOOL_FAILURES + OTHER_FAILURES);
  });

  it("computes health rate as healthy / (healthy + failing)", async () => {
    const result = await kpis();
    expect(result.healthRate).toBeCloseTo(HEALTHY / TOTAL, 10);
  });

  it("computes failure and tool-failure rates over the same denominator", async () => {
    const result = await kpis();
    expect(result.failureRate).toBeCloseTo((TOOL_FAILURES + OTHER_FAILURES) / TOTAL, 10);
    expect(result.toolFailureRate).toBeCloseTo(TOOL_FAILURES / TOTAL, 10);
  });

  it("attributes built-in failures to the system bucket, not the custom-pattern one", async () => {
    const result = await kpis();
    expect(result.breakdown.systemFailingRuns).toBe(TOOL_FAILURES + OTHER_FAILURES);
    expect(result.breakdown.customFailingRuns).toBe(0);
  });

  it("keeps every rate inside [0, 1]", async () => {
    const result = await kpis();
    for (const rate of [result.healthRate, result.failureRate, result.toolFailureRate]) {
      expect(rate).not.toBeNull();
      expect(rate!).toBeGreaterThanOrEqual(0);
      expect(rate!).toBeLessThanOrEqual(1);
    }
  });

  it("reports p95 latency from the traces in the window", async () => {
    // Latencies are 100..600 for the healthy runs plus 800, 800, 900, 1000: ten values, and the
    // 95th percentile of ten lands on the largest.
    const result = await kpis();
    expect(result.p95LatencyMs).toBe(1000);
  });

  it("reports null rather than 0 for a metric self-host cannot measure", async () => {
    const result = await kpis();
    expect(result.downvoteRate).toBeNull();
    expect(result.deltas.downvoteRate).toBeNull();
  });

  it("reports null deltas when there is no previous window to compare against", async () => {
    const result = await kpis();
    expect(result.deltas.healthRate).toBeNull();
    expect(result.deltas.failureRate).toBeNull();
    expect(result.deltas.toolFailureRate).toBeNull();
  });

  it("gives the same answer for every window that contains all the data", async () => {
    const [sevenDay, thirtyDay, oneDay] = await Promise.all([kpis("7d"), kpis("30d"), kpis("24h")]);
    expect(thirtyDay.totalRuns).toBe(sevenDay.totalRuns);
    expect(oneDay.totalRuns).toBe(sevenDay.totalRuns);
    expect(thirtyDay.healthRate).toBeCloseTo(sevenDay.healthRate!, 10);
  });

  it("returns nulls, not NaN or zero, for a project with no traffic at all", async () => {
    const empty = await engine.json("/api/v1/projects", post({ name: "Empty project" }, null));
    const emptyKey = (empty.body as { project: { apiKey: string } }).project.apiKey;
    const res = await engine.json("/api/v1/agent-monitoring/kpis", { apiKey: emptyKey });
    expect(res.body).toMatchObject({ totalRuns: 0, healthRate: null, failureRate: null, toolFailureRate: null, p95LatencyMs: null });
  });
});

describe("trend bucketing", () => {
  it("returns one bucket per hour for 24h and per day for 7d/30d", async () => {
    const counts: Record<string, number> = { "24h": 24, "7d": 7, "30d": 30 };
    for (const [window, expected] of Object.entries(counts)) {
      const res = await engine.json(`/api/v1/agent-monitoring/trend?window=${window}`, { apiKey: key });
      expect(res.status).toBe(200);
      const body = res.body as { points: { ts: number; healthRate: number | null }[]; previous?: unknown[] };
      expect(body.points, window).toHaveLength(expected);
      expect(body.previous, `${window} previous`).toHaveLength(expected);
    }
  });

  it("puts freshly ingested traffic in the final bucket and leaves the earlier ones empty", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/trend?window=24h", { apiKey: key });
    const points = (res.body as { points: { healthRate: number | null }[] }).points;
    const withData = points.filter(p => p.healthRate !== null);
    expect(withData).toHaveLength(1);
    expect(points[points.length - 1]!.healthRate).toBeCloseTo(HEALTHY / TOTAL, 10);
  });

  it("orders buckets forward in time with no gaps", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/trend?window=7d", { apiKey: key });
    const points = (res.body as { points: { ts: number; label: string }[] }).points;
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.ts - points[i - 1]!.ts).toBe(dayMs);
      expect(new Date(points[i]!.label).getTime()).toBe(points[i]!.ts);
    }
  });

  it("reports an empty previous window rather than omitting it", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/trend?window=7d", { apiKey: key });
    const previous = (res.body as { previous: { healthRate: number | null }[] }).previous;
    expect(previous.every(p => p.healthRate === null)).toBe(true);
  });
});

describe("top failing", () => {
  it("ranks the failing agent and counts each tool call from the traces themselves", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/top-failing", { apiKey: key });
    expect(res.status).toBe(200);
    const body = res.body as {
      agents: { name?: string; failingRuns: number; failureRate: number | null }[];
      tools: { name: string; failures: number; callCount: number; failureRate: number | null }[];
      patterns: { patternKey: string; count: number }[];
    };

    const agent = body.agents.find(a => a.name === "kpi-agent");
    expect(agent, JSON.stringify(body.agents)).toBeTruthy();
    expect(agent!.failingRuns).toBe(TOOL_FAILURES + OTHER_FAILURES);
    expect(agent!.failureRate).toBeCloseTo((TOOL_FAILURES + OTHER_FAILURES) / TOTAL, 10);

    // Every recorded call counts toward the denominator, failed or not.
    for (let i = 0; i < TOOL_FAILURES; i++) {
      const tool = body.tools.find(t => t.name === `lookup_${i}`);
      expect(tool, `lookup_${i} missing from ${JSON.stringify(body.tools)}`).toBeTruthy();
      expect(tool!.callCount).toBe(1);
      expect(tool!.failures).toBe(1);
      expect(tool!.failureRate).toBe(1);
    }

    const toolPattern = body.patterns.filter(p => p.patternKey.startsWith("agent-tool-failure"));
    expect(toolPattern.reduce((sum, p) => sum + p.count, 0)).toBe(TOOL_FAILURES);
  });
});
