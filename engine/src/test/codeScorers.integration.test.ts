import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { startEngine, type TestEngine } from "./server.js";

// Code scorers (user JS/Python run in-engine) and the External scorer's v2 payload contract.

let engine: TestEngine;

const post = (body: unknown, apiKey: string): RequestInit & { apiKey: string } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  apiKey,
});

async function newProject(name: string): Promise<string> {
  const res = await engine.json("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    apiKey: null,
  });
  expect(res.status).toBe(201);
  return (res.body as { project: { apiKey: string } }).project.apiKey;
}

async function signals(apiKey: string): Promise<{ patternKey?: string; summary?: string }[]> {
  const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey });
  return ((res.body as { signals?: { patternKey?: string; summary?: string }[] }).signals ?? []);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 12_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

function pythonAvailable(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const JS_SCRIPT = `
async function handler(input, output, expected, metadata, trace) {
  const spans = await trace.getSpans();
  if (typeof output !== "string") return null;
  return {
    name: "brevity scorer",
    score: output.length < 40 ? 1.0 : 0.0,
    metadata: { spanCount: spans.length },
  };
}`;

describe("code scorers", () => {
  it("JS scorer: a low score raises a signal, a high score records an event only", async () => {
    const key = await newProject("JS code scorer");
    const create = await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({
      name: "Brevity", kind: "code", language: "javascript", script: JS_SCRIPT, sampleRate: 1, alertBelow: 0.5,
    }, key));
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const evaluatorId = (create.body as { evaluator: { _id: string; kind: string } }).evaluator._id;
    expect((create.body as { evaluator: { kind: string } }).evaluator.kind).toBe("code");

    // Long output -> score 0 -> below threshold -> signal.
    await engine.json("/api/v1/ingest/traces", post({ name: "verbose-agent", input: "q", output: "This is a very long response that rambles on well past forty characters." , span_id: "cs-1" }, key));
    const flagged = await waitFor(async () => (await signals(key)).find(s => s.patternKey === `custom-eval:${evaluatorId}`) ?? null);
    expect(flagged, "low score raised no signal").toBeTruthy();
    expect(flagged!.summary).toContain("0.00");

    // Short output -> score 1 -> no new signal, but the event history records the check.
    await engine.json("/api/v1/ingest/traces", post({ name: "terse-agent", input: "q", output: "Done.", span_id: "cs-2" }, key));
    const events = await waitFor(async () => {
      const res = await engine.json(`/api/v1/agent-monitoring/custom-evaluators/${evaluatorId}/events?window=24h`, { apiKey: key });
      const list = (res.body as { events?: { score?: number | null }[] }).events ?? [];
      return list.length >= 2 ? list : null;
    });
    expect(events, "second check never recorded an event").toBeTruthy();
    expect(events!.some(e => e.score === 1)).toBe(true);
  }, 60_000);

  it("JS scorer: returning null skips the trace entirely", async () => {
    const key = await newProject("JS skip scorer");
    const create = await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({
      name: "Skipper", kind: "code", language: "javascript", sampleRate: 1,
      script: "async function handler() { return null; }",
    }, key));
    const evaluatorId = (create.body as { evaluator: { _id: string } }).evaluator._id;
    await engine.json("/api/v1/ingest/traces", post({ name: "skip-agent", input: "q", output: "anything", span_id: "sk-1" }, key));
    await new Promise(r => setTimeout(r, 1_500));
    const res = await engine.json(`/api/v1/agent-monitoring/custom-evaluators/${evaluatorId}/events?window=24h`, { apiKey: key });
    expect(((res.body as { events?: unknown[] }).events ?? [])).toHaveLength(0);
    expect((await signals(key)).filter(s => s.patternKey === `custom-eval:${evaluatorId}`)).toEqual([]);
  }, 40_000);

  it.skipIf(!pythonAvailable())("Python scorer: handler with span access scores and flags", async () => {
    const key = await newProject("Python code scorer");
    const script = [
      "async def handler(input, output, expected, metadata, trace):",
      "    spans = await trace.get_spans()",
      "    return {",
      "        'name': 'py scorer',",
      "        'score': 0.0 if 'refund' in str(output) else 1.0,",
      "        'metadata': {'span_count': len(spans)},",
      "    }",
    ].join("\n");
    const create = await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({
      name: "PyScorer", kind: "code", language: "python", script, sampleRate: 1, alertBelow: 0.5,
    }, key));
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const evaluatorId = (create.body as { evaluator: { _id: string } }).evaluator._id;
    await engine.json("/api/v1/ingest/traces", post({ name: "py-agent", input: "q", output: "I promised a refund of 50%", span_id: "py-1" }, key));
    const flagged = await waitFor(async () => (await signals(key)).find(s => s.patternKey === `custom-eval:${evaluatorId}`) ?? null, 20_000);
    expect(flagged, "python scorer raised no signal").toBeTruthy();
    expect(flagged!.summary).toContain("py scorer");
  }, 60_000);

  it("code-kind dry run executes the script against the sample", async () => {
    const key = await newProject("Dry run code");
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({
      kind: "code", language: "javascript", name: "dry",
      script: "async function handler(input, output, expected, metadata, trace) { const llm = await trace.getSpans({ spanType: ['llm'] }); return llm.length > 0 ? 0.2 : 0.9; }",
      alertBelow: 0.5,
    }, key));
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; response?: { matches: boolean; score?: number } };
    expect(body.ok).toBe(true);
    // The sample spans include one llm span -> score 0.2 -> below 0.5 -> would raise a signal.
    expect(body.response?.score).toBeCloseTo(0.2, 5);
    expect(body.response?.matches).toBe(true);
  }, 40_000);

  it("rejects a code scorer without a script, and an external scorer without a url", async () => {
    const key = await newProject("Validation");
    const noScript = await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({ name: "x", kind: "code", language: "javascript" }, key));
    expect(noScript.status).toBe(400);
    const noUrl = await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({ name: "y" }, key));
    expect(noUrl.status).toBe(400);
  }, 40_000);
});

describe("external scorer contract v2", () => {
  it("sends the full trace record and span list, keeping the v1 keys intact", async () => {
    const key = await newProject("External v2");
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => (raw += chunk));
      req.on("end", () => {
        received.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ matches: false }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await engine.json("/api/v1/agent-monitoring/custom-evaluators", post({
        name: "Receiver", url: `http://127.0.0.1:${port}/score`, sampleRate: 1,
      }, key));
      await engine.json("/api/v1/ingest/traces", post({
        name: "v2-agent", input: "where is my order", output: "on its way", span_id: "v2-1",
        model: "gpt-4o-mini", latency_ms: 321, session_id: "v2-session",
        metadata: { channel: "chat" },
      }, key));

      const payload = await waitFor(async () => (received[0] as Record<string, unknown> | undefined) ?? null);
      expect(payload, "endpoint never called").toBeTruthy();
      const p = payload as { schemaVersion: number; trace: Record<string, unknown>; spans: unknown[] };
      expect(p.schemaVersion).toBe(2);
      // v1 keys still exactly where they were:
      expect(p.trace.input).toBe("where is my order");
      expect(p.trace.output).toBe("on its way");
      expect(p.trace.error).toBeNull();
      // and the rest of the traced record rides along:
      expect(p.trace.model).toBe("gpt-4o-mini");
      expect(p.trace.latencyMs).toBe(321);
      expect(p.trace.sessionId).toBe("v2-session");
      expect(p.trace.metadata).toEqual({ channel: "chat" });
      expect(Array.isArray(p.spans)).toBe(true);
      expect((p.spans[0] as { type?: string }).type).toBe("llm");
    } finally {
      server.close();
    }
  }, 60_000);
});
