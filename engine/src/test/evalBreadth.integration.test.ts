import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// P2 breadth: dataset splits recorded on runs, per-case repetition variance on the run wire,
// dataset delete (with twin + version history), and export round-trip via /datasets/import.
// Uses the same stub-judge trick as judgeLoop.integration.test.ts where ratings are needed.

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;
let stubCalls = 0;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      stubCalls++;
      // Alternates 3, 9, 3, 9... so repetitions of the same case get a real spread.
      const rating = stubCalls % 2 === 1 ? 3 : 9;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify({ rating, justification: `stub verdict ${rating}` }),
          usage: { input_tokens: 5, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "eval-breadth" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-b",
      provider: "custom",
      label: "Stub judge B",
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

describe("splits", () => {
  it("stores the split on the run's subject", async () => {
    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({
        name: "split-dataset",
        questions: [
          { main_question: { query: "q0", splits: ["smoke"] } },
          { main_question: { query: "q1" } },
          { main_question: { query: "q2", splits: ["smoke", "full"] } },
        ],
      })
    );
    expect(dataset.status).toBe(201);
    const datasetId = (dataset.body as { _id: string })._id;

    const run = await api("/custom-agent-evaluations/runs", postJson({ datasetId, split: "smoke" }));
    expect(run.status).toBe(201);
    const runId = (run.body as { runId: string }).runId;

    const fetched = await api(`/custom-agent-evaluations/runs/${runId}`);
    const subject = (fetched.body as { evaluationSubject?: { split?: string } }).evaluationSubject;
    expect(subject?.split).toBe("smoke");
  });
});

describe("per-case repetition variance", () => {
  it("surfaces min/max/variance for a case that ran twice", async () => {
    // A judge scorer with the stub model - the run grades through it.
    const scorer = await api(
      "/agent-monitoring/judge-scorers",
      postJson({ name: "breadth-judge", judge: { evaluationCriteria: "Anything.", judgeModel: "stub-judge-b" } })
    );
    expect(scorer.status).toBe(201);
    const scorerId = (scorer.body as { judgeScorer: { _id: string } }).judgeScorer._id;

    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({ name: "variance-dataset", questions: [{ main_question: { query: "flaky?" } }] })
    );
    const datasetId = (dataset.body as { _id: string })._id;
    const run = await api(
      "/custom-agent-evaluations/runs",
      postJson({ datasetId, evaluationSettingsId: scorerId })
    );
    const runId = (run.body as { runId: string }).runId;

    for (const runNumber of [1, 2]) {
      const res = await api(
        `/custom-agent-evaluations/runs/${runId}/results`,
        postJson({
          batchId: `b-${runNumber}`,
          results: [
            {
              idempotencyKey: `case-0-run-${runNumber}`,
              questionIndex: 0,
              runNumber,
              input: { query: "flaky?" },
              output: { text: `answer ${runNumber}` },
            },
          ],
        })
      );
      expect(res.status).toBe(200);
    }

    const fetched = await api(`/custom-agent-evaluations/runs/${runId}`);
    const stats = (fetched.body as { caseStatistics: Array<Record<string, number>> }).caseStatistics;
    expect(stats.length).toBe(1);
    expect(stats[0]!.questionIndex).toBe(0);
    expect(stats[0]!.ratedCount).toBe(2);
    expect(stats[0]!.minRating).toBe(3);
    expect(stats[0]!.maxRating).toBe(9);
    expect(stats[0]!.ratingVariance).toBe(9);
  });
});

describe("dataset delete and import", () => {
  it("deletes the dataset, its twin config, and version history; keeps nothing dangling", async () => {
    const created = await api(
      "/evaluate/evaluationSettings/create",
      postJson({ name: "twin-to-delete", questions: [{ main_question: { query: "hello" } }] })
    );
    expect(created.status).toBe(201);
    const id = (created.body as { _id: string })._id;

    const del = await api(`/evaluate/datasets/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const gone = await api(`/custom-agent-evaluations/datasets/${id}`);
    expect(gone.status).toBe(404);
    const versions = await api(`/evaluate/evaluationSettings/${id}/versions`);
    expect(versions.body).toEqual([]);

    const again = await api(`/evaluate/datasets/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("imports an exported dataset as a fresh copy", async () => {
    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({
        name: "exportable",
        evaluationCriteria: "Be right.",
        questions: [{ main_question: { query: "round trip?", expectedResults: "yes" } }],
      })
    );
    const original = dataset.body as { _id: string; name: string };

    const fetched = await api(`/custom-agent-evaluations/datasets/${original._id}`);
    const wire = fetched.body as Record<string, unknown>;

    const imported = await api("/evaluate/datasets/import", postJson({ dataset: wire }));
    expect(imported.status).toBe(201);
    const copy = imported.body as { _id: string; name: string; questions: unknown[] };
    expect(copy._id).not.toBe(original._id);
    expect(copy.name).toBe("exportable");
    expect(copy.questions).toHaveLength(1);

    const badImport = await api("/evaluate/datasets/import", postJson({ dataset: { name: "" } }));
    expect(badImport.status).toBe(400);
  });
});
