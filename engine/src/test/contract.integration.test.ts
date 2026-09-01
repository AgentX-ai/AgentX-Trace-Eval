import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import {
  insightsCoverageResponseSchema,
  insightsProbeBatchResponseSchema,
  insightsProbeResponseSchema,
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
    // Mixed case on purpose: ingest folds it, and the metrics assertions below prove the
    // populated byFramework branch (not just empty records) satisfies the contract.
    framework: "LangChain",
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
    // Platform attribution: normalized at ingest ("LangChain" -> "langchain"), ranked, faceted.
    expect(parsed.frameworks.find(f => f.name === "langchain")?.count).toBeGreaterThan(0);
    expect(parsed.facets.frameworks).toContain("langchain");
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

  it("GET /insights/coverage matches the contract with no classified traffic", async () => {
    // Topics is opt-in and sampled, so an install with nothing classified yet is the COMMON
    // first view of this screen - it has to be a clean, parseable empty state rather than a 500.
    const res = await api("/insights/coverage?window=7d");
    expect(res.status).toBe(200);
    const parsed = insightsCoverageResponseSchema.parse(res.body);
    expect(parsed.insufficientData).toBe(true);
    expect(parsed.topics).toEqual([]);
  });

  it("POST /insights/probe matches the contract and validates its body", async () => {
    const res = await api("/insights/probe", postJson({ query: "how do I reset my password" }));
    expect(res.status).toBe(200);
    const parsed = insightsProbeResponseSchema.parse(res.body);
    // No dataset case is anywhere near it and production has never been classified, so the only
    // honest answer is the one that does not manufacture a gap.
    expect(parsed.verdict).toBe("untested-and-unasked");
    expect(parsed.explanation).toContain("not a gap");

    const empty = await api("/insights/probe", postJson({ query: "   " }));
    expect(empty.status).toBe(400);
  });

  it("POST /insights/probe/batch matches the contract", async () => {
    const res = await api("/insights/probe/batch", postJson({ queries: ["close my account", "refund status"] }));
    expect(res.status).toBe(200);
    const parsed = insightsProbeBatchResponseSchema.parse(res.body);
    expect(parsed.rollup.total).toBe(2);
    expect(parsed.results).toHaveLength(2);

    const none = await api("/insights/probe/batch", postJson({ queries: [] }));
    expect(none.status).toBe(400);
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
