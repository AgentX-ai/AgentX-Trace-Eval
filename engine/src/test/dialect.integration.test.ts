import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresAvailable, startEngine, type TestEngine } from "./server.js";

// storage/db.ts carries two hand-written query paths for almost every read - `db.kind === "sqlite"
// ? db.db.select()...all() : await db.db.select()...` - plus two schema files (schema.sqlite.ts and
// schema.pg.ts) that have to stay in step by hand. That is the classic shape for silent
// divergence: a filter added to one branch, a column typed differently, a sort that only holds on
// one engine. Nothing catches it unless both backends run the same scenario and the answers are
// compared.
//
// Opt-in: set AGENTX_TEST_DB_URL to a Postgres superuser connection string. Without it this file
// skips rather than failing, so a checkout with no Postgres still runs green.

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

// Ids, keys and timestamps differ run to run by design - everything else should match exactly.
const VOLATILE_KEYS = new Set([
  "_id",
  "id",
  "runId",
  "datasetId",
  "traceId",
  "agentId",
  "signalId",
  "apiKey",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "ts",
  "label",
  "key",
  "projectId",
  "monitoringAgentId",
  "firstSeenAt",
  "lastSeenAt",
  "seenAt",
  "evaluationSettingsId",
  "patternId",
  "spanId",
  "parentSpanId",
  "sessionId",
  "points",
]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) {
        // Kept as a presence/type marker so "field disappeared on one backend" still fails.
        out[key] = inner === null ? null : typeof inner;
        continue;
      }
      out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

// One scripted workload, replayed identically against each backend. Deterministic on purpose:
// fixed span ids, fixed timestamps, no reliance on wall-clock ordering.
async function runScenario(engine: TestEngine) {
  const startedAt = 1_760_000_000_000_000_000n;
  const nanos = (offsetMs: number) => (startedAt + BigInt(offsetMs) * 1_000_000n).toString();

  await engine.json(
    "/api/v1/ingest/traces",
    post({
      name: "parity-agent",
      span_id: "parity-root",
      session_id: "parity-session",
      input: "where is my order?",
      output: "shipped monday",
      model: "gpt-4o-mini",
      framework: "openai",
      latency_ms: 820,
      input_tokens: 120,
      output_tokens: 35,
      started_at_unix_nano: nanos(0),
      metadata: { promptName: "support", version: "2" },
    })
  );
  await engine.json(
    "/api/v1/ingest/traces",
    post({
      name: "parity-child",
      span_id: "parity-child",
      parent_span_id: "parity-root",
      session_id: "parity-session",
      input: "lookup",
      output: "found",
      started_at_unix_nano: nanos(10),
    })
  );
  await engine.json(
    "/api/v1/ingest/traces",
    post({
      name: "parity-agent",
      span_id: "parity-failure",
      input: "cancel my order",
      output: "",
      error: "ToolTimeout: lookup_order",
      tool_calls: [{ name: "lookup_order", input: { id: 1 }, output: null, success: false }],
      latency_ms: 9100,
      started_at_unix_nano: nanos(20),
    })
  );
  await engine.json(
    "/api/v1/ingest/traces",
    post({
      name: "parity-agent",
      span_id: "parity-pii",
      input: "who owns this?",
      output: "email dana.reed@example.com",
      latency_ms: 300,
      started_at_unix_nano: nanos(30),
    })
  );

  await engine.json(
    "/api/v1/agent-monitoring/patterns",
    post({ name: "parity-pattern", detectorKind: "regex", regex: "banana", severity: "medium", matchTarget: ["response"] })
  );

  const dataset = await engine.json(
    "/api/v1/custom-agent-evaluations/datasets",
    post({
      name: "parity-dataset",
      jaccardSimilarity: { enabled: true },
      rougeScore: { enabled: true },
      questions: [{ main_question: { question: "how long to return?", expectedResults: "30 days from delivery." } }],
    })
  );
  const datasetId = (dataset.body as { _id?: string; id?: string })._id ?? (dataset.body as { id: string }).id;

  const run = await engine.json("/api/v1/custom-agent-evaluations/runs", post({ datasetId, runSource: "sdk" }));
  const runId = (run.body as { runId: string }).runId;
  await engine.json(
    `/api/v1/custom-agent-evaluations/runs/${runId}/results`,
    post({
      batchId: "parity-batch",
      results: [
        {
          idempotencyKey: "parity-case-0",
          questionIndex: 0,
          runNumber: 1,
          input: { query: "how long to return?" },
          output: { text: "You have 30 days from delivery." },
          timings: { latencyMs: 500, inputTokens: 20, outputTokens: 10 },
        },
      ],
    })
  );
  await engine.json(`/api/v1/custom-agent-evaluations/runs/${runId}/finalize`, { method: "POST" });

  // The background monitor passes are detached from the response; give them a moment to land so
  // the signal-shaped reads below have something to compare.
  await new Promise(r => setTimeout(r, 2_000));
  return { datasetId, runId };
}

// Read endpoints whose answers must be identical on both backends.
const PARITY_READS = [
  "/api/v1/ingest/traces?limit=50",
  "/api/v1/ingest/sessions/parity-session/spans",
  "/api/v1/agents",
  "/api/v1/agent-monitoring/signals?limit=50",
  "/api/v1/agent-monitoring/patterns",
  "/api/v1/agent-monitoring/kpis?window=7d",
  "/api/v1/agent-monitoring/performance",
  "/api/v1/agent-monitoring/top-failing",
  "/api/v1/agent-monitoring/sessions",
  "/api/v1/agent-monitoring/model-comparison",
  "/api/v1/agent-monitoring/calibration",
  "/api/v1/agent-monitoring/portability/models/unpriced",
  "/api/v1/custom-agent-evaluations/datasets",
  "/api/v1/custom-agent-evaluations/runs",
  "/api/v1/evaluate/list",
  "/api/v1/evaluate/prompts",
  "/api/v1/evaluate/tool-schemas",
  "/api/v1/evaluate/improve/inbox",
  "/api/v1/evaluate/ci/gates",
];

describe.skipIf(!postgresAvailable)("SQLite / Postgres parity", () => {
  let sqlite: TestEngine;
  let postgres: TestEngine;
  let sqliteIds: { datasetId: string; runId: string };
  let postgresIds: { datasetId: string; runId: string };

  beforeAll(async () => {
    [sqlite, postgres] = await Promise.all([startEngine(), startEngine({}, { postgres: true })]);
    [sqliteIds, postgresIds] = await Promise.all([runScenario(sqlite), runScenario(postgres)]);
  }, 240_000);

  afterAll(async () => {
    await sqlite?.stop();
    await postgres?.stop();
  });

  it("boots on Postgres and hands out a working API key", () => {
    expect(postgres.backend).toBe("postgres");
    expect(postgres.apiKey).toMatch(/^agtx_local_/);
    expect(postgres.alive(), postgres.log().slice(-3000)).toBe(true);
  });

  for (const path of PARITY_READS) {
    it(`answers ${path} identically on both backends`, async () => {
      const [fromSqlite, fromPostgres] = await Promise.all([sqlite.json(path), postgres.json(path)]);
      expect(fromPostgres.status, `${path} status`).toBe(fromSqlite.status);
      expect(normalize(fromPostgres.body), `${path} body`).toEqual(normalize(fromSqlite.body));
    });
  }

  it("serves the same run detail on both backends", async () => {
    const [fromSqlite, fromPostgres] = await Promise.all([
      sqlite.json(`/api/v1/evaluate/${sqliteIds.runId}`),
      postgres.json(`/api/v1/evaluate/${postgresIds.runId}`),
    ]);
    expect(fromPostgres.status).toBe(fromSqlite.status);
    expect(normalize(fromPostgres.body)).toEqual(normalize(fromSqlite.body));
  });

  it("serves the same dataset detail on both backends", async () => {
    const [fromSqlite, fromPostgres] = await Promise.all([
      sqlite.json(`/api/v1/custom-agent-evaluations/datasets/${sqliteIds.datasetId}`),
      postgres.json(`/api/v1/custom-agent-evaluations/datasets/${postgresIds.datasetId}`),
    ]);
    expect(normalize(fromPostgres.body)).toEqual(normalize(fromSqlite.body));
  });

  it("preserves a backdated started_at_unix_nano identically", async () => {
    const read = async (engine: TestEngine) => {
      const spans = await engine.json("/api/v1/ingest/sessions/parity-session/spans");
      return ((spans.body as { spans: { name: string; startedAt?: string | null }[] }).spans ?? [])
        .map(s => [s.name, s.startedAt] as const)
        .sort();
    };
    const [a, b] = await Promise.all([read(sqlite), read(postgres)]);
    expect(b).toEqual(a);
    // And the backdate actually survived rather than being replaced with "now".
    expect(JSON.stringify(a)).toContain("2025-");
  });

  it("logs no unhandled rejection on either backend", () => {
    expect(sqlite.log()).not.toContain("Unhandled promise rejection");
    expect(postgres.log(), postgres.log().slice(-3000)).not.toContain("Unhandled promise rejection");
    expect(postgres.log()).not.toContain("Unhandled error in");
  });
});

describe.skipIf(!postgresAvailable)("Postgres-specific behaviour", () => {
  let engine: TestEngine;

  beforeAll(async () => {
    engine = await startEngine({}, { postgres: true });
  }, 120_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("survives the same malformed input that used to kill the SQLite build", async () => {
    for (const body of [
      { name: "n", started_at_unix_nano: "yesterday", input: "q", output: "a" },
      { name: "n", started_at_unix_nano: "9".repeat(30), input: "q", output: "a" },
    ]) {
      const res = await engine.json("/api/v1/ingest/traces", post(body));
      expect(res.status).toBeLessThan(500);
    }
    await new Promise(r => setTimeout(r, 300));
    expect(engine.alive(), engine.log().slice(-3000)).toBe(true);
  }, 60_000);

  it("stores every trace from a parallel burst exactly once", async () => {
    const count = 40;
    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.json("/api/v1/ingest/traces", post({ name: "pg-burst", span_id: `pg-burst-${i}`, session_id: "pg-burst", input: "q", output: "a" }))
      )
    );
    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(new Set(responses.map(r => (r.body as { trace_id: string }).trace_id)).size).toBe(count);
    const spans = await engine.json("/api/v1/ingest/sessions/pg-burst/spans");
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(count);
  }, 90_000);

  it("dedupes a span replayed sequentially", async () => {
    const body = { name: "pg-sequential", span_id: "pg-seq", session_id: "pg-seq-session", input: "q", output: "a" };
    const first = await engine.json("/api/v1/ingest/traces", post(body));
    const second = await engine.json("/api/v1/ingest/traces", post(body));
    expect((second.body as { trace_id: string }).trace_id).toBe((first.body as { trace_id: string }).trace_id);
    const spans = await engine.json("/api/v1/ingest/sessions/pg-seq-session/spans");
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(1);
  }, 60_000);

  it("dedupes a span replayed concurrently to a single row", async () => {
    // The replay this guards against - an OTel exporter retry, an SDK re-send - does not politely
    // wait for the first attempt to finish. ingestTrace's SELECT-then-INSERT is only atomic
    // because better-sqlite3 is synchronous; on Postgres every query really yields, so all ten
    // requests pass the existence check before any of them inserts.
    const body = { name: "pg-racer", span_id: "pg-raced", session_id: "pg-race", input: "q", output: "a" };
    const responses = await Promise.all(Array.from({ length: 10 }, () => engine.json("/api/v1/ingest/traces", post(body))));
    const spans = await engine.json("/api/v1/ingest/sessions/pg-race/spans");
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(1);
    // And every caller must have been told the same trace id, whichever one won.
    expect(new Set(responses.map(r => (r.body as { trace_id: string }).trace_id)).size).toBe(1);
  }, 60_000);

  it("issues distinct prompt version numbers for simultaneous publishes", async () => {
    // Version numbers are derived (read currentVersion, add one), which is the same
    // read-then-write shape span dedup had. On SQLite it holds because better-sqlite3 never
    // interleaves; here it is a genuine race, and a reused version number would either collide
    // with the unique index (a raw 500 and a lost edit) or silently overwrite a version.
    const created = await engine.json(
      "/api/v1/evaluate/prompts",
      post({ name: "pg-raced-prompt", text: "v1", description: "d" })
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const promptId = (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => engine.json(`/api/v1/evaluate/prompts/${promptId}/versions`, post({ text: `concurrent ${i}` })))
    );

    const versions = responses.filter(r => r.status === 201).map(r => (r.body as { version: number }).version);
    expect(new Set(versions).size, `duplicate version numbers issued: ${versions.join(", ")}`).toBe(versions.length);
    for (const failed of responses.filter(r => r.status !== 201)) {
      expect(failed.status, `a losing publish returned a server error: ${JSON.stringify(failed.body)}`).toBeLessThan(500);
    }

    const detail = await engine.json(`/api/v1/evaluate/prompts/${promptId}`);
    const record = detail.body as { currentVersion: number; versions?: { version: number }[] };
    const historyMax = Math.max(...(record.versions ?? []).map(v => v.version), 1);
    expect(record.currentVersion, "currentVersion drifted away from the stored history").toBe(historyMax);
  }, 60_000);

  it("issues distinct tool-schema version numbers for simultaneous publishes", async () => {
    // The sibling registry to prompts, and the one that had no unique index at all - so before
    // that index existed this produced several rows all claiming the same version, with no error
    // anywhere. Asserted through the stored history, not just the responses.
    const definition = (extra: string) =>
      JSON.stringify({ name: "pg_raced_tool", description: extra, parameters: { type: "object", properties: {} } });

    const created = await engine.json(
      "/api/v1/evaluate/tool-schemas",
      post({ name: "pg_raced_tool", definition: definition("v1") })
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const toolId = (created.body as { _id?: string; id?: string })._id ?? (created.body as { id: string }).id;

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        engine.json(`/api/v1/evaluate/tool-schemas/${toolId}/versions`, post({ definition: definition(`concurrent ${i}`) }))
      )
    );
    for (const failed of responses.filter(r => r.status !== 201)) {
      expect(failed.status, `a losing publish returned a server error: ${JSON.stringify(failed.body)}`).toBeLessThan(500);
    }

    const detail = await engine.json(`/api/v1/evaluate/tool-schemas/${toolId}`);
    const record = detail.body as { currentVersion: number; versions?: { version: number }[] };
    const stored = (record.versions ?? []).map(v => v.version);
    expect(new Set(stored).size, `the stored history has repeated version numbers: ${stored.join(", ")}`).toBe(stored.length);
    expect(record.currentVersion, "currentVersion drifted away from the stored history").toBe(Math.max(...stored, 1));
  }, 60_000);

  it("counts every simultaneous detection into one signal, losing none", async () => {
    // Detection runs in detached post-ingest work, so a burst of failing traces all reach
    // upsertSignal having seen no existing signal row. Before this was made atomic, one insert
    // violated monitor_signals_pattern_key_agent_id and that trace's detection was dropped with
    // only a log line, while the survivors each wrote back a count they had read a moment
    // earlier - twelve detections were reported as five.
    const count = 12;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.json("/api/v1/ingest/traces", post({ name: "pg-signal-agent", span_id: `pg-sig-${i}`, input: "q", output: "", error: "Boom" }))
      )
    );

    const deadline = Date.now() + 30_000;
    let rows: { patternKey?: string; occurrenceCount?: number }[] = [];
    while (Date.now() < deadline) {
      const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100&polarity=all");
      rows = ((res.body as { signals?: { patternKey?: string; occurrenceCount?: number }[] }).signals ?? []).filter(
        s => s.patternKey === "agent-trace-error"
      );
      if (rows[0] && (rows[0].occurrenceCount ?? 0) >= count) break;
      await new Promise(r => setTimeout(r, 250));
    }

    expect(rows, "the burst produced more than one signal row for one pattern and agent").toHaveLength(1);
    expect(rows[0]!.occurrenceCount, `${count} detections were counted as ${rows[0]?.occurrenceCount}`).toBe(count);
    expect(engine.log(), "a detection was dropped rather than counted").not.toContain("Monitor check failed");
  }, 90_000);

  it("registers one agent for a burst of first-ever traces sharing a name", async () => {
    const name = `pg-first-sighting-${Math.random().toString(36).slice(2, 8)}`;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        engine.json("/api/v1/ingest/traces", post({ name, span_id: `${name}-${i}`, input: "q", output: "a" }))
      )
    );
    const agents = await engine.json("/api/v1/agents");
    const matching = ((agents.body as { agents: { name: string }[] }).agents ?? []).filter(a => a.name === name);
    expect(matching).toHaveLength(1);
  }, 60_000);
});
