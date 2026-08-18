import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Overview's cost chart is the only place this engine puts a dollar figure in front of anyone.
// It prices real traces against the user-maintained catalog, merges dated model snapshots onto
// their base id, and buckets by when the traffic happened. A factor-of-1000 or a mis-bucketed
// day reads as a perfectly plausible number, so this checks exact amounts against a catalog the
// test defines.

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
