import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Regression: batch result submission is scored synchronously inside the request, so a client
// whose HTTP timeout is shorter than scoring re-POSTs the same batch WHILE the first request is
// still inserting. The engine's duplicate handling was check-then-insert - the racing loser hit
// the (run_id, idempotency_key) UNIQUE constraint and the whole batch failed with a raw SQLite
// error instead of being deduped (hit live by selfhost_demo/03 on 2026-08-27). The insert is
// conflict-tolerant now: every concurrent submission of the same batch succeeds, rows are
// written exactly once, and losers are reported as duplicates.

let engine: TestEngine;
let key: string;
let runId: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "results-idempotency" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  const dataset = await api(
    "/custom-agent-evaluations/datasets",
    postJson({
      name: "idempotency-set",
      questions: [
        { main_question: { question: "q1", expectedResults: "a1" } },
        { main_question: { question: "q2", expectedResults: "a2" } },
      ],
    })
  );
  expect(dataset.status).toBe(201);
  const datasetId = (dataset.body as { _id?: string; id?: string })._id ?? (dataset.body as { id: string }).id;

  const run = await api("/custom-agent-evaluations/runs", postJson({ datasetId, runSource: "sdk" }));
  expect(run.status).toBe(201);
  runId = (run.body as { runId: string }).runId;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const batch = (batchId: string) => ({
  batchId,
  results: [
    { idempotencyKey: "case-0-run-1", questionIndex: 0, runNumber: 1, input: "q1", output: { text: "a1" } },
    { idempotencyKey: "case-1-run-1", questionIndex: 1, runNumber: 1, input: "q2", output: { text: "a2" } },
  ],
});

describe("concurrent duplicate batch submission", () => {
  it("both submissions succeed, rows land exactly once, losers count as duplicates", async () => {
    // The exact shape of the timeout-retry race: the same results (same idempotency keys, fresh
    // batch ids - the client mints a new uuid per attempt) in flight simultaneously.
    const [first, second] = await Promise.all([
      api(`/custom-agent-evaluations/runs/${runId}/results`, postJson(batch("batch-a"))),
      api(`/custom-agent-evaluations/runs/${runId}/results`, postJson(batch("batch-b"))),
    ]);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const a = first.body as { accepted: number; duplicates: number };
    const b = second.body as { accepted: number; duplicates: number };
    // Between the two racing requests every result is accepted exactly once - however the race
    // interleaved - and the rest are reported back as duplicates, never as errors.
    expect(a.accepted + b.accepted).toBe(2);
    expect(a.duplicates + b.duplicates).toBe(2);

    // A later straight retry (first request long finished) is the classic dedupe path.
    const third = await api(`/custom-agent-evaluations/runs/${runId}/results`, postJson(batch("batch-c")));
    expect(third.status).toBe(200);
    expect((third.body as { accepted: number }).accepted).toBe(0);
    expect((third.body as { duplicates: number }).duplicates).toBe(2);

    const submitted = await api(`/custom-agent-evaluations/runs/${runId}/missing-results`);
    expect(submitted.status).toBe(200);
    const keys = (submitted.body as { submittedKeys: string[] }).submittedKeys;
    expect(keys.sort()).toEqual(["case-0-run-1", "case-1-run-1"]);
  });
});
