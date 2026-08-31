import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// P2.1 bulk export: the buyer's "can I get my data OUT" question. The contract under test:
// every registered entity streams project-scoped NDJSON, `since` filters incrementally, another
// project's key never sees the rows, and an exported traces file can be REPLAYED through
// /ingest into a fresh project with matching counts (the documented restore path).

let engine: TestEngine;
let keyA: string;
let keyB: string;

const ndjson = async (path: string, apiKey: string): Promise<Record<string, unknown>[]> => {
  const res = await engine.request(path, { apiKey });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const text = await res.text();
  return text
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
};

beforeAll(async () => {
  engine = await startEngine();
  keyA = engine.apiKey;
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "Export bystander" }), apiKey: null });
  keyB = (created.body as { project: { apiKey: string } }).project.apiKey;

  // Seed a small, mixed dataset in project A: traces (with session/spans), feedback, an outcome.
  for (let i = 0; i < 7; i++) {
    const ingested = await engine.json("/api/v1/ingest/traces", {
      ...postJson({
        name: "export-agent",
        input: { q: `question-${i}` },
        output: `answer-${i}`,
        session_id: "export-session",
        span_id: `export-span-${i}`,
        metadata: { batch: "export-test" },
      }),
      apiKey: keyA,
    });
    expect(ingested.status).toBe(200);
    const traceId = (ingested.body as { trace_id: string }).trace_id;
    if (i === 0) {
      const fb = await engine.json("/api/v1/feedback", {
        ...postJson({ traceId, rating: "down", comment: "wrong answer", endUserId: "u-1" }),
        apiKey: keyA,
      });
      expect([200, 201]).toContain(fb.status);
      const oc = await engine.json("/api/v1/outcomes", {
        ...postJson({ traceId, outcome: "confirmed_bad", isNegative: true, reportedBy: "test" }),
        apiKey: keyA,
      });
      expect([200, 201]).toContain(oc.status);
    }
  }
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("export manifest", () => {
  it("lists every entity with live row counts", async () => {
    const res = await engine.json("/api/v1/export", { apiKey: keyA });
    expect(res.status).toBe(200);
    const body = res.body as { format: string; entities: { entity: string; rows: number }[] };
    expect(body.format).toBe("ndjson");
    const byName = Object.fromEntries(body.entities.map(e => [e.entity, e.rows]));
    // 7 ingested + the fresh project's seed traces; at least our 7 exist.
    expect(byName.traces).toBeGreaterThanOrEqual(7);
    expect(byName.feedback).toBeGreaterThanOrEqual(1);
    expect(byName.outcomes).toBeGreaterThanOrEqual(1);
    expect(Object.keys(byName)).toContain("signals");
    expect(Object.keys(byName)).toContain("custom-evaluators");
  });

  it("every registered entity answers 200 (a schema drift 500s, not skips)", async () => {
    // Regression: evaluation-analyses keys on evaluationId, not id - the generic `asc(t.id)`
    // rendered a bare `asc` identifier into the SQL and 500'd (caught live by the UC8 drill).
    const manifest = await engine.json("/api/v1/export", { apiKey: keyA });
    const entities = (manifest.body as { entities: { entity: string }[] }).entities.map(e => e.entity);
    for (const entity of entities) {
      const res = await engine.request(`/api/v1/export/${entity}`, { apiKey: keyA });
      expect(res.status, entity).toBe(200);
    }
  });

  it("401s without a key and 404s an unknown entity", async () => {
    expect((await engine.json("/api/v1/export", { apiKey: null })).status).toBe(401);
    const bad = await engine.json("/api/v1/export/nonsense", { apiKey: keyA });
    expect(bad.status).toBe(404);
    expect((bad.body as { entities: string[] }).entities).toContain("traces");
  });
});

describe("NDJSON streaming", () => {
  it("streams full stored rows, project-scoped", async () => {
    const rowsA = await ndjson("/api/v1/export/traces", keyA);
    const ours = rowsA.filter(r => r.name === "export-agent");
    expect(ours.length).toBe(7);
    // Full stored shape, not a summary: json fields and timestamps survive.
    expect(ours[0]).toHaveProperty("id");
    expect(ours[0]).toHaveProperty("createdAt");
    expect(ours.some(r => JSON.stringify(r.metadata).includes("export-test"))).toBe(true);

    // Project B's key must not see project A's rows.
    const rowsB = await ndjson("/api/v1/export/traces", keyB);
    expect(rowsB.filter(r => r.name === "export-agent").length).toBe(0);
  });

  it("filters incrementally with ?since=", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows = await ndjson(`/api/v1/export/traces?since=${encodeURIComponent(future)}`, keyA);
    expect(rows.length).toBe(0);
    const bad = await engine.json("/api/v1/export/traces?since=not-a-date", { apiKey: keyA });
    expect(bad.status).toBe(400);
  });

  it("exports feedback and outcomes rows with their content intact", async () => {
    const feedback = await ndjson("/api/v1/export/feedback", keyA);
    expect(feedback.some(r => r.comment === "wrong answer")).toBe(true);
    const outcomes = await ndjson("/api/v1/export/outcomes", keyA);
    expect(outcomes.some(r => r.outcome === "confirmed_bad")).toBe(true);
  });
});

describe("round trip (the documented replay restore)", () => {
  it("replays an exported traces file into a fresh project with matching counts", async () => {
    const exported = (await ndjson("/api/v1/export/traces", keyA)).filter(r => r.name === "export-agent");
    expect(exported.length).toBe(7);

    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "Export restore target" }), apiKey: null });
    const keyC = (created.body as { project: { apiKey: string } }).project.apiKey;

    for (const row of exported) {
      const replayed = await engine.json("/api/v1/ingest/traces", {
        ...postJson({
          name: row.name,
          input: row.input,
          output: row.output,
          ...(row.error ? { error: row.error } : {}),
          ...(row.latencyMs != null ? { latency_ms: row.latencyMs } : {}),
          ...(row.sessionId ? { session_id: row.sessionId } : {}),
          ...(row.spanId ? { span_id: row.spanId } : {}),
          ...(row.metadata ? { metadata: row.metadata } : {}),
        }),
        apiKey: keyC,
      });
      expect(replayed.status).toBe(200);
    }

    const restored = (await ndjson("/api/v1/export/traces", keyC)).filter(r => r.name === "export-agent");
    expect(restored.length).toBe(exported.length);
    expect(new Set(restored.map(r => JSON.stringify(r.output)))).toEqual(
      new Set(exported.map(r => JSON.stringify(r.output)))
    );
  });
});
