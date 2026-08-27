// @agentx/eval: minimal TypeScript client for the AgentX self-host engine's evaluation CI
// surface. Wire contract derived from engine/src/routes/evaluations.ts (mounted at
// /api/v1/custom-agent-evaluations) and the pairwise route in
// engine/src/routes/evaluateDashboard.ts (mounted at /api/v1/evaluate).
// Zero runtime dependencies: Node 18+ global fetch only.

export const SDK_NAME = "@agentx/eval";
// Keep in sync with package.json's version; sent to the engine in init_run's sdk field.
export const SDK_VERSION = "0.1.0";

// The engine rejects result batches larger than this (routes/evaluations.ts MAX_BATCH_SIZE).
export const MAX_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// The single error type every non-2xx engine response is surfaced as: HTTP status plus the
// engine's own {error} message when the body carried one.
export class AgentXEvalError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentXEvalError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Wire types (camelCase, exactly what the engine returns)
// ---------------------------------------------------------------------------

export type LiveStatistics = {
  averageRating: number | null;
  minRating: number | null;
  maxRating: number | null;
  ratedCount: number;
  // skipped = the judge could not score (e.g. missing LLM key); failed = the submitted result
  // itself carried an error.
  skippedCount: number;
  failedCount: number;
};

export type DatasetQuestion = {
  query: string;
  expectedResults?: string;
};

export type CreateDatasetInput = {
  name: string;
  evaluationCriteria?: string;
  questions: DatasetQuestion[];
};

// The engine's dataset wire payload keys on _id; datasetId is added client-side as the
// camelCase convenience alias.
export type Dataset = {
  datasetId: string;
  _id: string;
  name: string;
  [key: string]: unknown;
};

export type InitRunInput = {
  datasetId: string;
  // Sent to the engine as evaluationSubject: a free-form description of what is being
  // evaluated (e.g. { name, version } of your agent).
  subject?: unknown;
};

export type SubmitItem = {
  // Index of the dataset question this result answers.
  caseIndex: number;
  // Repeat number for the same case; defaults to 1.
  runNumber?: number;
  query: string;
  output: string;
  traceId?: string;
  latencyMs?: number;
};

export type ScoredResult = {
  idempotencyKey: string;
  rating: number | null;
  justification: string | null;
  status: string;
  deduped?: boolean;
  [key: string]: unknown;
};

// Aggregated over all batches of one submit() call; liveStatistics is the engine's view after
// the last batch landed.
export type SubmitSummary = {
  accepted: number;
  duplicates: number;
  failedValidation: number;
  scoredResults: ScoredResult[];
  liveStatistics: LiveStatistics | null;
};

export type FinalizeSummary = {
  runId: string;
  status: string;
  liveStatistics: LiveStatistics;
};

export type GateOptions = {
  // Fail when the run's average rating is below this floor (0-10).
  failUnder?: number;
  // Fail when the average regressed vs the dataset's previous completed run.
  noRegression?: boolean;
  // Allowed drop for noRegression before it counts as a regression (engine default 0.5).
  tolerance?: number;
  // Persist this verdict into the engine's gate history (the dashboard's CI page).
  record?: boolean;
  // Free-form label recorded with the verdict, e.g. your CI job name.
  caller?: string;
};

export type GateCheck = {
  check: "fail-under" | "no-regression";
  passed: boolean;
  threshold: number | null;
  actual: number | null;
  detail: string;
};

export type GateResult = {
  runId: string;
  datasetId: string;
  averageRating: number | null;
  resultCount: number;
  baselineRunId: string | null;
  baselineAverage: number | null;
  checks: GateCheck[];
  passed: boolean;
  // Throws an Error naming every failed check when the gate did not pass; no-op otherwise.
  assert: () => void;
};

export type PairwiseInput = {
  runAId: string;
  runBId: string;
  // Judge every pair twice with the sides swapped (position-bias defense; doubles judge cost).
  bothOrders?: boolean;
  criteria?: string;
};

export type PairwiseComparison = {
  batchId: string;
  runAId: string;
  runBId: string;
  bothOrders: boolean;
  judgeModel: string;
  summary: {
    total: number;
    aWins: number;
    bWins: number;
    ties: number;
    winner: "a" | "b" | "tie";
    flipRate: number | null;
  };
  cases: unknown[];
  skipped: { questionIndex: number | null; reason: string }[];
  [key: string]: unknown;
};

export type AgentXEvalOptions = {
  apiKey: string;
  // The engine's API root, e.g. http://localhost:4700/api/v1
  baseUrl: string;
  // Test seam; defaults to the global fetch (Node 18+).
  fetch?: typeof fetch;
};

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export type QueryParams = Record<string, string | number | boolean | undefined>;

// The transport contract EvalRun runs on. Exported only so EvalRun's constructor can be typed
// in the emitted declarations; construct runs via AgentXEval.initRun, not by hand.
export interface EvalTransport {
  request<T>(method: "GET" | "POST", path: string, body?: unknown, query?: QueryParams): Promise<T>;
}

class HttpClient implements EvalTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(apiKey: string, baseUrl: string, fetchFn: typeof fetch) {
    this.apiKey = apiKey;
    // Trailing slashes trimmed without a regex: CodeQL flags an anchored /\/+$/ over
    // caller-provided input as potentially polynomial, and the loop is just as clear.
    let trimmed = baseUrl;
    while (trimmed.endsWith("/")) {
      trimmed = trimmed.slice(0, -1);
    }
    this.baseUrl = trimmed;
    this.fetchFn = fetchFn;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, query?: QueryParams): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await this.fetchFn(url, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      const engineMessage =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : text || response.statusText || `HTTP ${response.status}`;
      throw new AgentXEvalError(response.status, engineMessage);
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AgentXEval {
  private readonly http: HttpClient;

  constructor(options: AgentXEvalOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }
    if (!options.baseUrl) {
      throw new Error("baseUrl is required");
    }
    this.http = new HttpClient(options.apiKey, options.baseUrl, options.fetch ?? fetch);
  }

  // POST /custom-agent-evaluations/datasets. Convenience: flat {query, expectedResults}
  // questions are mapped to the engine's stored {main_question: {...}} shape.
  async createDataset(input: CreateDatasetInput): Promise<Dataset> {
    const body = {
      name: input.name,
      ...(input.evaluationCriteria !== undefined ? { evaluationCriteria: input.evaluationCriteria } : {}),
      questions: input.questions.map(question => ({
        main_question: {
          query: question.query,
          ...(question.expectedResults !== undefined ? { expectedResults: question.expectedResults } : {}),
        },
      })),
    };
    const raw = await this.http.request<{ _id: string } & Record<string, unknown>>(
      "POST",
      "/custom-agent-evaluations/datasets",
      body
    );
    return { ...raw, datasetId: raw._id } as Dataset;
  }

  // POST /custom-agent-evaluations/runs. Tags the run as runSource "sdk" with this package's
  // name and version so the dashboard can attribute it.
  async initRun(input: InitRunInput): Promise<EvalRun> {
    const raw = await this.http.request<{ runId: string; datasetId: string; status: string }>(
      "POST",
      "/custom-agent-evaluations/runs",
      {
        datasetId: input.datasetId,
        ...(input.subject !== undefined ? { evaluationSubject: input.subject } : {}),
        runSource: "sdk",
        sdk: { name: SDK_NAME, version: SDK_VERSION },
      }
    );
    return new EvalRun(this.http, raw.runId, raw.datasetId);
  }

  // POST /evaluate/runs/pairwise: head-to-head judging of two runs of the same dataset.
  async comparePairwise(input: PairwiseInput): Promise<PairwiseComparison> {
    const raw = await this.http.request<{ comparison: PairwiseComparison }>("POST", "/evaluate/runs/pairwise", {
      runAId: input.runAId,
      runBId: input.runBId,
      ...(input.bothOrders !== undefined ? { bothOrders: input.bothOrders } : {}),
      ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
    });
    return raw.comparison;
  }
}

// ---------------------------------------------------------------------------
// Run handle
// ---------------------------------------------------------------------------

type BatchOutcome = {
  runId: string;
  batchId: string;
  accepted: number;
  duplicates: number;
  failedValidation: number;
  status: string;
  scoredResults: ScoredResult[];
  liveStatistics: LiveStatistics;
};

export class EvalRun {
  readonly runId: string;
  readonly datasetId: string;
  private readonly http: EvalTransport;

  constructor(http: EvalTransport, runId: string, datasetId: string) {
    this.http = http;
    this.runId = runId;
    this.datasetId = datasetId;
  }

  // The deterministic idempotency key this client submits for a case: resubmitting the same
  // (caseIndex, runNumber) is deduplicated by the engine, which is what makes resume safe.
  idempotencyKey(caseIndex: number, runNumber?: number): string {
    return `${this.runId}:${caseIndex}:${runNumber || 1}`;
  }

  // POST /custom-agent-evaluations/runs/:runId/results, auto-chunked into batches of
  // MAX_BATCH_SIZE. Each batch gets one retry on failure; a second failure throws and any
  // remaining batches are not sent (resubmitting everything later is safe - see submittedKeys).
  async submit(items: SubmitItem[]): Promise<SubmitSummary> {
    const summary: SubmitSummary = {
      accepted: 0,
      duplicates: 0,
      failedValidation: 0,
      scoredResults: [],
      liveStatistics: null,
    };
    for (let start = 0; start < items.length; start += MAX_BATCH_SIZE) {
      const chunk = items.slice(start, start + MAX_BATCH_SIZE);
      const body = {
        // Deterministic batch label; retries of a batch reuse it. Deduplication itself rides on
        // the per-result idempotency keys, not on this.
        batchId: `${this.runId}:batch:${start / MAX_BATCH_SIZE}`,
        results: chunk.map(item => ({
          idempotencyKey: this.idempotencyKey(item.caseIndex, item.runNumber),
          questionIndex: item.caseIndex,
          runNumber: item.runNumber || 1,
          input: { query: item.query },
          output: { text: item.output },
          ...(item.traceId !== undefined ? { traceId: item.traceId } : {}),
          ...(item.latencyMs !== undefined ? { timings: { latencyMs: item.latencyMs } } : {}),
        })),
      };
      const path = `/custom-agent-evaluations/runs/${this.runId}/results`;
      let outcome: BatchOutcome;
      try {
        outcome = await this.http.request<BatchOutcome>("POST", path, body);
      } catch {
        // One retry per batch, then the second failure propagates to the caller.
        outcome = await this.http.request<BatchOutcome>("POST", path, body);
      }
      summary.accepted += outcome.accepted;
      summary.duplicates += outcome.duplicates;
      summary.failedValidation += outcome.failedValidation;
      summary.scoredResults.push(...outcome.scoredResults);
      summary.liveStatistics = outcome.liveStatistics;
    }
    return summary;
  }

  // POST /custom-agent-evaluations/runs/:runId/finalize
  async finalize(): Promise<FinalizeSummary> {
    return this.http.request<FinalizeSummary>("POST", `/custom-agent-evaluations/runs/${this.runId}/finalize`);
  }

  // GET /custom-agent-evaluations/runs/:runId/gate. At least one of failUnder / noRegression is
  // required (the engine 400s otherwise).
  async gate(options: GateOptions = {}): Promise<GateResult> {
    const raw = await this.http.request<Omit<GateResult, "assert">>(
      "GET",
      `/custom-agent-evaluations/runs/${this.runId}/gate`,
      undefined,
      {
        failUnder: options.failUnder,
        noRegression: options.noRegression,
        tolerance: options.tolerance,
        record: options.record,
        caller: options.caller,
      }
    );
    return {
      ...raw,
      assert(): void {
        if (raw.passed) {
          return;
        }
        const failing = raw.checks.filter(check => !check.passed);
        const details = failing.map(check => `${check.check}: ${check.detail}`).join("; ");
        throw new Error(`Evaluation gate failed for run ${raw.runId}: ${details}`);
      },
    };
  }

  // GET /custom-agent-evaluations/runs/:runId/missing-results. Resume support: the idempotency
  // keys the engine has already accepted for this run. Compute your keys with idempotencyKey()
  // and skip the cases whose key is already in this set.
  async submittedKeys(): Promise<string[]> {
    const raw = await this.http.request<{ submittedKeys: string[] }>(
      "GET",
      `/custom-agent-evaluations/runs/${this.runId}/missing-results`
    );
    return raw.submittedKeys;
  }
}
