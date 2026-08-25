import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Head-to-head judging over two runs of the same dataset. No LLM key is configured in this
// harness, so every judge call fails - which is exactly the interesting shape to pin: the batch
// still completes, every unresolved pair is recorded as a tie (never a coin flip toward one run),
// the presentation order still alternates, and the refusals around the edges (self-comparison,
// mismatched datasets, unknown run, no shared answers) are loud rather than empty successes.

let engine: TestEngine;
let datasetId: string;
let runA: string;
let runB: string;

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const api = (path: string, init?: RequestInit) => engine.json(`/api/v1${path}`, init);

async function makeDataset(name: string): Promise<string> {
  const created = await api(
    "/custom-agent-evaluations/datasets",
    post({
      name,
      questions: [
        {
          main_question: {
            question: "How long do I have to return an item?",
            expectedResults: "30 days.",
          },
        },
        {
          main_question: {
            question: "Do I need the receipt?",
            expectedResults: "Yes.",
          },
        },
      ],
    }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;
}

// A finished run whose two answers are `texts`; questionIndex ties the case to the dataset.
async function makeRun(dataset: string, texts: (string | null)[]): Promise<string> {
  const created = await api("/custom-agent-evaluations/runs", post({ datasetId: dataset, runSource: "sdk" }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = (created.body as { runId: string }).runId;
  await api(
    `/custom-agent-evaluations/runs/${runId}/results`,
    post({
      batchId: `${runId}-b1`,
      results: texts.map((text, i) => ({
        idempotencyKey: `${runId}-${i}`,
        questionIndex: i,
        input: { query: `question ${i}` },
        ...(text == null ? {} : { output: { text } }),
      })),
    }),
  );
  await api(`/custom-agent-evaluations/runs/${runId}/finalize`, post({}));
  return runId;
}

beforeAll(async () => {
  engine = await startEngine();
  datasetId = await makeDataset("pairwise-returns");
  runA = await makeRun(datasetId, ["You have 30 days from delivery.", "Yes, bring the receipt."]);
  runB = await makeRun(datasetId, ["Returns are accepted.", "Proof of purchase is required."]);
}, 120_000);

afterAll(async () => {
  await engine?.stop();
});

describe("pairwise comparison", () => {
  let batchId: string;

  it("refuses the comparisons that cannot mean anything", async () => {
    const self = await api("/evaluate/runs/pairwise", post({ runAId: runA, runBId: runA }));
    expect(self.status).toBe(400);
    expect((self.body as { error: string }).error).toContain("itself");

    const unknown = await api("/evaluate/runs/pairwise", post({ runAId: runA, runBId: "no-such-run" }));
    expect(unknown.status).toBe(404);

    const otherDataset = await makeDataset("pairwise-other");
    const otherRun = await makeRun(otherDataset, ["different question set"]);
    const mismatched = await api("/evaluate/runs/pairwise", post({ runAId: runA, runBId: otherRun }));
    expect(mismatched.status).toBe(400);
    expect((mismatched.body as { error: string }).error).toContain("same question set");

    // Schema failures are 400s naming the field, not silently defaulted runs.
    expect((await api("/evaluate/runs/pairwise", post({ runAId: runA }))).status).toBe(400);
  });

  it("judges every shared case and alternates which run is read first", async () => {
    const created = await api("/evaluate/runs/pairwise", post({ runAId: runA, runBId: runB }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const comparison = (
      created.body as {
        comparison: {
          batchId: string;
          summary: {
            total: number;
            ties: number;
            winner: string;
            flipRate: number | null;
          };
          cases: {
            presentedFirst: string;
            winner: string;
            justification: string;
            questionIndex: number;
          }[];
          skipped: unknown[];
          bothOrders: boolean;
        };
      }
    ).comparison;
    batchId = comparison.batchId;

    expect(comparison.summary.total).toBe(2);
    expect(comparison.cases.map(c => c.presentedFirst)).toEqual(["a", "b"]);
    // With no key every judge call throws, and an unresolved pair is a tie rather than a win for
    // whichever run happened to be presented first.
    expect(comparison.summary.ties).toBe(2);
    expect(comparison.summary.winner).toBe("tie");
    expect(comparison.cases[0]!.justification).toContain("Judging failed");
    // flipRate is null unless both orders were actually judged - not a fabricated 0.
    expect(comparison.summary.flipRate).toBeNull();
    expect(comparison.bothOrders).toBe(false);
  });

  it("reads the stored batch back with the same verdicts", async () => {
    const read = await api(`/evaluate/runs/pairwise/${batchId}`);
    expect(read.status).toBe(200);
    const comparison = (read.body as { comparison: { runAId: string; cases: unknown[] } }).comparison;
    expect(comparison.runAId).toBe(runA);
    expect(comparison.cases).toHaveLength(2);

    expect((await api("/evaluate/runs/pairwise/no-such-batch")).status).toBe(404);
  });

  it("lists batches, and filters them by run", async () => {
    const all = (await api("/evaluate/runs/pairwise")).body as {
      comparisons: { batchId: string }[];
    };
    expect(all.comparisons.map(c => c.batchId)).toContain(batchId);

    const filtered = (await api(`/evaluate/runs/pairwise?runAId=${runA}`)).body as {
      comparisons: { runAId: string }[];
    };
    expect(filtered.comparisons.length).toBeGreaterThan(0);
    expect(filtered.comparisons.every(c => c.runAId === runA)).toBe(true);

    const none = (await api("/evaluate/runs/pairwise?runAId=no-such-run")).body as { comparisons: unknown[] };
    expect(none.comparisons).toHaveLength(0);
  });

  it("names the cases it could not judge instead of dropping them silently", async () => {
    const halfEmpty = await makeRun(datasetId, ["Only the first question was answered.", null]);
    const created = await api("/evaluate/runs/pairwise", post({ runAId: runA, runBId: halfEmpty }));
    expect(created.status).toBe(201);
    const comparison = (
      created.body as {
        comparison: {
          summary: { total: number };
          skipped: { questionIndex: number; reason: string }[];
        };
      }
    ).comparison;
    expect(comparison.summary.total).toBe(1);
    expect(comparison.skipped).toHaveLength(1);
    expect(comparison.skipped[0]!.reason).toContain("no output");

    // A pair with nothing in common is a refusal, not an empty 201.
    const empty = await makeRun(datasetId, [null, null]);
    const nothing = await api("/evaluate/runs/pairwise", post({ runAId: empty, runBId: halfEmpty }));
    expect(nothing.status).toBe(400);
    expect((nothing.body as { error: string }).error).toContain("nothing to compare");
  });

  it("head-to-head verdicts are backed up", async () => {
    const manifest = await api("/export");
    const entry = (manifest.body as { entities: { entity: string; rows: number }[] }).entities.find(
      e => e.entity === "pairwise-comparisons",
    );
    expect(entry?.rows).toBeGreaterThan(0);
  });
});
