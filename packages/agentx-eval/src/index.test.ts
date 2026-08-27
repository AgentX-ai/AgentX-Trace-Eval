import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentXEval,
  AgentXEvalError,
  MAX_BATCH_SIZE,
  SDK_NAME,
  SDK_VERSION,
  type EvalRun,
} from "./index.js";

// ---------------------------------------------------------------------------
// Stub engine: a plain node:http server per test that captures every request
// (method, path, query, headers, parsed JSON body) and answers from a responder.
// ---------------------------------------------------------------------------

type CapturedRequest = {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: IncomingHttpHeaders;
  // Parsed JSON request body; undefined for body-less requests.
  body: any;
};

type StubResponse = { status?: number; json?: unknown };
type Responder = (req: CapturedRequest) => StubResponse;

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  servers = [];
});

async function startStub(respond: Responder): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const captured: CapturedRequest = {
        method: req.method ?? "",
        path: url.pathname,
        search: url.searchParams,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(captured);
      const out = respond(captured);
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/api/v1`, requests };
}

const LIVE_STATS = {
  averageRating: 8,
  minRating: 6,
  maxRating: 10,
  ratedCount: 3,
  skippedCount: 1,
  failedCount: 0,
};

function batchOutcome(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    batchId: "b",
    accepted: 1,
    duplicates: 0,
    failedValidation: 0,
    status: "in_progress",
    scoredResults: [],
    liveStatistics: LIVE_STATS,
    ...overrides,
  };
}

// Boots a stub that answers POST /runs with a canned run, then hands every other request to the
// given responder; returns the stub plus an EvalRun bound to it.
async function startRunStub(respond: Responder): Promise<{ baseUrl: string; requests: CapturedRequest[]; run: EvalRun }> {
  const stub = await startStub(req => {
    if (req.method === "POST" && req.path === "/api/v1/custom-agent-evaluations/runs") {
      return { status: 201, json: { runId: "run-1", datasetId: "ds-1", status: "in_progress" } };
    }
    return respond(req);
  });
  const evals = new AgentXEval({ apiKey: "test-key", baseUrl: stub.baseUrl });
  const run = await evals.initRun({ datasetId: "ds-1" });
  return { ...stub, run };
}

function resultRequests(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter(req => req.path.endsWith("/results"));
}

// ---------------------------------------------------------------------------

describe("createDataset", () => {
  it("posts the engine's main_question shape with the x-api-key header and maps _id to datasetId", async () => {
    const stub = await startStub(() => ({
      status: 201,
      json: { _id: "ds-1", name: "support-golden", questions: [] },
    }));
    const evals = new AgentXEval({ apiKey: "test-key", baseUrl: stub.baseUrl });
    const dataset = await evals.createDataset({
      name: "support-golden",
      evaluationCriteria: "Answers must cite the KB",
      questions: [
        { query: "How do I reset my password?", expectedResults: "Points at the reset flow" },
        { query: "What plans exist?" },
      ],
    });

    expect(stub.requests).toHaveLength(1);
    const req = stub.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/custom-agent-evaluations/datasets");
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(req.body).toEqual({
      name: "support-golden",
      evaluationCriteria: "Answers must cite the KB",
      questions: [
        { main_question: { query: "How do I reset my password?", expectedResults: "Points at the reset flow" } },
        { main_question: { query: "What plans exist?" } },
      ],
    });
    expect(dataset.datasetId).toBe("ds-1");
  });
});

describe("initRun", () => {
  it("posts datasetId, evaluationSubject, runSource sdk and the sdk identity", async () => {
    const stub = await startStub(() => ({
      status: 201,
      json: { runId: "run-1", datasetId: "ds-1", status: "in_progress" },
    }));
    const evals = new AgentXEval({ apiKey: "test-key", baseUrl: stub.baseUrl });
    const run = await evals.initRun({ datasetId: "ds-1", subject: { name: "agent", version: "v2" } });

    const req = stub.requests[0]!;
    expect(req.path).toBe("/api/v1/custom-agent-evaluations/runs");
    expect(req.body).toEqual({
      datasetId: "ds-1",
      evaluationSubject: { name: "agent", version: "v2" },
      runSource: "sdk",
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    });
    expect(SDK_NAME).toBe("@agentx/eval");
    expect(run.runId).toBe("run-1");
    expect(run.datasetId).toBe("ds-1");
  });
});

describe("submit", () => {
  it("maps items to the engine's result shape with deterministic idempotency keys", async () => {
    const { run, requests } = await startRunStub(() => ({ json: batchOutcome() }));
    await run.submit([
      {
        caseIndex: 2,
        runNumber: 3,
        query: "What plans exist?",
        output: "Three plans: free, pro, team.",
        traceId: "tr-9",
        latencyMs: 120,
      },
    ]);

    const posts = resultRequests(requests);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/v1/custom-agent-evaluations/runs/run-1/results");
    expect(posts[0]!.body.results).toEqual([
      {
        idempotencyKey: "run-1:2:3",
        questionIndex: 2,
        runNumber: 3,
        input: { query: "What plans exist?" },
        output: { text: "Three plans: free, pro, team." },
        traceId: "tr-9",
        timings: { latencyMs: 120 },
      },
    ]);
  });

  it("defaults runNumber to 1 in the idempotency key and omits absent optional fields", async () => {
    const { run, requests } = await startRunStub(() => ({ json: batchOutcome() }));
    await run.submit([{ caseIndex: 0, query: "q", output: "a" }]);

    const result = resultRequests(requests)[0]!.body.results[0];
    expect(result.idempotencyKey).toBe("run-1:0:1");
    expect(result.runNumber).toBe(1);
    expect("traceId" in result).toBe(false);
    expect("timings" in result).toBe(false);
  });

  it("auto-chunks into batches of at most 10, each with a batchId", async () => {
    const { run, requests } = await startRunStub(() => ({ json: batchOutcome() }));
    const items = Array.from({ length: 25 }, (_, i) => ({ caseIndex: i, query: `q${i}`, output: `a${i}` }));
    await run.submit(items);

    const posts = resultRequests(requests);
    expect(posts.map(req => req.body.results.length)).toEqual([10, 10, 5]);
    expect(MAX_BATCH_SIZE).toBe(10);
    for (const post of posts) {
      expect(typeof post.body.batchId).toBe("string");
      expect(post.body.batchId.length).toBeGreaterThan(0);
    }
    // Keys stay deterministic across the whole submission, batch boundaries included.
    expect(posts[2]!.body.results[0].idempotencyKey).toBe("run-1:20:1");
  });

  it("aggregates accepted/duplicates/failedValidation across batches and keeps the last liveStatistics", async () => {
    let batchNumber = 0;
    const { run } = await startRunStub(() => {
      batchNumber++;
      return {
        json:
          batchNumber === 1
            ? batchOutcome({
                accepted: 8,
                duplicates: 1,
                failedValidation: 1,
                scoredResults: [{ idempotencyKey: "run-1:0:1", rating: 9, justification: "good", status: "scored" }],
              })
            : batchOutcome({
                accepted: 5,
                duplicates: 0,
                failedValidation: 0,
                liveStatistics: { ...LIVE_STATS, averageRating: 7.5, ratedCount: 13 },
              }),
      };
    });
    const items = Array.from({ length: 15 }, (_, i) => ({ caseIndex: i, query: `q${i}`, output: `a${i}` }));
    const summary = await run.submit(items);

    expect(summary.accepted).toBe(13);
    expect(summary.duplicates).toBe(1);
    expect(summary.failedValidation).toBe(1);
    expect(summary.scoredResults).toHaveLength(1);
    expect(summary.liveStatistics).toEqual({ ...LIVE_STATS, averageRating: 7.5, ratedCount: 13 });
  });

  it("retries a failed batch once with the same payload and succeeds", async () => {
    let resultCalls = 0;
    const { run, requests } = await startRunStub(() => {
      resultCalls++;
      if (resultCalls === 1) {
        return { status: 500, json: { error: "boom" } };
      }
      return { json: batchOutcome({ accepted: 1 }) };
    });
    const summary = await run.submit([{ caseIndex: 0, query: "q", output: "a" }]);

    const posts = resultRequests(requests);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    expect(summary.accepted).toBe(1);
  });

  it("throws AgentXEvalError with the engine's status and message when the retry also fails", async () => {
    const { run, requests } = await startRunStub(() => ({
      status: 409,
      json: { error: "Run is already in a terminal state" },
    }));

    const error = await run.submit([{ caseIndex: 0, query: "q", output: "a" }]).then(
      () => {
        throw new Error("submit should have thrown");
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(AgentXEvalError);
    expect((error as AgentXEvalError).status).toBe(409);
    expect((error as AgentXEvalError).message).toBe("Run is already in a terminal state");
    // One attempt plus exactly one retry, nothing more.
    expect(resultRequests(requests)).toHaveLength(2);
  });
});

describe("finalize", () => {
  it("posts to /runs/:runId/finalize and returns liveStatistics including skipped and failed counts", async () => {
    const { run, requests } = await startRunStub(() => ({
      json: { runId: "run-1", status: "completed", liveStatistics: LIVE_STATS },
    }));
    const summary = await run.finalize();

    const post = requests.find(req => req.path.endsWith("/finalize"))!;
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/api/v1/custom-agent-evaluations/runs/run-1/finalize");
    expect(summary.status).toBe("completed");
    expect(summary.liveStatistics.skippedCount).toBe(1);
    expect(summary.liveStatistics.failedCount).toBe(0);
  });
});

describe("gate", () => {
  const passingGate = {
    runId: "run-1",
    datasetId: "ds-1",
    averageRating: 8.2,
    resultCount: 10,
    baselineRunId: "run-0",
    baselineAverage: 8.0,
    checks: [
      { check: "fail-under", passed: true, threshold: 7, actual: 8.2, detail: "Average rating 8.2 >= floor 7" },
      {
        check: "no-regression",
        passed: true,
        threshold: 8.0,
        actual: 8.2,
        detail: "Average rating 8.2 vs previous run's 8 (tolerance 0.3)",
      },
    ],
    passed: true,
  };

  it("sends every provided option as a query parameter and assert() is silent on a pass", async () => {
    const { run, requests } = await startRunStub(() => ({ json: passingGate }));
    const gate = await run.gate({ failUnder: 7, noRegression: true, tolerance: 0.3, record: true, caller: "ci" });

    const req = requests.find(r => r.path.endsWith("/gate"))!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/custom-agent-evaluations/runs/run-1/gate");
    expect(req.search.get("failUnder")).toBe("7");
    expect(req.search.get("noRegression")).toBe("true");
    expect(req.search.get("tolerance")).toBe("0.3");
    expect(req.search.get("record")).toBe("true");
    expect(req.search.get("caller")).toBe("ci");
    expect(gate.passed).toBe(true);
    expect(() => gate.assert()).not.toThrow();
  });

  it("omits query parameters that were not provided", async () => {
    const { run, requests } = await startRunStub(() => ({ json: passingGate }));
    await run.gate({ failUnder: 7 });

    const req = requests.find(r => r.path.endsWith("/gate"))!;
    expect(req.search.get("failUnder")).toBe("7");
    expect(req.search.has("noRegression")).toBe(false);
    expect(req.search.has("tolerance")).toBe(false);
    expect(req.search.has("record")).toBe(false);
    expect(req.search.has("caller")).toBe(false);
  });

  it("assert() throws an Error naming each failed check from the check field", async () => {
    const { run } = await startRunStub(() => ({
      json: {
        ...passingGate,
        averageRating: 4.2,
        checks: [
          { check: "fail-under", passed: false, threshold: 7, actual: 4.2, detail: "Average rating 4.2 < floor 7" },
          {
            check: "no-regression",
            passed: true,
            threshold: 8.0,
            actual: 4.2,
            detail: "Average rating 4.2 vs previous run's 8 (tolerance 5)",
          },
        ],
        passed: false,
      },
    }));
    const gate = await run.gate({ failUnder: 7, noRegression: true });

    expect(gate.passed).toBe(false);
    let thrown: unknown;
    try {
      gate.assert();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("fail-under");
    expect(message).toContain("Average rating 4.2 < floor 7");
    // Passing checks are not listed as failures.
    expect(message).not.toContain("no-regression");
  });
});

describe("submittedKeys", () => {
  it("reads /runs/:runId/missing-results and returns the submittedKeys array", async () => {
    const { run, requests } = await startRunStub(() => ({
      json: { runId: "run-1", submittedKeys: ["run-1:0:1", "run-1:1:1"], submittedCount: 2, missing: [] },
    }));
    const keys = await run.submittedKeys();

    const req = requests.find(r => r.path.endsWith("/missing-results"))!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/custom-agent-evaluations/runs/run-1/missing-results");
    expect(keys).toEqual(["run-1:0:1", "run-1:1:1"]);
  });
});

describe("comparePairwise", () => {
  it("posts to /evaluate/runs/pairwise and unwraps the comparison", async () => {
    const comparison = {
      batchId: "pw-1",
      runAId: "run-1",
      runBId: "run-2",
      bothOrders: true,
      judgeModel: "gpt-test",
      summary: { total: 4, aWins: 3, bWins: 1, ties: 0, winner: "a", flipRate: 0 },
      cases: [],
      skipped: [],
    };
    const stub = await startStub(() => ({ status: 201, json: { comparison } }));
    const evals = new AgentXEval({ apiKey: "test-key", baseUrl: stub.baseUrl });
    const result = await evals.comparePairwise({
      runAId: "run-1",
      runBId: "run-2",
      bothOrders: true,
      criteria: "Prefer cited answers",
    });

    const req = stub.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/evaluate/runs/pairwise");
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(req.body).toEqual({
      runAId: "run-1",
      runBId: "run-2",
      bothOrders: true,
      criteria: "Prefer cited answers",
    });
    expect(result).toEqual(comparison);
  });
});

describe("errors", () => {
  it("surfaces a non-2xx response as AgentXEvalError with status and the engine's error message", async () => {
    const stub = await startStub(() => ({ status: 400, json: { error: "name is required" } }));
    const evals = new AgentXEval({ apiKey: "test-key", baseUrl: stub.baseUrl });

    const error = await evals.createDataset({ name: "", questions: [] }).then(
      () => {
        throw new Error("createDataset should have thrown");
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(AgentXEvalError);
    expect((error as AgentXEvalError).status).toBe(400);
    expect((error as AgentXEvalError).message).toBe("name is required");
  });
});
