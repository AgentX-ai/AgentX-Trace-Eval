import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Every route handler in this engine is an `async (req, res) => ...` mounted on Express 4, and
// Express 4 does not catch a rejected handler promise - it becomes an unhandled rejection, which
// Node kills the process over. So "this endpoint throws on a weird query param" isn't a 500 here,
// it's an outage for every project on the box, plus a SQLite WAL that never got flushed (the
// SIGTERM shutdown path in index.ts is skipped entirely on that exit).
//
// This suite therefore checks something stronger than "returns a sensible status": it checks the
// process is still alive afterwards. Each probe restarts the engine if a previous one killed it,
// so one crash doesn't mask the rest - the failure message lists every request that killed it.

type Probe = {
  name: string;
  path: string;
  init?: RequestInit;
};

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

// For payloads JSON.stringify can't express (Infinity, NaN, duplicate keys) but a real client's
// serializer happily can.
const raw = (body: string): RequestInit => ({
  method: "POST",
  body,
  headers: { "content-type": "application/json" },
});

// Inputs a real client can plausibly send: a dashboard with an empty text field, a paginated
// fetch whose cursor came back mangled, an SDK on a slightly different version, a user typing in
// a URL. None of them are exotic enough to justify taking the server down.
const PROBES: Probe[] = [
  { name: "GET /ingest/traces?limit=abc (non-numeric limit)", path: "/api/v1/ingest/traces?limit=abc" },
  { name: "GET /ingest/traces?limit=-5 (negative limit)", path: "/api/v1/ingest/traces?limit=-5" },
  { name: "GET /ingest/traces?limit=1e9 (huge limit)", path: "/api/v1/ingest/traces?limit=1e9" },
  { name: "GET /ingest/traces?limit[]=1&limit[]=2 (repeated param)", path: "/api/v1/ingest/traces?limit=1&limit=2" },
  { name: "GET /ingest/traces?cursor=@@@ (garbage cursor)", path: "/api/v1/ingest/traces?cursor=%40%40%40" },
  { name: "GET /ingest/traces/:id for an unknown id", path: "/api/v1/ingest/traces/does-not-exist" },
  { name: "GET /ingest/sessions/:id/spans for an unknown id", path: "/api/v1/ingest/sessions/does-not-exist/spans" },
  { name: "POST /ingest/traces with an empty body", path: "/api/v1/ingest/traces", init: json({}) },
  { name: "POST /ingest/traces with a null body", path: "/api/v1/ingest/traces", init: json(null) },
  { name: "POST /ingest/traces with tool_calls as a string", path: "/api/v1/ingest/traces", init: json({ name: "n", tool_calls: "oops" }) },
  {
    name: "POST /ingest/traces with a negative latency",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", latency_ms: -1, input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with started_at_unix_nano as prose",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", started_at_unix_nano: "yesterday", input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with started_at_unix_nano in exponential notation",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", started_at_unix_nano: "1.7e18", input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with an empty started_at_unix_nano",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", started_at_unix_nano: "", input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with an out-of-range started_at_unix_nano",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", started_at_unix_nano: "9".repeat(30), input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with a seconds-precision started_at_unix_nano",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", started_at_unix_nano: "1700000000", input: "hi", output: "yo" }),
  },
  {
    name: "POST /ingest/traces with deeply nested metadata",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", metadata: { deep: JSON.parse(`${"[".repeat(400)}1${"]".repeat(400)}`) } }),
  },
  {
    name: "POST /ingest/traces with an infinite token count",
    path: "/api/v1/ingest/traces",
    // JSON.parse turns 1e309 into Infinity, which z.number() accepts but SQLite cannot bind.
    init: raw('{"name":"n","input":"hi","output":"yo","input_tokens":1e309}'),
  },
  {
    name: "POST /ingest/traces with NUL bytes in the text",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n\u0000ul", input: "a\u0000b", output: "c\u0000d" }),
  },
  {
    name: "POST /ingest/traces with a body at the size limit",
    path: "/api/v1/ingest/traces",
    init: json({ name: "n", input: "x".repeat(200_000), output: "y".repeat(200_000) }),
  },
  { name: "GET /agent-monitoring/signals?limit=abc", path: "/api/v1/agent-monitoring/signals?limit=abc" },
  { name: "GET /agent-monitoring/kpis?window=nonsense", path: "/api/v1/agent-monitoring/kpis?window=nonsense" },
  { name: "GET /agent-monitoring/trend?window=nonsense", path: "/api/v1/agent-monitoring/trend?window=nonsense" },
  { name: "GET /agent-monitoring/cost-trend?window=nonsense", path: "/api/v1/agent-monitoring/cost-trend?window=nonsense" },
  { name: "GET /agent-monitoring/top-failing?limit=abc", path: "/api/v1/agent-monitoring/top-failing?limit=abc" },
  { name: "GET /agent-monitoring/sessions?limit=abc", path: "/api/v1/agent-monitoring/sessions?limit=abc" },
  { name: "GET /agent-monitoring/signals/:id for an unknown id", path: "/api/v1/agent-monitoring/signals/nope" },
  { name: "GET /agent-monitoring/agents/:id for an unknown id", path: "/api/v1/agent-monitoring/agents/nope" },
  { name: "POST /agent-monitoring/patterns with an empty body", path: "/api/v1/agent-monitoring/patterns", init: json({}) },
  {
    name: "POST /agent-monitoring/patterns with an invalid regex",
    path: "/api/v1/agent-monitoring/patterns",
    init: json({ name: "bad", type: "regex", pattern: "([unclosed", severity: "high" }),
  },
  {
    name: "POST /agent-monitoring/patterns with a catastrophic regex",
    path: "/api/v1/agent-monitoring/patterns",
    init: json({ name: "redos", type: "regex", pattern: "(a+)+$", severity: "high" }),
  },
  {
    name: "POST /agent-monitoring/patterns with an unknown severity",
    path: "/api/v1/agent-monitoring/patterns",
    init: json({ name: "n", type: "phrase", pattern: "x", severity: "catastrophic" }),
  },
  { name: "PUT /agent-monitoring/patterns/:id for an unknown id", path: "/api/v1/agent-monitoring/patterns/nope", init: { ...json({ name: "x" }), method: "PUT" } },
  { name: "DELETE /agent-monitoring/patterns/:id for an unknown id", path: "/api/v1/agent-monitoring/patterns/nope", init: { method: "DELETE" } },
  { name: "GET /agent-monitoring/traces/:id/evaluations for an unknown id", path: "/api/v1/agent-monitoring/traces/nope/evaluations" },
  { name: "GET /agent-monitoring/online-evaluators/:id/ratings for an unknown id", path: "/api/v1/agent-monitoring/online-evaluators/nope/ratings" },
  { name: "GET /agent-monitoring/sessions/:id/scores for an unknown id", path: "/api/v1/agent-monitoring/sessions/nope/scores" },
  { name: "GET /agent-monitoring/portability/models", path: "/api/v1/agent-monitoring/portability/models" },
  {
    name: "POST /agent-monitoring/portability/models with prices as strings",
    path: "/api/v1/agent-monitoring/portability/models",
    init: json({ id: "m", label: "m", provider: "openai", inputPricePerM: "free", outputPricePerM: "free" }),
  },
  { name: "GET /evaluate/list", path: "/api/v1/evaluate/list" },
  { name: "GET /evaluate/:id for an unknown id", path: "/api/v1/evaluate/nope" },
  { name: "GET /evaluate/runs/compare with no ids", path: "/api/v1/evaluate/runs/compare" },
  { name: "GET /evaluate/runs/compare with unknown ids", path: "/api/v1/evaluate/runs/compare?runIds=a,b" },
  { name: "GET /evaluate/ci/gates", path: "/api/v1/evaluate/ci/gates" },
  { name: "GET /evaluate/improve/inbox", path: "/api/v1/evaluate/improve/inbox" },
  { name: "GET /evaluate/prompts", path: "/api/v1/evaluate/prompts" },
  { name: "GET /evaluate/prompts/:id for an unknown id", path: "/api/v1/evaluate/prompts/nope" },
  { name: "GET /evaluate/tool-schemas", path: "/api/v1/evaluate/tool-schemas" },
  { name: "GET /evaluate/tool-schemas/:id for an unknown id", path: "/api/v1/evaluate/tool-schemas/nope" },
  { name: "GET /evaluate/playground/runs?limit=abc", path: "/api/v1/evaluate/playground/runs?limit=abc" },
  { name: "GET /evaluate/analyze/:id/status for an unknown id", path: "/api/v1/evaluate/analyze/nope/status" },
  { name: "GET /evaluate/datasets/batch/versions", path: "/api/v1/evaluate/datasets/batch/versions" },
  { name: "GET /evaluate/datasets/:id/versions for an unknown id", path: "/api/v1/evaluate/datasets/nope/versions" },
  { name: "GET /custom-agent-evaluations/datasets", path: "/api/v1/custom-agent-evaluations/datasets" },
  { name: "GET /custom-agent-evaluations/datasets/:id for an unknown id", path: "/api/v1/custom-agent-evaluations/datasets/nope" },
  { name: "GET /custom-agent-evaluations/runs?limit=abc", path: "/api/v1/custom-agent-evaluations/runs?limit=abc" },
  { name: "GET /custom-agent-evaluations/runs/:id for an unknown id", path: "/api/v1/custom-agent-evaluations/runs/nope" },
  { name: "POST /custom-agent-evaluations/datasets with an empty body", path: "/api/v1/custom-agent-evaluations/datasets", init: json({}) },
  {
    name: "POST /custom-agent-evaluations/datasets with cases as a string",
    path: "/api/v1/custom-agent-evaluations/datasets",
    init: json({ name: "d", cases: "not-a-list" }),
  },
  { name: "GET /agents", path: "/api/v1/agents" },
  { name: "GET /agents/:id for an unknown id", path: "/api/v1/agents/nope" },
  { name: "POST /agents with an empty body", path: "/api/v1/agents", init: json({}) },
  { name: "POST /outcomes with an empty body", path: "/api/v1/outcomes", init: json({}) },
  { name: "POST /feedback with an empty body", path: "/api/v1/feedback", init: json({}) },
  { name: "GET /feedback/trace/:id for an unknown id", path: "/api/v1/feedback/trace/nope" },
  { name: "GET /monitor/signals?limit=abc", path: "/api/v1/monitor/signals?limit=abc" },
];

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("engine resilience to hostile-but-plausible requests", () => {
  it(
    "never lets a single request kill the process",
    async () => {
      const killers: string[] = [];
      const serverErrors: string[] = [];

      for (const probe of PROBES) {
        if (!engine.alive()) {
          await engine.stop();
          engine = await startEngine();
        }
        let status: number | "no-response" = "no-response";
        try {
          const res = await engine.request(probe.path, probe.init);
          status = res.status;
          await res.text();
        } catch {
          // connection reset / refused - the process went down mid-request
        }
        // Give the process a moment to die if it is going to.
        await new Promise(r => setTimeout(r, 120));
        if (!engine.alive()) {
          killers.push(`${probe.name} -> exit ${engine.exitCode()}`);
          continue;
        }
        if (typeof status === "number" && status >= 500) {
          serverErrors.push(`${probe.name} -> ${status}`);
        }
      }

      expect(killers, `these requests killed the engine process:\n${killers.join("\n")}`).toEqual([]);
      expect(serverErrors, `these requests returned 5xx:\n${serverErrors.join("\n")}`).toEqual([]);
    },
    240_000
  );
});
