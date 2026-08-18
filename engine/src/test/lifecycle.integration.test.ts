import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// One trace's full journey: ingested by the SDK, listed in Observe, opened in the trace dialog,
// grouped into a session, and picked up by Monitor's built-in detectors. These run as detached
// background work after the response is sent (routes/ingest.ts), so the assertions poll.

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function ingest(body: Record<string, unknown>): Promise<string> {
  const res = await engine.json("/api/v1/ingest/traces", post(body));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { trace_id: string }).trace_id;
}

type Signal = { patternKey?: string; severity?: string; summary?: string; type?: string; _id?: string; status?: string };

async function signalsFor(predicate: (s: Signal) => boolean, timeoutMs = 10_000): Promise<Signal[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Signal[] = [];
  while (Date.now() < deadline) {
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
    last = ((res.body as { signals?: Signal[] }).signals ?? []).filter(predicate);
    if (last.length > 0) {
      return last;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return last;
}

describe("trace lifecycle", () => {
  it("lists an ingested trace and serves its detail", async () => {
    const traceId = await ingest({
      name: "support-agent",
      input: "where is my order?",
      output: "shipped monday",
      model: "gpt-4o-mini",
      framework: "openai",
      latency_ms: 820,
      input_tokens: 120,
      output_tokens: 35,
    });

    const list = await engine.json("/api/v1/ingest/traces");
    expect(list.status).toBe(200);
    const traces = (list.body as { traces: { _id: string; name: string }[] }).traces;
    expect(traces.map(t => t._id)).toContain(traceId);

    const detail = await engine.json(`/api/v1/ingest/traces/${traceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: "support-agent", model: "gpt-4o-mini", latencyMs: 820 });
  });

  it("registers an agent from the trace name", async () => {
    await ingest({ name: "billing-agent", input: "q", output: "a" });
    const agents = await engine.json("/api/v1/agents");
    expect(agents.status).toBe(200);
    expect(JSON.stringify(agents.body)).toContain("billing-agent");
  });

  it("groups spans of one session and keeps child spans out of the trace list", async () => {
    const sessionId = "session-lifecycle-1";
    const rootId = await ingest({ name: "root", session_id: sessionId, span_id: "root-1", input: "q", output: "a" });
    await ingest({ name: "child", session_id: sessionId, span_id: "child-1", parent_span_id: "root-1", input: "q", output: "a" });

    const spans = await engine.json(`/api/v1/ingest/sessions/${sessionId}/spans`);
    expect(spans.status).toBe(200);
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(2);

    const list = await engine.json("/api/v1/ingest/traces?limit=100");
    const ids = (list.body as { traces: { _id: string }[] }).traces.map(t => t._id);
    expect(ids).toContain(rootId);
    // Child spans are sub-detail, not top-level rows.
    const childIds = (spans.body as { spans: { _id?: string; id?: string }[] }).spans
      .map(s => s._id ?? s.id)
      .filter(id => id !== rootId);
    for (const childId of childIds) {
      expect(ids).not.toContain(childId);
    }
  });

  it("dedupes a replayed span rather than storing it twice", async () => {
    const body = { name: "replayed", span_id: "replay-1", input: "q", output: "a" };
    const first = await ingest(body);
    const second = await ingest(body);
    expect(second).toBe(first);
  });

  it("paginates with a cursor without repeating or dropping rows", async () => {
    for (let i = 0; i < 5; i++) {
      await ingest({ name: `paged-${i}`, span_id: `paged-${i}`, input: "q", output: "a" });
    }
    const firstPage = await engine.json("/api/v1/ingest/traces?limit=3");
    const { traces, nextCursor } = firstPage.body as { traces: { _id: string }[]; nextCursor?: string | null };
    expect(traces).toHaveLength(3);
    expect(nextCursor).toBeTruthy();

    const secondPage = await engine.json(`/api/v1/ingest/traces?limit=3&cursor=${encodeURIComponent(nextCursor!)}`);
    const secondIds = (secondPage.body as { traces: { _id: string }[] }).traces.map(t => t._id);
    for (const id of traces.map(t => t._id)) {
      expect(secondIds).not.toContain(id);
    }
  });
});

describe("built-in monitor detection", () => {
  it("raises a tool-failure signal naming the tool", async () => {
    await ingest({
      name: "tool-agent",
      input: "look up order 42",
      output: "sorry, something went wrong",
      tool_calls: [{ name: "lookup_order", input: { id: 42 }, output: null, success: false }],
    });
    const signals = await signalsFor(s => (s.patternKey ?? "").startsWith("agent-tool-failure"));
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.patternKey).toBe("agent-tool-failure:lookup_order");
    expect(signals[0]!.severity).toBe("high");
  });

  it("raises a trace-error signal", async () => {
    await ingest({ name: "erroring-agent", input: "q", output: "", error: "RateLimitError: slow down" });
    const signals = await signalsFor(s => s.patternKey === "agent-trace-error");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.summary).toContain("RateLimitError");
  });

  it("raises an empty-response signal", async () => {
    await ingest({ name: "silent-agent", input: "hello?", output: "   " });
    const signals = await signalsFor(s => s.patternKey === "empty-agent-response");
    expect(signals.length).toBeGreaterThan(0);
  });

  it("raises a PII signal for an email address in the response", async () => {
    await ingest({ name: "leaky-agent", input: "who handles this?", output: "contact tess.morgan@example.com about it" });
    const signals = await signalsFor(s => s.patternKey === "pii-in-response");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.summary).toContain("email");
  });

  it("does not raise a PII signal for an ordinary order id", async () => {
    await ingest({ name: "clean-agent", input: "order status", output: "order 1234567890 ships tuesday" });
    // Give the background check the same window the positive cases get.
    await new Promise(r => setTimeout(r, 1_000));
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
    const forThisAgent = ((res.body as { signals?: (Signal & { agentName?: string })[] }).signals ?? []).filter(
      s => s.patternKey === "pii-in-response" && JSON.stringify(s).includes("1234567890")
    );
    expect(forThisAgent).toEqual([]);
  });

  it("skips detection entirely when the trace opts out with monitor:false", async () => {
    await ingest({ name: "opted-out-agent", input: "q", output: "", monitor: false });
    await new Promise(r => setTimeout(r, 1_000));
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
    const raised = ((res.body as { signals?: Signal[] }).signals ?? []).filter(s => JSON.stringify(s).includes("opted-out-agent"));
    expect(raised).toEqual([]);
  });

  it("serves signal detail and accepts a triage status change", async () => {
    const signals = await signalsFor(s => Boolean(s._id));
    const signalId = signals[0]!._id!;
    const detail = await engine.json(`/api/v1/agent-monitoring/signals/${signalId}`);
    expect(detail.status).toBe(200);

    const patched = await engine.json(`/api/v1/agent-monitoring/signals/${signalId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
      headers: { "content-type": "application/json" },
    });
    expect(patched.status).toBeLessThan(300);
    const after = await engine.json(`/api/v1/agent-monitoring/signals/${signalId}`);
    expect(JSON.stringify(after.body)).toContain("resolved");
  });
});

describe("dashboard aggregates", () => {
  it("answers every overview widget without an LLM key configured", async () => {
    for (const path of [
      "/api/v1/agent-monitoring/kpis",
      "/api/v1/agent-monitoring/trend",
      "/api/v1/agent-monitoring/performance",
      "/api/v1/agent-monitoring/top-failing",
      "/api/v1/agent-monitoring/cost-trend",
      "/api/v1/agent-monitoring/calibration",
      "/api/v1/agent-monitoring/model-comparison",
      "/api/v1/agent-monitoring/topics",
      "/api/v1/agent-monitoring/sessions",
      "/api/v1/agent-monitoring/settings",
      "/api/v1/agent-monitoring/portability/models",
      "/api/v1/agent-monitoring/portability/models/unpriced",
    ]) {
      const res = await engine.json(path);
      expect(res.status, `${path} -> ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
  });

  it("accepts every documented monitoring window on the windowed widgets", async () => {
    for (const path of ["/api/v1/agent-monitoring/trend", "/api/v1/agent-monitoring/cost-trend", "/api/v1/agent-monitoring/kpis"]) {
      for (const window of ["24h", "7d", "30d"]) {
        const res = await engine.json(`${path}?window=${window}`);
        expect(res.status, `${path}?window=${window}`).toBe(200);
      }
    }
  });
});
