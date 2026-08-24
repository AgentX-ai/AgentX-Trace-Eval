import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The Monitor metrics grid endpoint: one bucketed pass over the window's traces powering the
// spans/latency/cost/tokens/tools cards, with session-scoped agent/model/tool/status filters.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "metrics-probe" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  await api("/ingest/traces", postJson({
    name: "support-agent",
    input: "where is my order?",
    output: "it shipped",
    model: "gpt-4o-mini",
    latencyMs: 800,
    inputTokens: 500,
    outputTokens: 100,
    toolCalls: [
      { name: "lookup_order", success: true },
      { name: "get_weather", success: false, error: "boom" },
    ],
  }));
  await api("/ingest/traces", postJson({
    name: "billing-agent",
    input: "refund?",
    output: "",
    error: "upstream timeout",
    latencyMs: 2600,
  }));
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

type Wire = {
  window: string;
  buckets: { traces: number; toolCalls: number }[];
  totals: Record<string, number | null>;
  tools: { name: string; count: number; failed: number }[];
  facets: { agents: string[]; models: string[]; tools: string[] };
};

describe("GET /agent-monitoring/metrics", () => {
  it("buckets spans, latency, tokens, and tool executions over the window", async () => {
    const res = await api("/agent-monitoring/metrics?window=24h");
    expect(res.status).toBe(200);
    const body = res.body as Wire;
    expect(body.totals.traces).toBeGreaterThanOrEqual(2);
    expect(body.totals.errors).toBeGreaterThanOrEqual(1);
    expect(body.totals.spansLlm).toBeGreaterThanOrEqual(1); // the model-bearing span
    expect(body.totals.tokensPrompt).toBeGreaterThanOrEqual(500);
    expect(body.totals.tokensCompletion).toBeGreaterThanOrEqual(100);
    expect(body.totals.toolCalls).toBeGreaterThanOrEqual(2);
    expect(body.totals.toolFailures).toBeGreaterThanOrEqual(1);
    expect(body.totals.latencyP95).toBeGreaterThanOrEqual(800);
    expect(body.tools.find(t => t.name === "get_weather")?.failed).toBe(1);
    expect(body.facets.agents).toContain("support-agent");
    expect(body.facets.models).toContain("gpt-4o-mini");
  });

  it("filters by agent and by error status, session-scoped", async () => {
    const agent = (await api("/agent-monitoring/metrics?window=24h&agent=support-agent")).body as Wire;
    expect(agent.totals.traces).toBe(1);
    expect(agent.totals.toolCalls).toBe(2);
    const errors = (await api("/agent-monitoring/metrics?window=24h&status=error")).body as Wire;
    expect(errors.totals.traces).toBe(1);
    expect(errors.totals.errors).toBe(1);
    expect(errors.totals.toolCalls).toBe(0);
    const tool = (await api("/agent-monitoring/metrics?window=24h&tool=lookup_order")).body as Wire;
    expect(tool.totals.toolCalls).toBe(1);
    expect(tool.totals.toolFailures).toBe(0);
  });

  it("supports the 1h live window with 5-minute buckets", async () => {
    const res = (await api("/agent-monitoring/metrics?window=1h")).body as Wire & { bucketMs: number };
    expect(res.window).toBe("1h");
    expect(res.bucketMs).toBe(5 * 60 * 1000);
    expect(res.buckets.length).toBe(12);
    expect(res.totals.traces).toBeGreaterThanOrEqual(2);
  });

  it("sizes buckets adaptively across the preset ladder", async () => {
    const sixH = (await api("/agent-monitoring/metrics?window=6h")).body as Wire & { bucketMs: number };
    expect(sixH.window).toBe("6h");
    expect(sixH.bucketMs).toBe(15 * 60 * 1000);
    expect(sixH.buckets.length).toBe(24);
    const ninetyD = (await api("/agent-monitoring/metrics?window=90d")).body as Wire & { bucketMs: number };
    expect(ninetyD.bucketMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(ninetyD.buckets.length).toBe(30);
    // Unknown window falls back to the 7d preset.
    const bogus = (await api("/agent-monitoring/metrics?window=zzz")).body as Wire;
    expect(bogus.window).toBe("7d");
  });

  it("accepts a custom from/to range and honors both bounds", async () => {
    const now = Date.now();
    const live = (await api(`/agent-monitoring/metrics?from=${now - 2 * 3600_000}&to=${now}`)).body as Wire & {
      bucketMs: number;
      end: number;
    };
    expect(live.window).toBe("custom");
    expect(live.bucketMs).toBe(5 * 60 * 1000); // 2h span -> 24 five-minute buckets
    expect(live.totals.traces).toBeGreaterThanOrEqual(2);
    expect(live.end).toBe(now);
    // A range that ended before ingest excludes everything, including totals and facets.
    const past = (await api(`/agent-monitoring/metrics?from=${now - 48 * 3600_000}&to=${now - 24 * 3600_000}`))
      .body as Wire;
    expect(past.totals.traces).toBe(0);
    expect(past.facets.agents).toEqual([]);
  });
});
