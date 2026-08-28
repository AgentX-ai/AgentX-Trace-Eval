import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Confirming a judge-raised signal is the AGREEMENT half of judge calibration: before this,
// only disagreements (wrong-judgement corrections, outcomes, review labels) were recorded, so a
// judge could only ever accumulate evidence against itself and its agreement rate was censored.
// "Confirm" (PATCH status -> triaged, signals.ts) now writes a metric:"confirmed" feedback row
// pinned to the newest occurrence's event, and judgeTuning counts it as event-level ground
// truth: isBad true -> agreement when the judge flagged.

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

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
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "confirm-agreement" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-c",
      provider: "custom",
      label: "Stub judge C",
      baseUrl: stubUrl,
      pricePerMInputTokens: 0,
      pricePerMOutputTokens: 0,
    })
  );
  expect(model.status).toBe(201);

  const scorer = await api(
    "/agent-monitoring/judge-scorers",
    postJson({
      name: "confirm-judge",
      judge: { evaluationCriteria: "Anything.", judgeModel: "stub-judge-c" },
      online: { enabled: true, sampleRate: 1, alertThreshold: 5 },
    })
  );
  expect(scorer.status).toBe(201);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
  await new Promise<void>(resolve => judgeStub.close(() => resolve()));
});

describe("Confirm records judge agreement", () => {
  it("confirming a judge signal raises the evaluator's agreement count", async () => {
    await api("/ingest/traces", postJson({ name: "confirm-agent", input: "q", output: "bad answer", span_id: "c-1" }));
    await new Promise(r => setTimeout(r, 2000));

    const signals = await api("/agent-monitoring/signals?polarity=all");
    const signal = ((signals.body as { signals: Array<{ _id: string; patternKey?: string; summary: string }> }).signals ?? []).find(
      s => s.summary.includes("confirm-judge")
    );
    expect(signal, JSON.stringify(signals.body).slice(0, 400)).toBeTruthy();

    const evaluators = await api("/agent-monitoring/online-evaluators");
    const evaluator = ((evaluators.body as { evaluators: Array<{ _id: string; name: string }> }).evaluators ?? []).find(
      e => e.name === "confirm-judge"
    )!;
    const before = (await api(`/agent-monitoring/online-evaluators/${evaluator._id}/calibration?window=24h`))
      .body as { agreements: number; withGroundTruth: number };

    const confirm = await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "triaged", reviewStatus: "reviewed" }),
    });
    expect(confirm.status).toBe(200);

    const after = (await api(`/agent-monitoring/online-evaluators/${evaluator._id}/calibration?window=24h`))
      .body as { agreements: number; withGroundTruth: number };
    expect(after.withGroundTruth).toBe(before.withGroundTruth + 1);
    expect(after.agreements).toBe(before.agreements + 1);

    // Confirming again (e.g. re-triage from the table) must not double-count: the write only
    // happens on the transition INTO triaged.
    await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "triaged" }),
    });
    const again = (await api(`/agent-monitoring/online-evaluators/${evaluator._id}/calibration?window=24h`))
      .body as { withGroundTruth: number };
    expect(again.withGroundTruth).toBe(after.withGroundTruth);

    // Wrong judgement (resolved/false_positive) writes the DISAGREEMENT baseline engine-side,
    // and an explicit correction outranks the earlier confirm on the same event: same event
    // count, but the verdict flips from agreement to over-flagged.
    const resolve = await api(`/agent-monitoring/signals/${signal!._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", resolutionReason: "false_positive" }),
    });
    expect(resolve.status).toBe(200);
    const flipped = (await api(`/agent-monitoring/online-evaluators/${evaluator._id}/calibration?window=24h`))
      .body as { agreements: number; overFlagged: number; withGroundTruth: number };
    expect(flipped.withGroundTruth).toBe(after.withGroundTruth);
    expect(flipped.agreements).toBe(after.agreements - 1);
    expect(flipped.overFlagged).toBe(1);
  });
});
