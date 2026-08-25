import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import {
  judgeScorersResponseSchema,
  monitoringDefaultsPutResponseSchema,
  monitorMetricsResponseSchema,
  settingsResponseSchema,
  signalsResponseSchema,
  tracesPageSchema,
  WIRE_CONTRACT,
} from "../contract/wire.js";

// The wire contract, enforced: every covered endpoint's LIVE response must parse against its
// schema in src/contract/wire.ts. The schemas are .strict(), so a field the engine starts
// sending without updating the contract fails HERE, in the same commit - instead of drifting
// away from the frontend's hand-written types and the SDK's models until something breaks.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "contract" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  // Seed enough real data that the schemas exercise their populated branches, not just empties:
  // a trace with cache tokens + tool calls (metrics cost splits, trace list fields), a
  // secrets-in-response detection (signals with occurrences), and the seeded judge templates
  // are already present for judge-scorers.
  const put = (body: unknown) => ({
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  await api(
    "/agent-monitoring/settings/monitoring-defaults",
    put({ enabledBuiltinPatterns: ["secrets-in-response"], topicsSampleRate: 0.5 })
  );
  await api("/ingest/traces", postJson({
    name: "contract-agent",
    input: "what's my key?",
    output: "here you go: sk-proj-Abc123def456ghi789jkl012",
    model: "gpt-4o-mini",
    latencyMs: 420,
    inputTokens: 400,
    outputTokens: 80,
    cacheReadTokens: 100,
    toolCalls: [{ name: "lookup", success: true }],
    span_id: "ct-1",
  }));
  // Wait for the async detection to raise the signal so the signals schema sees a real row.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const res = await api("/agent-monitoring/signals?limit=10");
    if (((res.body as { signals?: unknown[] }).signals ?? []).length > 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("wire contract", () => {
  it("GET /agent-monitoring/metrics matches the contract", async () => {
    const res = await api("/agent-monitoring/metrics?window=24h");
    expect(res.status).toBe(200);
    const parsed = monitorMetricsResponseSchema.parse(res.body);
    expect(parsed.totals.traces).toBeGreaterThan(0);
    expect(parsed.totals.costCached).toBeGreaterThan(0);
  });

  it("GET /agent-monitoring/settings and the defaults PUT match the contract", async () => {
    const settings = await api("/agent-monitoring/settings");
    expect(settings.status).toBe(200);
    settingsResponseSchema.parse(settings.body);
    const put = await api("/agent-monitoring/settings/monitoring-defaults", {
      method: "PUT",
      body: JSON.stringify({ retentionDays: 7 }),
      headers: { "content-type": "application/json" },
    });
    expect(put.status).toBe(200);
    const parsed = monitoringDefaultsPutResponseSchema.parse(put.body);
    expect(parsed.monitoringDefaults.topicsSampleRate).toBe(0.5);
  });

  it("GET /ingest/traces matches the contract", async () => {
    const res = await api("/ingest/traces?limit=10");
    expect(res.status).toBe(200);
    const parsed = tracesPageSchema.parse(res.body);
    expect(parsed.traces.length).toBeGreaterThan(0);
    expect(parsed.traces[0]!.model).toBe("gpt-4o-mini");
  });

  it("GET /agent-monitoring/signals matches the contract, occurrences included", async () => {
    const res = await api("/agent-monitoring/signals?limit=10");
    expect(res.status).toBe(200);
    const parsed = signalsResponseSchema.parse(res.body);
    expect(parsed.signals.length).toBeGreaterThan(0);
  });

  it("GET /agent-monitoring/judge-scorers matches the contract (seeded templates)", async () => {
    const res = await api("/agent-monitoring/judge-scorers");
    expect(res.status).toBe(200);
    const parsed = judgeScorersResponseSchema.parse(res.body);
    expect(parsed.judgeScorers.length).toBeGreaterThan(0);
  });

  it("GET /openapi.json publishes every contract entry", async () => {
    const res = await engine.json("/api/v1/openapi.json", { apiKey: null });
    expect(res.status).toBe(200);
    const doc = res.body as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const entry of WIRE_CONTRACT) {
      expect(doc.paths[`/api/v1${entry.path}`], entry.path).toBeDefined();
      expect(doc.components.schemas[entry.name], entry.name).toBeDefined();
    }
  });
});
