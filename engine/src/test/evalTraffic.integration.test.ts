import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Eval-run traffic separation. An offline evaluation produces real traces (that is what makes
// trajectory matching and retrieval-context extraction work), but they are not production
// traffic. Pinned here: source="eval-run" traces never trigger monitoring on their own, are
// excluded from the KPIs/metrics/sessions the Overview page builds trust on, stay reachable by
// id and by explicit filter, and their spend still shows in cost - split out, not hidden.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

async function ingest(body: Record<string, unknown>): Promise<string> {
  const res = await api("/ingest/traces", postJson(body));
  expect(res.status).toBe(200);
  return (res.body as { trace_id: string }).trace_id;
}

let prodId: string;
let evalId: string;

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "eval-traffic" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  prodId = await ingest({
    name: "prod-agent", input: "where is my order?", output: "It shipped.",
    latency_ms: 500, model: "gpt-4o-mini", input_tokens: 100, output_tokens: 20,
    session_id: "prod-sess", span_id: "p1",
  });
  // The eval trace: enormous latency and a failed tool call, exactly the kind of row that would
  // wreck production KPIs if it counted.
  evalId = await ingest({
    name: "eval-agent", input: "synthetic case", output: "",
    latency_ms: 60000, model: "gpt-4o-mini", input_tokens: 5000, output_tokens: 1000,
    session_id: "eval-sess", span_id: "e1", source: "eval-run",
    tool_calls: [{ name: "lookup", success: false, output: "boom" }],
  });
  await new Promise(r => setTimeout(r, 1200));
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("eval traffic separation", () => {
  it("stores the stated source and puts it on the wire", async () => {
    const all = (await api("/ingest/traces?limit=50&source=all")).body as { traces: { _id: string; trafficSource?: string }[] };
    const byId = new Map(all.traces.map(t => [t._id, t.trafficSource]));
    expect(byId.get(prodId)).toBeUndefined();
    expect(byId.get(evalId)).toBe("eval-run");
  });

  it("ignores a source word nobody defined rather than storing it", async () => {
    const id = await ingest({ name: "odd", input: "x", output: "y", source: "vibes" });
    const all = (await api("/ingest/traces?limit=50&source=all")).body as { traces: { _id: string; trafficSource?: string }[] };
    expect(all.traces.find(t => t._id === id)?.trafficSource).toBeUndefined();
  });

  it("hides eval traffic from the production list, shows it under its own filter", async () => {
    const prod = (await api("/ingest/traces?limit=50&source=production")).body as { traces: { _id: string }[] };
    expect(prod.traces.some(t => t._id === prodId)).toBe(true);
    expect(prod.traces.some(t => t._id === evalId)).toBe(false);

    const evals = (await api("/ingest/traces?limit=50&source=eval")).body as { traces: { _id: string }[] };
    expect(evals.traces.some(t => t._id === evalId)).toBe(true);
    expect(evals.traces.some(t => t._id === prodId)).toBe(false);

    // Absent = all, so existing SDK/API callers see exactly what they always saw.
    const dflt = (await api("/ingest/traces?limit=50")).body as { traces: { _id: string }[] };
    expect(dflt.traces.some(t => t._id === evalId)).toBe(true);
  });

  it("keeps the eval trace reachable by id - per-trace features are untouched", async () => {
    const detail = await api(`/ingest/traces/${evalId}`);
    expect(detail.status).toBe(200);
  });

  it("keeps the 60s eval latency out of the KPI P95", async () => {
    const kpis = (await api("/agent-monitoring/kpis?window=24h")).body as { p95LatencyMs: number | null };
    expect(kpis.p95LatencyMs).not.toBeNull();
    expect(kpis.p95LatencyMs!).toBeLessThan(10_000);
  });

  it("keeps eval spans and tokens out of the metrics buckets", async () => {
    const metrics = (await api("/agent-monitoring/metrics?window=24h")).body as {
      totals: { tokensPrompt: number };
    };
    // The eval trace carried 5000 prompt tokens; production carried 100.
    expect(metrics.totals.tokensPrompt).toBeLessThan(5000);
  });

  it("keeps the eval session out of the sessions list", async () => {
    const sessions = (await api("/agent-monitoring/sessions?window=7d")).body as {
      sessions: { sessionId: string }[];
    };
    const ids = sessions.sessions.map(s => s.sessionId);
    expect(ids).toContain("prod-sess");
    expect(ids).not.toContain("eval-sess");
  });

  it("never raises signals or tool-failure detections for eval traffic", async () => {
    // The eval trace had an empty output AND a failed tool call - both built-in detections.
    const signals = (await api("/agent-monitoring/signals?polarity=all")).body as { signals: { traceId?: string }[] };
    expect(signals.signals.filter(s => s.traceId === evalId)).toHaveLength(0);
  });

  it("keeps eval spend in the cost trend, split into its own segment", async () => {
    // Price gpt-4o-mini so both traces' spend is computable.
    const models = (await api("/agent-monitoring/portability/models")).body as {
      models: { id: string; label: string; provider: string }[];
    };
    const target = models.models.find(m => m.id.includes("gpt-4o-mini")) ?? models.models[0]!;
    const priced = await api(`/agent-monitoring/portability/models/${target.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        label: target.label,
        pricePerMInputTokens: 1,
        pricePerMOutputTokens: 2,
      }),
    });
    expect(priced.status).toBe(200);

    const trend = (await api("/agent-monitoring/cost-trend?window=24h")).body as {
      totalsByModel: Record<string, number>;
      totalCost: number;
    };
    // The eval trace's spend (5000 in / 1000 out) lands in the reserved "eval runs" segment;
    // the production trace's (100 in / 20 out) lands under the model. Neither is hidden.
    expect(trend.totalsByModel["eval runs"]).toBeGreaterThan(0);
    const modelKeys = Object.keys(trend.totalsByModel).filter(k => k !== "eval runs");
    expect(modelKeys.length).toBeGreaterThan(0);
    const modelTotal = modelKeys.reduce((a, k) => a + trend.totalsByModel[k]!, 0);
    // Eval spend is the big one here, and it must NOT be inside the model's own segment.
    expect(trend.totalsByModel["eval runs"]).toBeGreaterThan(modelTotal);
    expect(trend.totalCost).toBeCloseTo(modelTotal + trend.totalsByModel["eval runs"]!, 10);
  });
});
