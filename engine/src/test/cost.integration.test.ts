import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// The only place this engine puts a dollar figure in front of anyone. A factor of 1000, or a
// mis-bucketed day, reads as a plausible number - so this checks exact amounts against a catalog
// the test defines.

let engine: TestEngine;
let key: string;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

const BASE_MS = Date.now() - 60_000;
const nanos = (offsetMs: number) => (BigInt(BASE_MS + offsetMs) * 1_000_000n).toString();

// $1 per million in, $2 per million out - round numbers so the arithmetic is checkable by hand.
const MODEL_ID = "test-priced-model";
const IN_PRICE = 1;
const OUT_PRICE = 2;

async function ingest(body: Record<string, unknown>) {
  const res = await engine.json("/api/v1/ingest/traces", post(body, key));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

type CostTrend = {
  points: { ts: number; label: string; byModel: Record<string, number> }[];
  models: string[];
  totalsByModel: Record<string, number>;
  totalsByTool: Record<string, number>;
  totalCost: number;
};

async function costTrend(window = "7d"): Promise<CostTrend> {
  const res = await engine.json(`/api/v1/agent-monitoring/cost-trend?window=${window}`, { apiKey: key });
  expect(res.status).toBe(200);
  return res.body as CostTrend;
}

beforeAll(async () => {
  engine = await startEngine();
  const project = await engine.json("/api/v1/projects", post({ name: "Cost project" }, null));
  expect(project.status).toBe(201);
  key = (project.body as { project: { apiKey: string } }).project.apiKey;

  const model = await engine.json(
    "/api/v1/agent-monitoring/portability/models",
    post(
      { id: MODEL_ID, provider: "openai", label: "Test priced model", pricePerMInputTokens: IN_PRICE, pricePerMOutputTokens: OUT_PRICE },
      key
    )
  );
  expect(model.status, JSON.stringify(model.body)).toBe(201);

  // 1,000,000 in + 1,000,000 out = $1 + $2 = $3.
  await ingest({ name: "cost-agent", span_id: "cost-1", model: MODEL_ID, input_tokens: 1_000_000, output_tokens: 1_000_000, input: "q", output: "a", started_at_unix_nano: nanos(0) });
  // A dated snapshot of the same model: must merge onto the catalog id, not vanish and not split.
  await ingest({ name: "cost-agent", span_id: "cost-2", model: `${MODEL_ID}-2024-07-18`, input_tokens: 500_000, output_tokens: 0, input: "q", output: "a", started_at_unix_nano: nanos(10) });
  // A model nobody has priced contributes nothing.
  await ingest({ name: "cost-agent", span_id: "cost-3", model: "unpriced-model", input_tokens: 900_000, output_tokens: 900_000, input: "q", output: "a", started_at_unix_nano: nanos(20) });
  // Tokens with no model at all.
  await ingest({ name: "cost-agent", span_id: "cost-4", input_tokens: 100, output_tokens: 100, input: "q", output: "a", started_at_unix_nano: nanos(30) });
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("cost trend", () => {
  it("prices per million tokens against the catalog", async () => {
    const trend = await costTrend();
    // $3 from the first trace, $0.50 from the dated snapshot's 500k input tokens.
    expect(trend.totalCost).toBeCloseTo(3.5, 9);
    expect(trend.totalsByModel[MODEL_ID]).toBeCloseTo(3.5, 9);
  });

  it("merges a dated model snapshot onto its catalog id rather than charting it separately", async () => {
    const trend = await costTrend();
    expect(Object.keys(trend.totalsByModel)).toEqual([MODEL_ID]);
    expect(trend.models).toEqual([MODEL_ID]);
  });

  it("contributes nothing for a model with no pricing, rather than guessing", async () => {
    const trend = await costTrend();
    expect(trend.totalsByModel["unpriced-model"]).toBeUndefined();
  });

  it("puts the spend in the bucket the traffic actually happened in", async () => {
    const trend = await costTrend();
    const spending = trend.points.filter(p => Object.keys(p.byModel).length > 0);
    expect(spending).toHaveLength(1);
    expect(spending[0]!.byModel[MODEL_ID]).toBeCloseTo(3.5, 9);
    // All four traces are minutes old, so it is the final bucket.
    expect(spending[0]!.ts).toBe(trend.points[trend.points.length - 1]!.ts);
  });

  it("returns one bucket per hour for 24h and per day for 7d/30d, evenly spaced", async () => {
    for (const [window, expected, spacingMs] of [
      ["24h", 24, 60 * 60 * 1000],
      ["7d", 7, 24 * 60 * 60 * 1000],
      ["30d", 30, 24 * 60 * 60 * 1000],
    ] as const) {
      const trend = await costTrend(window);
      expect(trend.points, window).toHaveLength(expected);
      for (let i = 1; i < trend.points.length; i++) {
        expect(trend.points[i]!.ts - trend.points[i - 1]!.ts, window).toBe(spacingMs);
      }
      expect(trend.totalCost, `${window} total`).toBeCloseTo(3.5, 9);
    }
  });

  it("charges registered tools per recorded call, as their own segment, failed calls included", async () => {
    // Register a $0.25-per-call tool (a paid geocoding API, say) and a free one.
    const priced = await engine.json(
      "/api/v1/evaluate/tool-schemas",
      post({ name: "geocode", definition: JSON.stringify({ name: "geocode" }), pricePerCallUsd: 0.25 }, key)
    );
    expect(priced.status, JSON.stringify(priced.body)).toBe(201);
    expect((priced.body as { pricePerCallUsd: number }).pricePerCallUsd).toBe(0.25);
    const free = await engine.json("/api/v1/evaluate/tool-schemas", post({ name: "clock", definition: JSON.stringify({ name: "clock" }) }, key));
    expect((free.body as { pricePerCallUsd: number | null }).pricePerCallUsd).toBeNull();

    // Two geocode calls (one failed - the API still billed it), one free call, one unregistered.
    await ingest({
      name: "cost-agent",
      span_id: "cost-tools-1",
      input: "q",
      output: "a",
      started_at_unix_nano: nanos(40),
      tool_calls: [
        { name: "geocode", success: true },
        { name: "geocode", success: false, error: "429" },
        { name: "clock", success: true },
        { name: "mystery", success: true },
      ],
    });
    const trend = await costTrend();
    expect(trend.totalsByModel["tool calls"]).toBeCloseTo(0.5, 9);
    expect(trend.totalsByTool).toEqual({ geocode: 0.5 });
    expect(trend.totalCost).toBeCloseTo(4.0, 9);
    // The segment sits in the stack order like any model, by spend.
    expect(trend.models).toEqual([MODEL_ID, "tool calls"]);
    const bucket = trend.points[trend.points.length - 1]!;
    expect(bucket.byModel["tool calls"]).toBeCloseTo(0.5, 9);

    // Clearing the price (null) removes the spend from the next read; nothing is stored as $0.
    const id = (priced.body as { _id: string })._id;
    const cleared = await engine.json(`/api/v1/evaluate/tool-schemas/${id}`, { ...post({ pricePerCallUsd: null }, key), method: "PATCH" });
    expect(cleared.status).toBe(200);
    const after = await costTrend();
    expect(after.totalsByModel["tool calls"]).toBeUndefined();
    expect(after.totalsByTool).toEqual({});
    expect(after.totalCost).toBeCloseTo(3.5, 9);
  });

  it("files eval-run tool calls under eval spend, not under the production tool segment", async () => {
    const tool = await engine.json("/api/v1/evaluate/tool-schemas", post({ name: "paid_eval_tool", definition: "{}", pricePerCallUsd: 0.1 }, key));
    expect(tool.status).toBe(201);
    await ingest({ name: "cost-agent", span_id: "cost-tools-eval", input: "q", output: "a", source: "eval-run", started_at_unix_nano: nanos(50), tool_calls: [{ name: "paid_eval_tool", success: true }] });
    const trend = await costTrend();
    expect(trend.totalsByModel["eval runs"]).toBeCloseTo(0.1, 9);
    expect(trend.totalsByTool.paid_eval_tool).toBeUndefined();
    await engine.json(`/api/v1/evaluate/tool-schemas/${(tool.body as { _id: string })._id}`, { method: "DELETE", apiKey: key });
  });

  it("refuses a tool price that is not a non-negative number", async () => {
    const negative = await engine.json("/api/v1/evaluate/tool-schemas", post({ name: "neg", definition: "{}", pricePerCallUsd: -1 }, key));
    expect(negative.status).toBe(400);
    const text = await engine.json("/api/v1/evaluate/tool-schemas", post({ name: "txt", definition: "{}", pricePerCallUsd: "0.25" }, key));
    expect(text.status).toBe(400);
    expect((text.body as { error: string }).error).toContain("pricePerCallUsd");
  });

  it("lists a token-bearing unpriced model so the spend is visible rather than silently zero", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/portability/models/unpriced", { apiKey: key });
    expect(res.status).toBe(200);
    const unpriced = (res.body as { models: { model: string; traces: number; inputTokens: number; outputTokens: number }[] }).models;
    const entry = unpriced.find(m => m.model === "unpriced-model");
    expect(entry, JSON.stringify(unpriced)).toBeTruthy();
    expect(entry!.traces).toBe(1);
    expect(entry!.inputTokens).toBe(900_000);
    expect(entry!.outputTokens).toBe(900_000);

    // The priced one is not "unpriced", and a trace with no model at all is not a model.
    expect(unpriced.some(m => m.model === MODEL_ID)).toBe(false);
    expect(unpriced.some(m => !m.model)).toBe(false);
  });

  it("reports zero rather than null for a project with no priced traffic", async () => {
    const other = await engine.json("/api/v1/projects", post({ name: "No spend project" }, null));
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const res = await engine.json("/api/v1/agent-monitoring/cost-trend", { apiKey: otherKey });
    const trend = res.body as CostTrend;
    expect(trend.totalCost).toBe(0);
    expect(trend.models).toEqual([]);
    expect(trend.points.every(p => Object.keys(p.byModel).length === 0)).toBe(true);
  });

  it("keeps one project's spend out of another's chart", async () => {
    const other = await engine.json("/api/v1/projects", post({ name: "Other cost project" }, null));
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const res = await engine.json("/api/v1/agent-monitoring/cost-trend", { apiKey: otherKey });
    expect((res.body as CostTrend).totalCost).toBe(0);
  });
});

describe("model pricing catalog", () => {
  it("refuses a duplicate model id", async () => {
    const res = await engine.json(
      "/api/v1/agent-monitoring/portability/models",
      post({ id: MODEL_ID, provider: "openai", label: "dup", pricePerMInputTokens: 1, pricePerMOutputTokens: 1 }, key)
    );
    expect(res.status).toBe(409);
  });

  it("validates the fields a price depends on", async () => {
    const bad: Record<string, unknown>[] = [
      { provider: "openai", label: "l", pricePerMInputTokens: 1, pricePerMOutputTokens: 1 },
      { id: "x1", provider: "wat", label: "l", pricePerMInputTokens: 1, pricePerMOutputTokens: 1 },
      { id: "x2", provider: "openai", pricePerMInputTokens: 1, pricePerMOutputTokens: 1 },
      { id: "x3", provider: "openai", label: "l", pricePerMInputTokens: "free", pricePerMOutputTokens: 1 },
      { id: "x4", provider: "custom", label: "l", pricePerMInputTokens: 1, pricePerMOutputTokens: 1 },
    ];
    for (const body of bad) {
      const res = await engine.json("/api/v1/agent-monitoring/portability/models", post(body, key));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("never returns a stored API key in full", async () => {
    const created = await engine.json(
      "/api/v1/agent-monitoring/portability/models",
      post(
        {
          id: "secret-model",
          provider: "custom",
          label: "Secret",
          baseUrl: "https://example.test/v1",
          apiKey: "sk-super-secret-value-12345",
          pricePerMInputTokens: 1,
          pricePerMOutputTokens: 1,
        },
        key
      )
    );
    expect(created.status).toBe(201);
    const listed = await engine.json("/api/v1/agent-monitoring/portability/models", { apiKey: key });
    const serialized = JSON.stringify(listed.body);
    expect(serialized, "a provider key was echoed back in full").not.toContain("sk-super-secret-value-12345");
    expect(serialized).toContain("...");
  });
});

// ClickHouse telemetry tier: tool calls live in the agentx_tool_calls JSON column there, so the
// per-call pricing has to survive that round trip too. Opt-in like every other CH suite.
const CH_URL = process.env.AGENTX_TEST_CLICKHOUSE_URL;
describe.skipIf(!CH_URL)("cost trend with ClickHouse telemetry", () => {
  let chEngine: TestEngine;
  let chKey: string;
  beforeAll(async () => {
    chEngine = await startEngine({ AGENTX_TELEMETRY_URL: CH_URL! });
    const project = await chEngine.json("/api/v1/projects", post({ name: "Cost project (CH)" }, null));
    chKey = (project.body as { project: { apiKey: string } }).project.apiKey;
  }, 90_000);
  afterAll(async () => {
    await chEngine?.stop();
  });

  it("prices registered tool calls read back from ClickHouse spans", async () => {
    expect(chEngine.log()).toContain("Telemetry store: ClickHouse");
    const tool = await chEngine.json("/api/v1/evaluate/tool-schemas", post({ name: "ch_geocode", definition: "{}", pricePerCallUsd: 0.3 }, chKey));
    expect(tool.status, JSON.stringify(tool.body)).toBe(201);
    const res = await chEngine.json(
      "/api/v1/ingest/traces",
      post({ name: "ch-cost-agent", span_id: "ch-cost-1", input: "q", output: "a", started_at_unix_nano: nanos(60), tool_calls: [{ name: "ch_geocode", success: true }, { name: "ch_geocode", success: false }] }, chKey)
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const deadline = Date.now() + 10_000;
    let trend: CostTrend;
    do {
      const read = await chEngine.json("/api/v1/agent-monitoring/cost-trend?window=7d", { apiKey: chKey });
      expect(read.status).toBe(200);
      trend = read.body as CostTrend;
      if ((trend.totalsByTool.ch_geocode ?? 0) > 0) break;
      await new Promise(r => setTimeout(r, 200));
    } while (Date.now() < deadline);
    expect(trend.totalsByModel["tool calls"]).toBeCloseTo(0.6, 9);
    expect(trend.totalsByTool).toEqual({ ch_geocode: 0.6 });
  }, 60_000);
});
