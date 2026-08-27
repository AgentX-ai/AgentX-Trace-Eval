import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The judge feedback loop, end to end, with a STUB judge: a local OpenAI-compatible Responses
// endpoint registered as a custom portability model, so real scored events / signals /
// calibration / tuning run keylessly and deterministically. Pins the P1 loop wiring:
//   - a low verdict raises a Signal and a scored event
//   - a human review label becomes per-scorer calibration ground truth (source "review")
//   - the review item carries the judge's score (queue-time snapshot or lazy backfill)
//   - tune/publish is provenance-gated: no validation -> 409, regressed -> 409, force -> 200
//     with the provenance stamped into the rubric's version history

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  // Minimal Responses-API stub. It answers every judge call by shape: a scoring schema gets a
  // fixed low rating, a tuning-proposal schema gets a plausible criteria rewrite.
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const wantsProposal = raw.includes("acceptanceCriteria");
      const payload = wantsProposal
        ? {
            acceptanceCriteria: "Concrete resolution with specifics.",
            rejectionCriteria: "Brush-offs.",
            evaluationCriteria: "Did the agent actually resolve the request?",
            judgePrompt: "",
            reasoning: "Tightened the rubric around resolution.",
            changes: [{ tag: "criteria", text: "sharper resolution bar" }],
          }
        : { rating: 3, justification: "stub: weak answer" };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify(payload),
          usage: { input_tokens: 10, output_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "judge-loop" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge",
      provider: "custom",
      label: "Stub judge",
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

let profileId: string;
let scorerId: string;
let traceId: string;

describe("live scoring through the stub judge", () => {
  it("scores a trace, raises a Signal below threshold, records the event", async () => {
    const scorer = await api(
      "/agent-monitoring/judge-scorers",
      postJson({
        name: "loop-judge",
        judge: { evaluationCriteria: "Must resolve the request.", judgeModel: "stub-judge" },
        online: { enabled: true, sampleRate: 1, alertThreshold: 5, severity: "medium" },
      })
    );
    expect(scorer.status).toBe(201);
    const wire = (scorer.body as { judgeScorer: { _id: string; online: { profileId: string } } }).judgeScorer;
    scorerId = wire._id;
    profileId = wire.online.profileId;

    const trace = await api(
      "/ingest/traces",
      postJson({ name: "loop-agent", input: "cancel my subscription", output: "Cannot help.", span_id: "loop-1" })
    );
    expect(trace.status).toBe(200);
    traceId = (trace.body as { trace_id: string }).trace_id;
    await new Promise(r => setTimeout(r, 1500));

    const signals = await api("/agent-monitoring/signals");
    const mine = ((signals.body as { signals: Array<{ patternKey: string }> }).signals ?? []).filter(
      s => s.patternKey === `online-eval:${profileId}`
    );
    expect(mine.length).toBe(1);

    const eventsRes = await api(`/agent-monitoring/online-evaluators/${profileId}/events?window=24h`);
    const events = (eventsRes.body as { events?: Array<{ rating: number }> }).events ?? [];
    expect(events.length).toBe(1);
    expect(events[0]!.rating).toBe(3);
  });
});

describe("a review label becomes calibration ground truth", () => {
  it("queues, carries the judge score, and surfaces the disagreement as source review", async () => {
    const queued = await api("/agent-monitoring/review-queue", postJson({ traceId, source: "manual" }));
    expect(queued.status).toBe(201);
    const itemId = (queued.body as { item: { _id: string } }).item._id;

    // Queue-time snapshot or lazy backfill - either way, by list time the pair is complete.
    const list = await api("/agent-monitoring/review-queue?status=pending");
    const item = ((list.body as { items: Array<{ _id: string; judgeScoreAtQueue: number | null }> }).items ?? []).find(
      i => i._id === itemId
    );
    expect(item?.judgeScoreAtQueue).toBe(3);

    const labeled = await api(
      `/agent-monitoring/review-queue/${itemId}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "good", correctedScore: 9, note: "the refusal was correct policy" }) }
    );
    expect(labeled.status).toBe(200);

    const calibration = await api(`/agent-monitoring/online-evaluators/${profileId}/calibration?window=7d`);
    expect(calibration.status).toBe(200);
    const body = calibration.body as {
      withGroundTruth: number;
      overFlagged: number;
      agreements: number;
      disagreementCases: Array<{ groundTruth: { source: string; isBad: boolean } }>;
    };
    // Judge said bad (3 < 5); the human review said good: one over-flag, sourced from review.
    expect(body.withGroundTruth).toBe(1);
    expect(body.overFlagged).toBe(1);
    expect(body.agreements).toBe(0);
    expect(body.disagreementCases[0]!.groundTruth.source).toBe("review");
    expect(body.disagreementCases[0]!.groundTruth.isBad).toBe(false);
  });
});

describe("provenance-gated publish", () => {
  it("refuses an unvalidated publish, refuses a regression, force-publishes with a stamp", async () => {
    const criteria = {
      acceptanceCriteria: "Concrete resolution with specifics.",
      rejectionCriteria: "Brush-offs.",
      evaluationCriteria: "Did the agent actually resolve the request?",
    };

    const bare = await api(`/agent-monitoring/online-evaluators/${profileId}/tune/publish`, postJson(criteria));
    expect(bare.status).toBe(409);

    const regressed = await api(
      `/agent-monitoring/online-evaluators/${profileId}/tune/publish`,
      postJson({ ...criteria, validation: { verdict: "regressed", netAgreementGain: -2 } })
    );
    expect(regressed.status).toBe(409);

    const forced = await api(
      `/agent-monitoring/online-evaluators/${profileId}/tune/publish`,
      postJson({ ...criteria, force: true })
    );
    expect(forced.status).toBe(200);

    const versions = await api(`/evaluate/evaluationSettings/${scorerId}/versions`);
    expect(versions.status).toBe(200);
    const summaries = (versions.body as Array<{ changeSummary?: string }>).map(v => v.changeSummary ?? "");
    expect(summaries.some(s => s.includes("[judge tuning: published without validation]"))).toBe(true);
  });

  it("accepts a validated improvement and stamps the measured gain", async () => {
    const ok = await api(
      `/agent-monitoring/online-evaluators/${profileId}/tune/publish`,
      postJson({
        acceptanceCriteria: "Concrete resolution with specifics, v2.",
        rejectionCriteria: "Brush-offs.",
        evaluationCriteria: "Did the agent actually resolve the request?",
        validation: { verdict: "improved", netAgreementGain: 3 },
      })
    );
    expect(ok.status).toBe(200);
    const versions = await api(`/evaluate/evaluationSettings/${scorerId}/versions`);
    const summaries = (versions.body as Array<{ changeSummary?: string }>).map(v => v.changeSummary ?? "");
    expect(summaries.some(s => s.includes("validated improved") && s.includes("+3"))).toBe(true);
  });
});
