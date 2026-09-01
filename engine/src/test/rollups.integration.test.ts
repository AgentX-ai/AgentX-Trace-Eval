import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import {
  accumulateRollups,
  latencyBucketIndex,
  percentileFromHistogram,
  LATENCY_BUCKET_COUNT,
} from "../core/monitor/rollups.js";
import type { TraceRow } from "../core/trace/store/traceStore.js";

// ADR-0006: dashboards read rollups. The parity test is the load-bearing one - the SAME
// engine, the SAME traffic, once through the rollup fast path (unfiltered) and once through
// the raw scan (an agent filter that matches everything forces it): every counter must agree
// exactly, latency percentiles within the histogram's documented log-bucket error.

describe("rollup unit math", () => {
  it("latency buckets are monotic and merge into sane percentiles", () => {
    expect(latencyBucketIndex(1)).toBe(0);
    expect(latencyBucketIndex(600_000)).toBe(LATENCY_BUCKET_COUNT - 1);
    expect(latencyBucketIndex(50)).toBeLessThan(latencyBucketIndex(5_000));
    const hist = Array.from({ length: LATENCY_BUCKET_COUNT }, () => 0);
    for (const ms of [100, 100, 100, 100, 100, 100, 100, 100, 100, 5_000]) hist[latencyBucketIndex(ms)]!++;
    const p50 = percentileFromHistogram(hist, 50)!;
    const p95 = percentileFromHistogram(hist, 95)!;
    expect(p50).toBeGreaterThan(60);
    expect(p50).toBeLessThan(180);
    expect(p95).toBeGreaterThan(3_000);
    expect(percentileFromHistogram(Array(LATENCY_BUCKET_COUNT).fill(0), 50)).toBeNull();
  });

  it("accumulate splits eval traffic and groups by minute", () => {
    const base: Omit<TraceRow, "id" | "createdAt" | "source"> = {
      name: "a",
      input: null,
      output: "x",
      error: null,
      latencyMs: 100,
      framework: null,
      model: null,
      toolCalls: null,
      metadata: null,
      sessionId: null,
      performanceSummary: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      spanId: null,
      spanKind: null,
      parentSpanId: null,
      startedAt: null,
      agentId: null,
      projectId: "p",
    };
    const t0 = new Date("2026-01-01T00:00:10Z");
    const rows: TraceRow[] = [
      { ...base, id: "1", createdAt: t0, source: null },
      { ...base, id: "2", createdAt: new Date(t0.getTime() + 20_000), source: null },
      { ...base, id: "3", createdAt: new Date(t0.getTime() + 70_000), source: null },
      { ...base, id: "4", createdAt: t0, source: "eval-run" },
    ];
    const accs = accumulateRollups(rows);
    expect(accs.length).toBe(3); // minute0 production, minute1 production, minute0 eval
    const prodMinute0 = accs.find(a => a.production && a.minuteTs === Math.floor(t0.getTime() / 60_000) * 60_000)!;
    expect(prodMinute0.roots).toBe(2);
    expect(prodMinute0.tokensPrompt).toBe(20);
  });
});

describe("rollup parity with the raw scan", () => {
  let engine: TestEngine;
  let key: string;
  const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
    engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

  beforeAll(async () => {
    engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "rollup-parity" }), apiKey: null });
    key = (created.body as { project: { apiKey: string } }).project.apiKey;

    // A controlled mix: sessions with children, tool calls (one failed), models with cache
    // tokens, an error, and an eval-run trace that must stay out of the KPIs.
    const spans = [
      { name: "support-agent", input: "q1", output: "a1", latency_ms: 120, model: "gpt-test", input_tokens: 100, output_tokens: 40, session_id: "s1", span_id: "r1", framework: "langchain", tool_calls: [{ name: "lookup", success: true }] },
      { name: "LLM Call", input: "q1", output: "a1", latency_ms: 80, model: "gpt-test", input_tokens: 60, output_tokens: 20, cache_read_tokens: 20, session_id: "s1", span_id: "c1", parent_span_id: "r1", span_kind: "llm" },
      { name: "support-agent", input: "q2", output: "a2", latency_ms: 480, session_id: "s2", span_id: "r2", framework: "langchain", error: "upstream timeout", tool_calls: [{ name: "lookup", success: false }, { name: "refund", success: true }] },
      // No framework on r3: proves unlabeled roots bucket under "other" on both paths.
      { name: "billing-agent", input: "q3", output: "a3", latency_ms: 40, model: "other-model", input_tokens: 10, output_tokens: 5, span_id: "r3" },
      { name: "eval-agent", input: "q4", output: "a4", latency_ms: 999, span_id: "r4", source: "eval-run", monitor: false },
    ];
    for (const span of spans) {
      const r = await api("/ingest/traces", postJson(span));
      expect(r.status).toBe(200);
    }
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("unfiltered (rollups) equals filter-matches-everything (raw scan)", async () => {
    type Metrics = {
      source: string;
      totals: Record<string, number | null>;
      buckets: { traces: number; errors: number; spansLlm: number; toolCalls: number; tokensPrompt: number }[];
      tools: { name: string; count: number; failed: number }[];
      frameworks: { name: string; count: number }[];
      facets: { agents: string[]; models: string[]; frameworks: string[] };
    };
    const fast = (await api("/agent-monitoring/metrics?window=1h")).body as Metrics;
    // Load-bearing: without this, a dead applyRollups would silently fall back to the raw scan
    // on BOTH sides and the parity assertions below would compare raw-vs-raw, always green.
    expect(fast.source).toBe("rollups");
    // status filter of "all" plus an agent filter that matches nothing is raw; instead force the
    // raw path with an error-status filter twin? No - the honest twin is agent filtering. Two
    // agents cover all production sessions, so query both and sum.
    const rawA = (await api("/agent-monitoring/metrics?window=1h&agent=support-agent")).body as Metrics;
    const rawB = (await api("/agent-monitoring/metrics?window=1h&agent=billing-agent")).body as Metrics;
    expect(rawA.source).toBe("raw");
    expect(rawB.source).toBe("raw");

    // Production totals: 3 roots (eval excluded), 1 error, 3 tool calls, 1 failed.
    expect(fast.totals.traces).toBe(3);
    expect(fast.totals.errors).toBe(1);
    expect(fast.totals.toolCalls).toBe(3);
    expect(fast.totals.toolFailures).toBe(1);
    expect(fast.totals.spansLlm).toBeGreaterThanOrEqual(1);
    expect(fast.totals.tokensPrompt).toBe(170);
    expect(fast.totals.tokensCompletion).toBe(65);

    // Parity: the two raw halves sum to the rollup answer for every additive counter.
    const sum = (k: keyof Metrics["totals"]) => Number(rawA.totals[k] ?? 0) + Number(rawB.totals[k] ?? 0);
    for (const k of ["traces", "errors", "toolCalls", "toolFailures", "tokensPrompt", "tokensCompletion", "spansLlm", "spansTool", "spansRetrieval", "spansOther"] as const) {
      expect(fast.totals[k], k).toBe(sum(k));
    }
    // Cost parity within float noise.
    for (const k of ["costPrompt", "costCached", "costCompletion"] as const) {
      expect(Math.abs(Number(fast.totals[k] ?? 0) - sum(k)), k).toBeLessThan(1e-9);
    }
    // Latency percentiles: histogram error is bounded by one log bucket (ratio ~1.4x).
    const rawP95 = Math.max(Number(rawA.totals.latencyP95 ?? 0), Number(rawB.totals.latencyP95 ?? 0));
    const fastP95 = Number(fast.totals.latencyP95 ?? 0);
    expect(fastP95).toBeGreaterThan(rawP95 / 1.5);
    expect(fastP95).toBeLessThan(rawP95 * 1.5);

    expect(fast.facets.agents.sort()).toEqual(["billing-agent", "support-agent"]);
    expect(fast.tools.find(t => t.name === "lookup")).toEqual({ name: "lookup", count: 2, failed: 1 });

    // Platform attribution parity (platform-agnostic story): labeled roots under their
    // framework, unlabeled under "other", identical on both paths.
    const fwCounts = (m: Metrics) => Object.fromEntries(m.frameworks.map(f => [f.name, f.count]));
    expect(fwCounts(fast)).toEqual({ langchain: 2, other: 1 });
    const rawMerged: Record<string, number> = {};
    for (const m of [rawA, rawB]) for (const f of m.frameworks) rawMerged[f.name] = (rawMerged[f.name] ?? 0) + f.count;
    expect(rawMerged).toEqual(fwCounts(fast));
    // Facets suggest only real labels, never the "other" bucket.
    expect(fast.facets.frameworks).toEqual(["langchain"]);
  });

  it("framework filter forces the raw path and scopes every counter", async () => {
    type Metrics = {
      source: string;
      totals: Record<string, number | null>;
      frameworks: { name: string; count: number }[];
    };
    const filtered = (await api("/agent-monitoring/metrics?window=1h&framework=langchain")).body as Metrics;
    expect(filtered.source).toBe("raw");
    expect(filtered.totals.traces).toBe(2);
    expect(filtered.totals.errors).toBe(1);
    expect(filtered.frameworks).toEqual([{ name: "langchain", count: 2 }]);
    // The unlabeled bucket is filterable too, and mixed-case queries fold to the stored form.
    const other = (await api("/agent-monitoring/metrics?window=1h&framework=other")).body as Metrics;
    expect(other.totals.traces).toBe(1);
    const cased = (await api("/agent-monitoring/metrics?window=1h&framework=LangChain")).body as Metrics;
    expect(cased.totals.traces).toBe(2);
  });
});
