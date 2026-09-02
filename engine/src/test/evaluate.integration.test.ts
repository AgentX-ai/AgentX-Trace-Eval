import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGateResultSchema } from "../contract/wire.js";
import { startEngine, type TestEngine } from "./server.js";

// The SDK-facing eval loop: create a dataset, open a run, stream result batches in, finalize, then
// ask the CI gate whether the run passes. No LLM key is configured here, so judge scoring is
// unavailable - the interesting question is whether the whole loop still completes and the
// key-free similarity metrics still produce numbers, rather than erroring somewhere in the middle.

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

const dataset = {
  name: "returns-policy",
  description: "Support answers about returns",
  jaccardSimilarity: { enabled: true },
  bleuScore: { enabled: true },
  rougeScore: { enabled: true },
  questions: [
    { main_question: { question: "How long do I have to return an item?", expectedResults: "30 days from delivery." } },
    { main_question: { question: "Do I need the receipt?", expectedResults: "Yes, proof of purchase is required." } },
  ],
};

describe("evaluation run loop", () => {
  let datasetId: string;
  let runId: string;

  it("creates a dataset", async () => {
    const created = await engine.json("/api/v1/custom-agent-evaluations/datasets", post(dataset));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    datasetId = (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;
    expect(datasetId).toBeTruthy();

    const listed = await engine.json("/api/v1/custom-agent-evaluations/datasets");
    expect(JSON.stringify(listed.body)).toContain("returns-policy");
  });

  it("rejects a dataset with no name", async () => {
    const created = await engine.json("/api/v1/custom-agent-evaluations/datasets", post({ description: "nameless" }));
    expect(created.status).toBe(400);
  });

  it("opens a run against the dataset", async () => {
    const created = await engine.json("/api/v1/custom-agent-evaluations/runs", post({ datasetId, runSource: "sdk" }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    runId = (created.body as { runId: string }).runId;
    expect(runId).toBeTruthy();
  });

  it("404s a run against an unknown dataset", async () => {
    const created = await engine.json("/api/v1/custom-agent-evaluations/runs", post({ datasetId: "no-such-dataset" }));
    expect(created.status).toBe(404);
  });

  it("accepts a batch of results and scores the key-free similarity metrics", async () => {
    const submitted = await engine.json(
      `/api/v1/custom-agent-evaluations/runs/${runId}/results`,
      post({
        batchId: "batch-1",
        results: [
          {
            idempotencyKey: "case-0-run-1",
            questionIndex: 0,
            runNumber: 1,
            input: { query: dataset.questions[0]!.main_question.question },
            output: { text: "You have 30 days from delivery to return an item." },
            timings: { latencyMs: 900, inputTokens: 40, outputTokens: 20 },
          },
          {
            idempotencyKey: "case-1-run-1",
            questionIndex: 1,
            runNumber: 1,
            input: { query: dataset.questions[1]!.main_question.question },
            output: { text: "Bring a banana." },
            timings: { latencyMs: 700 },
          },
        ],
      })
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const body = submitted.body as { accepted?: number; liveStatistics?: unknown };
    expect(body.accepted).toBe(2);
    expect(body.liveStatistics).toBeTruthy();
  });

  it("treats a replayed batch as duplicates rather than double-counting", async () => {
    const replay = await engine.json(
      `/api/v1/custom-agent-evaluations/runs/${runId}/results`,
      post({
        batchId: "batch-1",
        results: [
          {
            idempotencyKey: "case-0-run-1",
            questionIndex: 0,
            runNumber: 1,
            output: { text: "You have 30 days from delivery to return an item." },
          },
        ],
      })
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { duplicates?: number }).duplicates).toBe(1);
  });

  it("rejects an empty or oversized batch", async () => {
    expect((await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/results`, post({ batchId: "b", results: [] }))).status).toBe(400);
    expect((await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/results`, post({ results: [{}] }))).status).toBe(400);
  });

  it("404s results submitted to an unknown run", async () => {
    const res = await engine.json(
      "/api/v1/custom-agent-evaluations/runs/no-such-run/results",
      post({ batchId: "b", results: [{ idempotencyKey: "k", output: { text: "x" } }] })
    );
    expect(res.status).toBe(404);
  });

  it("scores the key-free similarity metrics per result, and they track answer quality", async () => {
    // The dashboard's run detail is what embeds the per-result rows; the SDK-facing run endpoint
    // deliberately returns only the summary.
    const run = await engine.json(`/api/v1/evaluate/${runId}`);
    expect(run.status, JSON.stringify(run.body).slice(0, 300)).toBe(200);

    const results = (run.body as { results?: { questionIndex?: number; jaccardSimilarity?: number; rougeScore?: number }[] })
      .results ?? [];
    expect(results.length).toBe(2);

    const good = results.find(r => r.questionIndex === 0)!;
    const bad = results.find(r => r.questionIndex === 1)!;
    // "You have 30 days from delivery to return an item." vs "30 days from delivery." overlaps
    // heavily; "Bring a banana." vs "Yes, proof of purchase is required." does not.
    expect(good.jaccardSimilarity).toBeGreaterThan(0);
    expect(good.jaccardSimilarity!).toBeGreaterThan(bad.jaccardSimilarity ?? 0);
    expect(good.rougeScore!).toBeGreaterThan(bad.rougeScore ?? 0);
  });

  it("keeps the key-free scores even though the judge call had no API key to make", async () => {
    // This engine boots with no OPENAI_API_KEY, so every judge call fails. That failure belongs to
    // the judge alone - the similarity metrics need no key and must survive it, which is the whole
    // point of shipping them. Both facts are asserted together so a regression that silently
    // re-couples them (one Promise.all, one catch) can't pass by looking like "no key configured".
    const run = await engine.json(`/api/v1/evaluate/${runId}`);
    const results = (run.body as { results?: { rating?: number; justification?: string; jaccardSimilarity?: number }[] })
      .results ?? [];
    expect(results.length).toBe(2);
    for (const result of results) {
      expect(result.justification ?? "").toMatch(/API key/i);
      expect(result.jaccardSimilarity, "similarity was discarded along with the judge failure").toBeTypeOf("number");
    }
  });

  it("carries _id alongside runId, like every sibling resource", async () => {
    // datasets and evaluation-settings rows key on _id; runs historically keyed on runId
    // (which the Python SDK aliases, so it stays). Both must be present and equal, on the
    // single-run read and on every list row - a consumer iterating mixed resources reads
    // _id everywhere without special-casing runs.
    const one = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}`);
    expect(one.status).toBe(200);
    const single = one.body as { _id?: string; runId?: string };
    expect(single._id, "single run carries _id").toBe(runId);
    expect(single.runId, "runId stays for the SDK").toBe(runId);

    const list = await engine.json("/api/v1/custom-agent-evaluations/runs");
    expect(list.status).toBe(200);
    const rows = (list.body as { runs?: { _id?: string; runId?: string }[] }).runs ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row._id, "list row carries _id").toBeTypeOf("string");
      expect(row.runId, "list row keeps runId").toBe(row._id);
    }
  });

  it("finalizes the run", async () => {
    const finalized = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/finalize`, { method: "POST" });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect(JSON.stringify(finalized.body)).toContain("completed");
  });

  it("refuses further results once the run is terminal", async () => {
    const late = await engine.json(
      `/api/v1/custom-agent-evaluations/runs/${runId}/results`,
      post({ batchId: "late", results: [{ idempotencyKey: "late-1", output: { text: "x" } }] })
    );
    expect(late.status).toBe(409);
  });

  it("answers the CI gate and requires at least one check", async () => {
    expect((await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/gate`)).status).toBe(400);
    expect((await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/gate?failUnder=abc`)).status).toBe(400);

    const gate = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/gate?failUnder=5`);
    runGateResultSchema.parse(gate.body); // strict wire contract - drift fails here, not in an audit
    expect(gate.status, JSON.stringify(gate.body)).toBe(200);
    expect(gate.body).toHaveProperty("passed");

    expect((await engine.json("/api/v1/custom-agent-evaluations/runs/no-such-run/gate?failUnder=5")).status).toBe(404);
  });

  it("lists the run in the dashboard's evaluation list", async () => {
    const list = await engine.json("/api/v1/evaluate/list");
    expect(list.status).toBe(200);
    const runs = await engine.json("/api/v1/custom-agent-evaluations/runs");
    expect(JSON.stringify(runs.body)).toContain(runId);
  });

  // The SDK calls analyze_run / get_analysis_status / get_report on the
  // custom-agent-evaluations router. These lived only on /evaluate for a while, so the SDK's
  // calls 404'd - and because the SDK swallows analyze failures and falls back to an empty
  // report, the symptom was a run that looked like it had scored nothing rather than an error.
  // These assertions exist to keep the three paths mounted; the judging itself is covered
  // elsewhere and needs an API key this engine deliberately does not have.
  describe("the SDK's analysis endpoints", () => {
    it("serves analyze-status before anything has analyzed the run", async () => {
      const status = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/analyze-status`);
      expect(status.status, JSON.stringify(status.body)).toBe(200);
      expect(status.body).toMatchObject({ evaluationId: runId, status: "not_started" });
      // The SDK polls until is_terminal and reads progress.overallPercentage on the way.
      expect(status.body).toHaveProperty("progress.overallPercentage");
    });

    it("404s the report with a reason, not the router's generic miss", async () => {
      const report = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/report`);
      expect(report.status).toBe(404);
      // "Not found" is what an unmounted path returns. Distinguishing the two is the point:
      // one means "analyze first", the other means the route regressed.
      expect((report.body as { error?: string }).error).toMatch(/analyze/i);
    });

    it("404s analysis calls for a run that does not exist", async () => {
      const analyze = await engine.json(
        "/api/v1/custom-agent-evaluations/runs/no-such-run/analyze",
        post({ judges: [{ model: "gpt-5.5" }] })
      );
      expect(analyze.status).toBe(404);
      expect((analyze.body as { error?: string }).error).toMatch(/run not found/i);

      expect((await engine.json("/api/v1/custom-agent-evaluations/runs/no-such-run/report")).status).toBe(404);
    });

    it("reports the same analysis state as the dashboard router", async () => {
      // One implementation behind two routers: an analysis started from the SDK has to be the
      // row the Evaluate tab renders, or the two surfaces drift.
      const viaSdk = await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/analyze-status`);
      const viaDashboard = await engine.json(`/api/v1/evaluate/analyze/${runId}/status`);
      expect(viaSdk.body).toEqual(viaDashboard.body);
    });
  });
});

describe("curating production traffic into a dataset", () => {
  it("previews a dataset case from a real trace and adds it", async () => {
    const ingested = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "curation-agent", input: "do you ship to Spain?", output: "Yes, 3-5 business days." })
    );
    const traceId = (ingested.body as { trace_id: string }).trace_id;

    const preview = await engine.json("/api/v1/evaluate/datasets/case-preview", post({ traceId }));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(JSON.stringify(preview.body)).toContain("Spain");

    const created = await engine.json("/api/v1/custom-agent-evaluations/datasets", post({ name: "curated", questions: [] }));
    const curatedId = (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;

    // The preview is what the dialog shows the user; adding submits that same shape back.
    const added = await engine.json(
      `/api/v1/evaluate/datasets/${curatedId}/cases`,
      post({ case: (preview.body as { case: Record<string, unknown> }).case })
    );
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const dataset = await engine.json(`/api/v1/custom-agent-evaluations/datasets/${curatedId}`);
    expect(JSON.stringify(dataset.body)).toContain("Spain");
  });

  it("400s a case preview with neither a traceId nor a sessionId", async () => {
    expect((await engine.json("/api/v1/evaluate/datasets/case-preview", post({}))).status).toBe(400);
  });

  it("404s a case preview for a trace that does not exist", async () => {
    expect((await engine.json("/api/v1/evaluate/datasets/case-preview", post({ traceId: "nope" }))).status).toBe(404);
  });
});
