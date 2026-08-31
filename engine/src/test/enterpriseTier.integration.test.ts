import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The enterprise tier end to end (ADR-0001/0003): a REAL engine process with
// AGENTX_TELEMETRY_URL pointed at ClickHouse - spans live there, the control plane stays
// relational - exercised through the public wire: ingest (queued, deduped), the trace list
// with search, session span trees, and the Monitor metrics dashboard. Opt-in via
// AGENTX_TEST_CLICKHOUSE_URL, same posture as the Postgres suites.

const CH_URL = process.env.AGENTX_TEST_CLICKHOUSE_URL;

describe.skipIf(!CH_URL)("enterprise tier (ClickHouse telemetry)", () => {
  let engine: TestEngine;
  let key: string;
  const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
    engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

  beforeAll(async () => {
    engine = await startEngine({
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      AGENTX_TELEMETRY_URL: CH_URL!,
    });
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "enterprise-tier" }), apiKey: null });
    key = (created.body as { project: { apiKey: string } }).project.apiKey;
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("actually uses ClickHouse: boot banner names it and rows are physically there", async () => {
    expect(engine.log()).toContain("Telemetry store: ClickHouse");
    // Per-run probe id: the shared test ClickHouse persists across suite runs, and span dedupe
    // is per project - a fixed id would double-count on the second run.
    const probeId = `ch-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await api("/ingest/traces", postJson({ name: "ch-agent", input: "probe", output: "probe", span_id: probeId }));
    const chUrl = new URL(CH_URL!);
    const res = await fetch(
      `${chUrl.protocol}//${chUrl.host}/?query=${encodeURIComponent(`SELECT count(*) FROM agentx_spans WHERE span_id = '${probeId}'`)}`,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${decodeURIComponent(chUrl.username)}:${decodeURIComponent(chUrl.password)}`).toString("base64"),
        },
      }
    );
    expect((await res.text()).trim()).toBe("1");
  });

  it("ingests through the queue into ClickHouse with read-your-writes and dedupe", async () => {
    const first = await api(
      "/ingest/traces",
      postJson({ name: "ch-agent", input: "where is my order", output: "on its way", span_id: "ch-1", latency_ms: 90 })
    );
    expect(first.status).toBe(200);
    const id = (first.body as { traceId: string }).traceId;

    const replay = await api("/ingest/traces", postJson({ name: "ch-agent", input: "x", output: "y", span_id: "ch-1" }));
    expect((replay.body as { deduped: boolean }).deduped).toBe(true);
    expect((replay.body as { traceId: string }).traceId).toBe(id);

    const list = await api("/ingest/traces");
    const rows = (list.body as { traces: { _id: string; output: unknown }[] }).traces;
    expect(rows.map(r => r._id)).toContain(id);
  });

  it("session span trees assemble from ClickHouse rows", async () => {
    await api(
      "/ingest/traces",
      postJson({ name: "ch-agent", input: "root q", output: "root a", span_id: "sess-root", session_id: "ch-sess" })
    );
    await api(
      "/ingest/traces",
      postJson({
        name: "tool step",
        input: "lookup",
        output: "found",
        span_id: "sess-child",
        parent_span_id: "sess-root",
        session_id: "ch-sess",
      })
    );
    const spans = await api("/ingest/sessions/ch-sess/spans");
    expect(spans.status).toBe(200);
    const names = ((spans.body as { spans: { name: string }[] }).spans ?? []).map(s => s.name);
    expect(names.sort()).toEqual(["ch-agent", "tool step"]);
  });

  it("trace search runs database-side in ClickHouse", async () => {
    const hit = await api("/ingest/traces?search=where is my order");
    expect((hit.body as { traces: unknown[] }).traces.length).toBe(1);
    const miss = await api("/ingest/traces?search=100%");
    expect((miss.body as { traces: unknown[] }).traces.length).toBe(0);
  });

  it("monitor metrics read correctly with spans in ClickHouse", async () => {
    const metrics = await api("/agent-monitoring/metrics?window=1h");
    expect(metrics.status).toBe(200);
    const body = metrics.body as { totals: { traces: number }; facets: { agents: string[] } };
    expect(body.totals.traces).toBeGreaterThanOrEqual(2);
    expect(body.facets.agents).toContain("ch-agent");
  });
});
