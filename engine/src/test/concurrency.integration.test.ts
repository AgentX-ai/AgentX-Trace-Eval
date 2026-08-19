import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// SQLite is one writer at a time. The SDK's default ingest path is fire-and-forget from many
// worker threads, and every ingest also kicks off detached monitor/evaluator writes, so
// "several traces land at the same millisecond" is the normal case, not the stress case.
// SQLITE_BUSY surfacing from a detached write is exactly the shape that used to end the process.

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("concurrent ingestion", () => {
  it("stores every trace from a 60-way parallel burst exactly once", async () => {
    const count = 60;
    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.json(
          "/api/v1/ingest/traces",
          post({ name: "burst-agent", span_id: `burst-${i}`, input: `q${i}`, output: `a${i}`, session_id: "burst-session" })
        )
      )
    );

    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const ids = responses.map(r => (r.body as { trace_id: string }).trace_id);
    expect(new Set(ids).size).toBe(count);

    const spans = await engine.json("/api/v1/ingest/sessions/burst-session/spans");
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(count);
    expect(engine.alive(), engine.log().slice(-4000)).toBe(true);
  }, 60_000);

  it("dedupes a span replayed concurrently to a single row", async () => {
    const body = { name: "racer", span_id: "raced-span", input: "q", output: "a", session_id: "race-session" };
    const responses = await Promise.all(Array.from({ length: 10 }, () => engine.json("/api/v1/ingest/traces", post(body))));
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    const spans = await engine.json("/api/v1/ingest/sessions/race-session/spans");
    expect((spans.body as { spans: unknown[] }).spans).toHaveLength(1);
  }, 60_000);

  it("keeps serving reads while a write burst is in flight", async () => {
    const writes = Array.from({ length: 30 }, (_, i) =>
      engine.json("/api/v1/ingest/traces", post({ name: "mixed", span_id: `mixed-${i}`, input: "q", output: "a" }))
    );
    const reads = Array.from({ length: 30 }, () => engine.json("/api/v1/ingest/traces?limit=20"));
    const results = await Promise.all([...writes, ...reads]);
    for (const res of results) {
      expect(res.status).toBeLessThan(500);
    }
    expect(engine.alive(), engine.log().slice(-4000)).toBe(true);
  }, 60_000);

  it("logs no unhandled rejection during the burst", async () => {
    expect(engine.log()).not.toContain("Unhandled promise rejection");
    expect(engine.log()).not.toContain("Unhandled error in");
  });
});
