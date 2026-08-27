import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Two regressions the monitor_ops sample suite surfaced, pinned:
// 1. The SDK-router profile PUT silently dropped `channels`, so webhook fan-out configured
//    from the SDK did nothing.
// 2. The online-judge daily cap was check-then-act: a burst of ingests all read the pre-burst
//    event count and blew through it. It reserves slots now.

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify({ rating: 8, justification: "stub" }),
          usage: { input_tokens: 5, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    AGENTX_QUOTA_ONLINE_JUDGE_CALLS_PER_DAY: "2",
  });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "monitor-ops" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-m",
      provider: "custom",
      label: "Stub judge M",
      baseUrl: stubUrl,
      pricePerMInputTokens: 0,
      pricePerMOutputTokens: 0,
    })
  );
  expect(model.status).toBe(201);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
  await new Promise<void>(resolve => judgeStub.close(() => resolve()));
});

describe("SDK-router profile PUT", () => {
  it("round-trips webhook channels instead of dropping them", async () => {
    await api("/ingest/traces", postJson({ name: "hook-agent", input: "w", output: "ok", span_id: "h-1" }));
    await new Promise(r => setTimeout(r, 400));
    const agents = await api("/agent-monitoring/agents");
    const agent = ((agents.body as { agents: Array<{ _id: string; name: string }> }).agents ?? []).find(
      a => a.name === "hook-agent"
    );
    expect(agent).toBeTruthy();

    const put = await api(
      `/monitor/profiles/${agent!._id}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ channels: ["webhook:http://127.0.0.1:1/x"] }) }
    );
    expect(put.status).toBe(200);
    expect((put.body as { profile: { channels: string[] } }).profile.channels).toEqual([
      "webhook:http://127.0.0.1:1/x",
    ]);
  });
});

describe("online judge daily cap", () => {
  it("a burst of eligible traces is judged exactly cap times, never more", async () => {
    const scorer = await api(
      "/agent-monitoring/judge-scorers",
      postJson({
        name: "capped-judge",
        judge: { evaluationCriteria: "Anything.", judgeModel: "stub-judge-m" },
        online: { enabled: true, sampleRate: 1, alertThreshold: null },
      })
    );
    expect(scorer.status).toBe(201);
    const profileId = (scorer.body as { judgeScorer: { online: { profileId: string } } }).judgeScorer.online.profileId;

    // Burst: five ingests land before any judging finishes - the exact race the old
    // check-then-act budget lost.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        api("/ingest/traces", postJson({ name: "burst-agent", input: `q${i}`, output: `a${i}`, span_id: `b-${i}` }))
      )
    );
    await new Promise(r => setTimeout(r, 2500));

    const events = await api(`/agent-monitoring/online-evaluators/${profileId}/events?window=24h`);
    const judged = ((events.body as { events?: Array<{ rating: number }> }).events ?? []).length;
    expect(judged).toBe(2);
  });
});
