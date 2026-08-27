# @agentx/eval

Minimal TypeScript client for the AgentX self-host engine's evaluation CI surface. It covers
exactly what a CI job needs: create a dataset, open a run, submit your agent's outputs for
judge scoring, finalize, and gate the build on the result. Plus a pairwise run-vs-run
comparison.

- Zero runtime dependencies; uses Node 18+ global `fetch`.
- ESM and CJS builds.
- Talks to `AgentX-trace-eval/engine` (`/api/v1/custom-agent-evaluations` and
  `/api/v1/evaluate/runs/pairwise`). Auth is the engine's `x-api-key` header.

## Install

```sh
yarn add @agentx/eval
```

## CI example

```ts
import { AgentXEval } from "@agentx/eval";

const evals = new AgentXEval({
  apiKey: process.env.AGENTX_API_KEY!,
  baseUrl: "http://localhost:4700/api/v1",
});

// 1. A dataset of cases (create once, reuse the id across runs).
const dataset = await evals.createDataset({
  name: "support-agent-golden",
  evaluationCriteria: "Answers must be correct and cite the knowledge base.",
  questions: [
    { query: "How do I reset my password?", expectedResults: "Points at the reset flow." },
    { query: "What plans exist?" },
  ],
});

// 2. Open a run, tagged with what is being evaluated.
const run = await evals.initRun({
  datasetId: dataset.datasetId,
  subject: { name: "support-agent", metadata: { version: process.env.GIT_SHA } },
});

// 3. Run your agent over the cases and submit the outputs. The engine judge-scores each
// result synchronously; submit() returns the aggregated outcome.
const outputs = await runMyAgentOverCases(); // your code
await run.submit(
  outputs.map((o, caseIndex) => ({
    caseIndex,
    query: o.query,
    output: o.answer,
    traceId: o.traceId, // optional: links the trace for trajectory-aware judging
    latencyMs: o.latencyMs, // optional
  }))
);

// 4. Finalize, then gate the build.
const summary = await run.finalize();
console.log(summary.liveStatistics); // averageRating, ratedCount, skippedCount, failedCount

const gate = await run.gate({ failUnder: 7, noRegression: true, record: true, caller: "ci" });
gate.assert(); // throws an Error naming each failed check when the gate did not pass
```

To compare two finished runs head to head:

```ts
const cmp = await evals.comparePairwise({ runAId: run.runId, runBId: "previous-run-id", bothOrders: true });
console.log(cmp.summary); // { total, aWins, bWins, ties, winner, flipRate }
```

## Batching

The engine caps a results batch at 10 items. `submit()` accepts any number of items and
auto-chunks them; each batch gets one retry on failure, and a second failure throws an
`AgentXEvalError` carrying the HTTP status and the engine's error message (remaining batches
are not sent).

## Resume

Every result is submitted under a deterministic idempotency key,
`` `${runId}:${caseIndex}:${runNumber || 1}` ``, and the engine deduplicates on it. After a
crash or network failure mid-run:

```ts
const done = new Set(await run.submittedKeys());
const remaining = allCases.filter((c, i) => !done.has(run.idempotencyKey(i)));
```

Re-run and resubmit only `remaining`; resubmitting an already-accepted case is also safe and
counts as a duplicate rather than being scored (and paid for) again.

## Scope

This package is the CI surface only. Dataset curation, evaluation settings, prompt registry,
whole-run LLM analysis and the dashboard live in the engine and its web UI.
