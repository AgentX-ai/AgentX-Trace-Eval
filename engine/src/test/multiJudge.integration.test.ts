import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import { runGateResultSchema } from "../contract/wire.js";

// Multi-judge dataset runs: one agent execution, N verdicts. The primary scorer keeps the
// rating column (gates/averages/calibration unchanged); additionalScorerIds each pass their own
// verdict per result (judgeScorerResults), aggregate into the run's scorerBreakdown, and can be
// gated by name ("fail if Safety < 8 even when the average is fine").

let engine: TestEngine;
let key: string;
let judgeStub: http.Server;
let stubUrl: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  // One stub, per-rubric ratings: the marker embedded in each scorer's criteria picks the score,
  // so the test can prove each verdict came from the right rubric.
  judgeStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const rating = raw.includes("SAFETYMARK") ? 3 : raw.includes("TONEMARK") ? 6 : 9;
      res.setHeader("content-type", "application/json");
      // Judges arrive via the Responses API (judge-core), the Playground's model completion via
      // chat completions - serve whichever shape the path asks for.
      if ((req.url ?? "").includes("/chat/completions")) {
        res.end(
          JSON.stringify({
            id: "chat_stub",
            choices: [{ message: { role: "assistant", content: "stub answer" } }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          })
        );
        return;
      }
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
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "multi-judge" }), apiKey: null });
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

describe("multi-judge runs", () => {
  it("one execution, three verdicts, per-scorer breakdown, named-scorer gate", async () => {
    const makeScorer = async (name: string, marker: string) => {
      const res = await api(
        "/agent-monitoring/judge-scorers",
        postJson({ name, judge: { evaluationCriteria: `Judge with ${marker}.`, judgeModel: "stub-judge-m" } })
      );
      expect(res.status).toBe(201);
      return (res.body as { judgeScorer: { _id: string } }).judgeScorer._id;
    };
    const blendScorer = {
      id: "blend",
      name: "blend",
      enabled: true,
      code: "if (!scores) return { score: null }; return { score: (scores.rating / 10) * 0.5 + (scores.judges['Safety'] / 10) * 0.5, reasoning: 'judge ' + scores.rating + ' safety ' + scores.judges['Safety'] };",
    };
    // On the PRIMARY scorer's offline profile: a run graded by a standalone scorer takes its
    // code scorers from that scorer's config, not the dataset's.
    const primaryRes = await api(
      "/agent-monitoring/judge-scorers",
      postJson({
        name: "Quality",
        judge: { evaluationCriteria: "Judge with PRIMARYMARK.", judgeModel: "stub-judge-m" },
        offline: { codeScorers: [blendScorer] },
      })
    );
    expect(primaryRes.status).toBe(201);
    const primaryId = (primaryRes.body as { judgeScorer: { _id: string } }).judgeScorer._id;
    const safetyId = await makeScorer("Safety", "SAFETYMARK");
    const toneId = await makeScorer("Tone", "TONEMARK");

    const dataset = await api(
      "/custom-agent-evaluations/datasets",
      postJson({ name: "mj-dataset", questions: [{ main_question: { query: "hello?", expectedResults: "hi" } }] })
    );
    const datasetId = (dataset.body as { _id: string })._id;

    const run = await api(
      "/custom-agent-evaluations/runs",
      postJson({
        datasetId,
        evaluationSettingsId: primaryId,
        // The primary repeated in the list must be dropped, not double-scored.
        additionalScorerIds: [safetyId, toneId, primaryId],
        runSource: "sdk",
      })
    );
    expect(run.status).toBe(201);
    const runId = (run.body as { runId: string }).runId;

    const appended = await api(
      `/custom-agent-evaluations/runs/${runId}/results`,
      postJson({
        batchId: "b1",
        results: [{ idempotencyKey: "r1", questionIndex: 0, input: { query: "hello?" }, output: { text: "hi" } }],
      })
    );
    expect(appended.status).toBe(200);
    const scored = (
      appended.body as {
        scoredResults: Array<{
          rating: number | null;
          judgeScorerResults: Array<{ scorerId: string; name: string; rating: number | null }> | null;
        }>;
      }
    ).scoredResults[0]!;
    // Primary verdict in the rating column; each additional scorer's verdict labeled and scored
    // by ITS OWN rubric (the stub keys ratings off the rubric markers).
    expect(scored.rating).toBe(9);
    expect(scored.judgeScorerResults).toHaveLength(2);
    const bySc = Object.fromEntries((scored.judgeScorerResults ?? []).map(v => [v.name, v.rating]));
    expect(bySc).toEqual({ Safety: 3, Tone: 6 });

    // Code scorers run AFTER the judges, so this one combined their verdicts - the "custom
    // weighted final score" contract. Primary 9 and Safety 3 at 50/50 = 0.6.
    const blend = (
      scored as unknown as { codeScorerResults: Array<{ name: string; score: number | null; reasoning?: string }> }
    ).codeScorerResults?.find(cs => cs.name === "blend");
    expect(blend?.score).toBeCloseTo(0.6, 10);
    expect(blend?.reasoning).toContain("judge 9 safety 3");

    await api(`/custom-agent-evaluations/runs/${runId}/finalize`, { method: "POST" });

    // Run detail: per-scorer aggregate, primary first.
    const detail = (await api(`/custom-agent-evaluations/runs/${runId}`)).body as {
      scorerBreakdown: Array<{ scorerId: string | null; name: string; primary: boolean; averageRating: number | null }>;
      additionalScorerIds: string[] | null;
    };
    expect(detail.additionalScorerIds).toEqual([safetyId, toneId]);
    expect(detail.scorerBreakdown).toEqual([
      { scorerId: primaryId, name: "Quality", primary: true, averageRating: 9, scored: 1 },
      { scorerId: safetyId, name: "Safety", primary: false, averageRating: 3, scored: 1 },
      { scorerId: toneId, name: "Tone", primary: false, averageRating: 6, scored: 1 },
    ]);

    // The gate on the primary passes at 5...
    const primaryGate = runGateResultSchema.parse(
      (await api(`/custom-agent-evaluations/runs/${runId}/gate?failUnder=5`)).body
    );
    expect(primaryGate.passed).toBe(true);
    expect(primaryGate.gatedScorer).toBeNull();

    // ...while gating the NAMED Safety scorer fails the same run at the same floor.
    const safetyGate = runGateResultSchema.parse(
      (await api(`/custom-agent-evaluations/runs/${runId}/gate?failUnder=5&scorer=Safety`)).body
    );
    expect(safetyGate.passed).toBe(false);
    expect(safetyGate.gatedScorer).toEqual({ id: safetyId, name: "Safety" });
    expect(safetyGate.averageRating).toBe(3);

    // An unknown scorer name is a hard 400, never a silently-passing gate on nothing.
    expect((await api(`/custom-agent-evaluations/runs/${runId}/gate?failUnder=5&scorer=Nope`)).status).toBe(400);
  }, 90_000);

  it("playground run also grades with additional judge scorers", async () => {
    const makeScorer = async (name: string, marker: string) => {
      const res = await api(
        "/agent-monitoring/judge-scorers",
        postJson({ name, judge: { evaluationCriteria: `Judge with ${marker}.`, judgeModel: "stub-judge-m" } })
      );
      expect(res.status).toBe(201);
      return (res.body as { judgeScorer: { _id: string } }).judgeScorer._id;
    };
    const safetyId = await makeScorer("PG Safety", "SAFETYMARK");
    const toneId = await makeScorer("PG Tone", "TONEMARK");

    const run = await api(
      "/evaluate/playground/run",
      postJson({
        model: "stub-judge-m",
        messages: [],
        query: "hello?",
        additionalScorerIds: [safetyId, toneId, "gone-scorer"],
      })
    );
    expect(run.status).toBe(200);
    const body = run.body as {
      output: string | null;
      judgeScorerResults: Array<{ scorerId: string; name: string; rating: number | null }>;
    };
    // Each verdict came from its own rubric (the stub keys ratings off the markers); the deleted
    // scorer id degrades to "not scored by it" rather than failing the cell.
    const byName = Object.fromEntries(body.judgeScorerResults.map(v => [v.name, v.rating]));
    expect(byName).toEqual({ "PG Safety": 3, "PG Tone": 6 });
  }, 90_000);
});
