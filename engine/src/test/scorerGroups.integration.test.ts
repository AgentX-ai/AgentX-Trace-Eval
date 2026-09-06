import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Scorer groups: scorers of any kind composed into one 0-10 score (weights + must-pass gates).
// Covered here: CRUD, grading a dataset run (group aggregate in the rating column, member
// verdicts per row), gate semantics, and live traffic (group event + below-threshold Signal).

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  // Marker-keyed judge stub, same trick as multiJudge.integration.test.ts: the rubric embedded
  // marker picks the rating, so every judge verdict is deterministic.
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const rating = raw.includes("HARSHMARK") ? 2 : 8;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_stub",
          output_text: JSON.stringify({ rating, justification: `stub rated ${rating}` }),
          usage: { input_tokens: 5, output_tokens: 5 },
        })
      );
    });
  });
  await new Promise<void>(resolve => judgeStub.listen(0, "127.0.0.1", resolve));
  const address = judgeStub.address();
  stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "scorer-groups" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
  const model = await api(
    "/agent-monitoring/portability/models",
    postJson({
      id: "stub-judge-g",
      provider: "custom",
      label: "Stub judge G",
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

async function makeJudge(name: string, marker: string): Promise<string> {
  const res = await api(
    "/agent-monitoring/judge-scorers",
    postJson({ name, judge: { evaluationCriteria: `Judge with ${marker}.`, judgeModel: "stub-judge-g" } })
  );
  expect(res.status).toBe(201);
  return (res.body as { judgeScorer: { _id: string } }).judgeScorer._id;
}

async function makePattern(name: string, phrase: string): Promise<string> {
  const res = await api(
    "/agent-monitoring/patterns",
    postJson({
      name,
      description: name,
      severity: "medium",
      polarity: "failure",
      conditions: [{ detector: "contains", value: phrase, sources: ["response"] }],
    })
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { pattern: { _id: string } }).pattern._id;
}

describe("scorer groups", () => {
  it("CRUD round-trips members and the online profile", async () => {
    const created = await api(
      "/agent-monitoring/scorer-groups",
      postJson({
        name: "Quality bar",
        members: [{ kind: "judge", refId: "j1", weight: 2, gate: false }],
        online: { enabled: false, sampleRate: 0.5, alertThreshold: 6, severity: "high" },
      })
    );
    expect(created.status).toBe(201);
    const id = (created.body as { scorerGroup: { _id: string } }).scorerGroup._id;

    const fetched = await api(`/agent-monitoring/scorer-groups/${id}`);
    const wire = (fetched.body as { scorerGroup: Record<string, unknown> }).scorerGroup;
    expect(wire.members).toEqual([{ kind: "judge", refId: "j1", weight: 2, gate: false }]);
    expect(wire.online).toEqual({ enabled: false, sampleRate: 0.5, alertThreshold: 6, severity: "high" });

    const updated = await api(`/agent-monitoring/scorer-groups/${id}`, {
      ...postJson({ name: "Quality bar v2" }),
      method: "PUT",
    });
    expect((updated.body as { scorerGroup: { name: string } }).scorerGroup.name).toBe("Quality bar v2");

    expect((await api(`/agent-monitoring/scorer-groups/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/agent-monitoring/scorer-groups/${id}`)).status).toBe(404);
  });

  it("grades a dataset run: weighted blend in the rating column, member verdicts per row", async () => {
    const kindId = await makeJudge("Kind judge", "KINDMARK"); // stub rates 8
    const harshId = await makeJudge("Harsh judge", "HARSHMARK"); // stub rates 2
    const patternId = await makePattern("Says sorry", "sorry");

    const group = await api(
      "/agent-monitoring/scorer-groups",
      postJson({
        name: "Blend group",
        members: [
          { kind: "judge", refId: kindId, weight: 1 },
          { kind: "judge", refId: harshId, weight: 1 },
          { kind: "pattern", refId: patternId, weight: 1 },
        ],
      })
    );
    const groupId = (group.body as { scorerGroup: { _id: string } }).scorerGroup._id;

    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({ name: "group-ds", questions: [{ main_question: { query: "hi?", expectedResults: "hello" } }] })
    );
    const datasetId = (dataset.body as { _id: string })._id;

    const run = await api(
      "/custom-agent-evaluations/runs",
      postJson({ datasetId, scorerGroupId: groupId, runSource: "sdk" })
    );
    expect(run.status).toBe(201);
    const runId = (run.body as { runId: string }).runId;

    // Output contains no "sorry", so the failure pattern does NOT match: goodness 1.
    // Blend: (0.8 + 0.2 + 1.0) / 3 = 2/3 -> 6.7 on the 0-10 scale.
    const appended = await api(
      `/custom-agent-evaluations/runs/${runId}/results`,
      postJson({
        batchId: "b1",
        results: [{ idempotencyKey: "r1", questionIndex: 0, input: { query: "hi?" }, output: { text: "hello there" } }],
      })
    );
    const scored = (
      appended.body as {
        scoredResults: Array<{
          rating: number | null;
          justification: string | null;
          judgeScorerResults: Array<{ name: string; rating: number | null }> | null;
          codeScorerResults: Array<{ name: string; score: number | null }> | null;
        }>;
      }
    ).scoredResults[0]!;
    expect(scored.rating).toBeCloseTo(6.7, 5);
    const judges = Object.fromEntries((scored.judgeScorerResults ?? []).map(v => [v.name, v.rating]));
    expect(judges).toEqual({ "Kind judge": 8, "Harsh judge": 2 });
    const patternRow = (scored.codeScorerResults ?? []).find(r => r.name === "Says sorry");
    expect(patternRow?.score).toBe(1);

    await api(`/custom-agent-evaluations/runs/${runId}/finalize`, { method: "POST" });
    const detail = (await api(`/custom-agent-evaluations/runs/${runId}`)).body as {
      scorerGroupId: string | null;
      scorerBreakdown: Array<{ name: string; primary: boolean }>;
    };
    expect(detail.scorerGroupId).toBe(groupId);
    expect(detail.scorerBreakdown[0]).toMatchObject({ name: "Blend group (group)", primary: true });
  });

  it("a must-pass gate zeroes the group score when its member fails", async () => {
    const kindId = await makeJudge("Kind judge 2", "KINDMARK");
    const patternId = await makePattern("No apologies", "sorry");
    const group = await api(
      "/agent-monitoring/scorer-groups",
      postJson({
        name: "Gated group",
        members: [
          { kind: "judge", refId: kindId, weight: 1 },
          { kind: "pattern", refId: patternId, weight: 0, gate: true },
        ],
      })
    );
    const groupId = (group.body as { scorerGroup: { _id: string } }).scorerGroup._id;

    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({ name: "gate-ds", questions: [{ main_question: { query: "q", expectedResults: "a" } }] })
    );
    const run = await api(
      "/custom-agent-evaluations/runs",
      postJson({ datasetId: (dataset.body as { _id: string })._id, scorerGroupId: groupId, runSource: "sdk" })
    );
    const runId = (run.body as { runId: string }).runId;

    // "sorry" matches the failure pattern -> gated member fails -> group score 0 despite the 8/10 judge.
    const appended = await api(
      `/custom-agent-evaluations/runs/${runId}/results`,
      postJson({
        batchId: "b1",
        results: [{ idempotencyKey: "r1", questionIndex: 0, input: { query: "q" }, output: { text: "sorry, no" } }],
      })
    );
    const scored = (appended.body as { scoredResults: Array<{ rating: number | null; justification: string | null }> })
      .scoredResults[0]!;
    expect(scored.rating).toBe(0);
    expect(scored.justification).toContain("Gated to 0");
  });

  it("scores live traffic and raises a Signal below the group threshold", async () => {
    const harshId = await makeJudge("Live harsh", "HARSHMARK"); // rates 2
    const group = await api(
      "/agent-monitoring/scorer-groups",
      postJson({
        name: "Live group",
        members: [{ kind: "judge", refId: harshId, weight: 1 }],
        online: { enabled: true, sampleRate: 1, alertThreshold: 5, severity: "high" },
      })
    );
    const groupId = (group.body as { scorerGroup: { _id: string } }).scorerGroup._id;

    const ingested = await api(
      "/ingest/traces",
      postJson({ name: "live-agent", span_id: "sg-live-1", input: "help me", output: "some mediocre answer" })
    );
    expect(ingested.status).toBe(200);

    // Fire-and-forget scoring: poll for the group event.
    let signals: Array<{ patternKey?: string; summary?: string }> = [];
    for (let i = 0; i < 40; i++) {
      const res = await api("/agent-monitoring/signals");
      signals = ((res.body as { signals?: Array<{ patternKey?: string; summary?: string }> }).signals ?? []).filter(
        s => s.patternKey === `scorer-group:${groupId}`
      );
      if (signals.length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(signals.length, "expected a scorer-group low-score signal").toBeGreaterThan(0);
    expect(signals[0]!.summary).toContain('Scorer group "Live group" scored this response 2.0/10');

    // The score history endpoint has the verdict bucketed for the chart...
    const ratings = (await api(`/agent-monitoring/scorer-groups/${groupId}/ratings?window=24h`)).body as {
      points: Array<{ count: number; averageRating: number | null }>;
    };
    const rated = ratings.points.filter(p => p.count > 0);
    expect(rated.length).toBeGreaterThan(0);
    expect(rated[0]!.averageRating).toBe(2);

    // ...and the group verdict reaches the Live Traces score summary alongside evaluator
    // verdicts (judgeScores on the traces list).
    const traces = (await api("/ingest/traces?limit=10")).body as {
      traces: Array<{ judgeScores?: { scorerName?: string; rating?: number } | null }>;
    };
    const liveTrace = traces.traces.find(t => t.judgeScores) as { _id?: string; judgeScores?: { scorerName?: string; rating?: number } } | undefined;
    // The group aggregate owns the Score chip headline whenever one exists.
    expect(liveTrace?.judgeScores?.scorerName).toBe("Live group (group)");
    expect(liveTrace?.judgeScores?.rating).toBe(2);

    // The Trace Details popup's score list carries the group aggregate, kind-tagged, so the
    // dialog can offer its Group score / Judge scores toggle.
    const evals = (await api(`/agent-monitoring/traces/${liveTrace!._id}/evaluations`)).body as {
      evaluations: Array<{ kind: string; evaluatorName: string; rating: number }>;
    };
    const groupEntry = evals.evaluations.find(e => e.kind === "group");
    expect(groupEntry).toMatchObject({ evaluatorName: "Live group", rating: 2 });

    // ...alongside the DETAILED member verdicts (kind "judge"), which is what the dialog's
    // "Judge scores" side of the toggle shows even when no standalone evaluator scored.
    const memberEntry = evals.evaluations.find(e => e.kind === "judge");
    expect(memberEntry).toMatchObject({ evaluatorName: "Live harsh", rating: 2 });

    // Score-kind events are ratings, not runs - the KPI denominator counts the ingested trace
    // once, not once per scorer that rated it.
    const kpis = (await api("/agent-monitoring/kpis?window=24h")).body as { totalRuns: number };
    expect(kpis.totalRuns).toBe(1);
  }, 30_000);
});
