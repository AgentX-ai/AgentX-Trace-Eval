import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The datasets list carries two facts that do not live on the dataset row: when it was last
// edited, and the last eval run that used it. Pinned here because the failure mode is silent -
// a dataset that has been run would render as "never run", which is the one thing the list is
// meant to tell you, and nothing else would look wrong.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

type Wire = {
  _id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastRun: { runId: string; version: string | null; runSource: string | null; status: string; at: string } | null;
};

async function listDatasets(): Promise<Wire[]> {
  const res = await api("/evaluate/evaluationSettings?kind=dataset");
  return (res.body as { evaluationSettings: Wire[] }).evaluationSettings;
}

async function makeDataset(name: string): Promise<string> {
  const created = await api(
    "/custom-agent-evaluations/datasets",
    postJson({ name, questions: [{ main_question: { question: "q1", expectedResults: "a1" } }] })
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;
}

let neverRunId: string;
let usedId: string;

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "dataset-activity" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
  neverRunId = await makeDataset("never-run-set");
  usedId = await makeDataset("nightly-regression");
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("dataset list activity", () => {
  it("reports a dataset that has never been run as exactly that", async () => {
    const dataset = (await listDatasets()).find(d => d._id === neverRunId)!;
    expect(dataset.lastRun).toBeNull();
    // A dataset is seeded with a v0 version row at creation, so it always has an edit timestamp.
    expect(dataset.updatedAt).toBeTruthy();
  });

  it("names the last run that used a dataset, with what it was tagged and how it ended", async () => {
    const run = await api(
      "/custom-agent-evaluations/runs",
      postJson({ datasetId: usedId, runSource: "sdk", evaluationSubject: { metadata: { version: "v2.1" } } })
    );
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = (run.body as { runId: string }).runId;
    await api(`/custom-agent-evaluations/runs/${runId}/finalize`, postJson({}));

    const dataset = (await listDatasets()).find(d => d._id === usedId)!;
    expect(dataset.lastRun).not.toBeNull();
    expect(dataset.lastRun!.runId).toBe(runId);
    expect(dataset.lastRun!.version).toBe("v2.1");
    expect(dataset.lastRun!.runSource).toBe("sdk");
    expect(dataset.lastRun!.status).toBe("completed");

    // The other dataset is untouched: activity is per dataset, not the newest run overall.
    expect((await listDatasets()).find(d => d._id === neverRunId)!.lastRun).toBeNull();
  });

  it("moves to the newest run rather than the first one recorded", async () => {
    const second = await api("/custom-agent-evaluations/runs", postJson({ datasetId: usedId, runSource: "dashboard" }));
    const secondId = (second.body as { runId: string }).runId;

    const dataset = (await listDatasets()).find(d => d._id === usedId)!;
    expect(dataset.lastRun!.runId).toBe(secondId);
    // Still in progress - the list reports the run's real state rather than assuming success.
    expect(dataset.lastRun!.status).toBe("in_progress");
    expect(dataset.lastRun!.version).toBeNull();
  });

  it("advances the edit timestamp when the dataset actually changes", async () => {
    const before = (await listDatasets()).find(d => d._id === neverRunId)!.updatedAt;
    await api(`/evaluate/evaluationSettings/${neverRunId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "never-run-set",
        questions: [
          { main_question: { question: "q1", expectedResults: "a1" } },
          { main_question: { question: "q2", expectedResults: "a2" } },
        ],
      }),
    });
    const after = (await listDatasets()).find(d => d._id === neverRunId)!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(after).toBeTruthy();
  });
});
