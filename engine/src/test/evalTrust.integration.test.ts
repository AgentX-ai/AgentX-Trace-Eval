import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Judge-failure trust semantics. A judge that cannot score (missing key, provider outage,
// unusable output) must never fabricate a verdict: offline the row is status "skipped" with
// rating null (and the free deterministic metrics still land), online no Signal is raised and
// no rating-0 event pollutes the charts. This suite runs the engine deliberately KEYLESS so
// every judge call fails, and pins what that failure looks like on the wire.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "eval-trust" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("offline: a failed judge is a skipped row, never a zero", () => {
  let datasetId: string;
  let runId: string;

  it("creates a dataset and a run", async () => {
    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({
        name: "trust-dataset",
        evaluationCriteria: "The answer must be correct.",
        questions: [{ main_question: { query: "What is the return window?", expectedResults: "30 days." } }],
      })
    );
    expect(dataset.status).toBe(201);
    datasetId = (dataset.body as { _id: string })._id;

    const run = await api("/custom-agent-evaluations/runs", postJson({ datasetId }));
    expect(run.status).toBe(201);
    runId = (run.body as { runId: string }).runId;
    expect(runId).toBeTruthy();
  });

  it("stores a judge-failed result as skipped with rating null, deterministic metrics intact", async () => {
    const res = await api(
      `/custom-agent-evaluations/runs/${runId}/results`,
      postJson({
        batchId: "b-1",
        results: [
          {
            idempotencyKey: "case-0-run-1",
            questionIndex: 0,
            runNumber: 1,
            input: { query: "What is the return window?" },
            output: { text: "You have 30 days." },
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      accepted: number;
      scoredResults: Array<{ rating: number | null; status: string; justification: string | null }>;
      liveStatistics: { ratedCount: number; skippedCount: number; failedCount: number; averageRating: number | null };
    };
    expect(body.accepted).toBe(1);
    // The judge could not run (no key). That is a FACT about the judge, not a 0/10 verdict on
    // the agent - the old behavior averaged a fabricated zero into the run and its CI gate.
    expect(body.scoredResults[0]!.rating).toBeNull();
    expect(body.scoredResults[0]!.status).toBe("skipped");
    expect(body.scoredResults[0]!.justification).toMatch(/API key/i);
    expect(body.liveStatistics.ratedCount).toBe(0);
    expect(body.liveStatistics.averageRating).toBeNull();
    expect(body.liveStatistics.skippedCount).toBe(1);
    expect(body.liveStatistics.failedCount).toBe(0);
  });

  it("a duplicate submission returns the full stored verdict, marked deduped", async () => {
    const res = await api(
      `/custom-agent-evaluations/runs/${runId}/results`,
      postJson({
        batchId: "b-2",
        results: [
          {
            idempotencyKey: "case-0-run-1",
            questionIndex: 0,
            runNumber: 1,
            input: { query: "What is the return window?" },
            output: { text: "You have 30 days." },
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      duplicates: number;
      scoredResults: Array<{ status: string; deduped?: boolean; rating: number | null }>;
    };
    expect(body.duplicates).toBe(1);
    expect(body.scoredResults[0]!.deduped).toBe(true);
    // The dedupe path used to drop everything but rating/justification; now it round-trips the
    // stored row's status (and scorer fields) so a retrying client sees the same payload.
    expect(body.scoredResults[0]!.status).toBe("skipped");
    expect(body.scoredResults[0]!.rating).toBeNull();
  });

  it("exposes submitted idempotency keys for resume", async () => {
    const res = await api(`/custom-agent-evaluations/runs/${runId}/missing-results`);
    expect(res.status).toBe(200);
    const body = res.body as { submittedKeys: string[]; submittedCount: number; missing: unknown[] };
    expect(body.submittedKeys).toContain("case-0-run-1");
    expect(body.submittedCount).toBe(1);
    expect(body.missing).toEqual([]);
  });

  it("per-row status and skipped counts survive into the run resource", async () => {
    await api(`/custom-agent-evaluations/runs/${runId}/finalize`, postJson({}));
    const res = await api(`/custom-agent-evaluations/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      liveStatistics: { skippedCount: number };
      results: Array<{ status: string; rating: number | null }>;
    };
    expect(body.status).toBe("completed");
    expect(body.liveStatistics.skippedCount).toBe(1);
    expect(body.results[0]!.status).toBe("skipped");
    expect(body.results[0]!.rating).toBeNull();
  });

  it("gate preview validates its new tolerance parameter", async () => {
    const bad = await api(`/evaluate/ci/gates/preview?datasetId=${datasetId}&failUnder=7&tolerance=-1`);
    expect(bad.status).toBe(400);
    const ok = await api(`/evaluate/ci/gates/preview?datasetId=${datasetId}&failUnder=7&tolerance=0.2`);
    // The run exists and is completed (all rows skipped), so the gate computes - and fails the
    // floor check because nothing was rated. What matters here: tolerance is accepted.
    expect([200, 422]).toContain(ok.status);
  });
});

describe("online: a failed judge raises no Signal and records no rating", () => {
  it("keyless live scoring produces zero signals and zero ratings", async () => {
    // A live scorer with full sampling and a threshold that would fire on any rating < 5.
    const scorer = await api(
      "/agent-monitoring/judge-scorers",
      postJson({
        name: "trust-live-judge",
        judge: { evaluationCriteria: "Must actually resolve the request." },
        online: { enabled: true, sampleRate: 1, alertThreshold: 5, severity: "medium" },
      })
    );
    expect(scorer.status).toBe(201);
    const profileId = (scorer.body as { judgeScorer: { online: { profileId: string } } }).judgeScorer.online.profileId;

    const trace = await api(
      "/ingest/traces",
      postJson({ name: "live-agent", input: "help me", output: "no.", span_id: "t-live-1" })
    );
    expect(trace.status).toBe(200);
    // Online judging is fire-and-forget after the 200; give it a beat to run and fail.
    await new Promise(r => setTimeout(r, 1500));

    // Old behavior: the judge failure surfaced as rating 0 -> below threshold -> a REAL Signal.
    const signals = await api("/agent-monitoring/signals");
    const signalList = (signals.body as { signals: Array<{ patternKey: string }> }).signals ?? [];
    expect(signalList.filter(s => s.patternKey === `online-eval:${profileId}`)).toEqual([]);

    // And no rating-0 event polluting the ratings chart: the failure event carries rating null,
    // which every ratings/calibration read filters out.
    const ratings = await api(`/agent-monitoring/online-evaluators/${profileId}/ratings?window=24h`);
    expect(ratings.status).toBe(200);
    const ratingsBody = ratings.body as { events?: Array<{ rating: number | null }>; averageRating?: number | null };
    expect((ratingsBody.events ?? []).length).toBe(0);
  });
});
