import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Webhook parity for judge verdicts: a below-threshold online-evaluator score raises a Signal
// like a matched Pattern does, so it must page the agent's alert channels the same way too.
// Before this, only Patterns called notifyWebhooks (detect.ts) - a customer with a webhook
// configured got paged for regex-ish pattern hits but never for "the judge rated this 0/10",
// the verdict they most expect to hear about.

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let hookStub: http.Server;
let stubUrl: string;
let hookUrl: string;
const hookPayloads: Array<Record<string, unknown>> = [];

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  judgeStub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify({ rating: 2, justification: "stub says bad" }),
          usage: { input_tokens: 5, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const judgeAddr = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof judgeAddr === "object" && judgeAddr ? judgeAddr.port : 0}`;

  hookStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      try {
        hookPayloads.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        hookPayloads.push({ raw });
      }
      res.end("ok");
    });
  });
  await new Promise<void>(resolve => hookStub.listen(0, "127.0.0.1", resolve));
  const hookAddr = hookStub.address();
  hookUrl = `http://127.0.0.1:${typeof hookAddr === "object" && hookAddr ? hookAddr.port : 0}/hook`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "low-score-webhook" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-low",
      provider: "custom",
      label: "Stub judge (low)",
      baseUrl: stubUrl,
      pricePerMInputTokens: 0,
      pricePerMOutputTokens: 0,
    })
  );
  expect(model.status).toBe(201);

  const scorer = await api(
    "/agent-monitoring/judge-scorers",
    postJson({
      name: "paging-judge",
      judge: { evaluationCriteria: "Anything.", judgeModel: "stub-judge-low" },
      online: { enabled: true, sampleRate: 1, alertThreshold: 5 },
    })
  );
  expect(scorer.status).toBe(201);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
  await new Promise<void>(resolve => judgeStub.close(() => resolve()));
  await new Promise<void>(resolve => hookStub.close(() => resolve()));
});

describe("low-score judge verdicts page the agent's webhook channels", () => {
  it("POSTs the same alert shape a matched pattern sends", async () => {
    // First ingest registers the agent so its profile (and channels) can exist...
    await api("/ingest/traces", postJson({ name: "paged-agent", input: "q1", output: "meh", span_id: "w-1" }));
    await new Promise(r => setTimeout(r, 1500));
    const agents = await api("/agent-monitoring/agents");
    const agent = ((agents.body as { agents: Array<{ _id: string; name: string }> }).agents ?? []).find(
      a => a.name === "paged-agent"
    );
    expect(agent).toBeTruthy();
    const put = await api(`/monitor/profiles/${agent!._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channels: [`webhook:${hookUrl}`] }),
    });
    expect(put.status).toBe(200);

    // ...then the second trace is scored with the channel in place: judge says 2/10 -> signal
    // -> webhook.
    hookPayloads.length = 0;
    await api("/ingest/traces", postJson({ name: "paged-agent", input: "q2", output: "meh again", span_id: "w-2" }));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && hookPayloads.length === 0) {
      await new Promise(r => setTimeout(r, 200));
    }
    expect(hookPayloads.length, "no webhook arrived for a below-threshold judge verdict").toBeGreaterThan(0);
    const hit = hookPayloads.find(p => String(p.patternKey ?? "").startsWith("online-eval:")) as
      | Record<string, unknown>
      | undefined;
    expect(hit, JSON.stringify(hookPayloads).slice(0, 300)).toBeTruthy();
    expect(String(hit!.summary)).toContain("rated this response 2.0/10");
    expect(hit!.severity).toBeTruthy();

    // The verdict also rides the trace list: Live Traces' Score column reads judgeScores - the
    // threshold-aware summary with attribution (which scorer), coverage (how many judged), and
    // the per-judge breakdown. Null = never sampled, never fabricated.
    const list = await api("/ingest/traces?limit=50");
    const traces = (
      list.body as {
        traces: Array<{
          name: string;
          judgeScores: {
            rating: number;
            threshold: number | null;
            scorerName: string;
            judgeCount: number;
            failingCount: number;
            verdicts: Array<{ scorerName: string; failing: boolean }>;
          } | null;
        }>;
      }
    ).traces;
    const scored = traces.find(t => t.name === "paged-agent" && t.judgeScores !== null);
    expect(scored, "no listed trace carried judge scores").toBeTruthy();
    const summary = scored!.judgeScores!;
    expect(summary.rating).toBe(2);
    expect(summary.threshold).toBe(5);
    expect(summary.scorerName).toBe("paging-judge");
    expect(summary.judgeCount).toBe(1);
    expect(summary.failingCount).toBe(1);
    expect(summary.verdicts[0]).toMatchObject({ scorerName: "paging-judge", failing: true });
  }, 60_000);
});
