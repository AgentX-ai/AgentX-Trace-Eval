import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Phase-2 ingest discipline (ADR-0005), pinned end to end against a real engine:
//   - the ack means durably stored (read-your-writes: list immediately after the 200)
//   - a full queue answers 429 with Retry-After, never a silent drop
//   - oversized payload fields are truncated with an explicit marker
//   - a burst of concurrent requests coalesces into shared micro-batches and all lands

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

describe("ingest queue", () => {
  beforeAll(async () => {
    engine = await startEngine({
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      AGENTX_INGEST_MAX_FIELD_CHARS: "2000",
    });
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "ingest-queue" }), apiKey: null });
    key = (created.body as { project: { apiKey: string } }).project.apiKey;
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("acks mean durably stored: the trace lists immediately after the 200", async () => {
    const r = await api("/ingest/traces", postJson({ name: "ryw-agent", input: "q", output: "a" }));
    expect(r.status).toBe(200);
    const id = (r.body as { traceId: string }).traceId;
    const list = await api("/ingest/traces");
    const ids = ((list.body as { traces: { _id: string }[] }).traces ?? []).map(t => t._id);
    expect(ids).toContain(id);
  });

  it("a concurrent burst coalesces and every span lands exactly once", async () => {
    const burst = 40;
    const results = await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        api("/ingest/traces", postJson({ name: "burst-agent", input: `q${i}`, output: `a${i}`, span_id: `burst-${i}` }))
      )
    );
    expect(results.every(r => r.status === 200)).toBe(true);
    // Replaying the whole burst dedupes every span.
    const replays = await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        api("/ingest/traces", postJson({ name: "burst-agent", input: `q${i}`, output: `a${i}`, span_id: `burst-${i}` }))
      )
    );
    expect(replays.every(r => (r.body as { deduped: boolean }).deduped)).toBe(true);
    const list = await api("/ingest/traces?limit=100&search=burst-agent");
    expect((list.body as { traces: unknown[] }).traces.length).toBe(burst);
  });

  it("oversized fields are truncated with an explicit marker, not stored unbounded", async () => {
    const huge = "x".repeat(50_000);
    const r = await api("/ingest/traces", postJson({ name: "big-agent", input: "q", output: huge }));
    expect(r.status).toBe(200);
    const id = (r.body as { traceId: string }).traceId;
    const detail = await api(`/ingest/traces/${id}`);
    const output = String((detail.body as { output: unknown }).output);
    expect(output.length).toBeLessThan(3_000);
    expect(output).toContain("agentx.truncated");
  });

  it("a full queue answers 429 with Retry-After instead of dropping silently", async () => {
    // A second engine with a tiny queue and a slow flush so the bound is actually reachable.
    const tiny = await startEngine({
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      AGENTX_INGEST_FLUSH_MS: "1500",
      AGENTX_INGEST_FLUSH_SIZE: "1000",
      AGENTX_INGEST_QUEUE_MAX: "2",
    });
    try {
      const created = await tiny.json("/api/v1/projects", { ...postJson({ name: "tiny-queue" }), apiKey: null });
      const tinyKey = (created.body as { project: { apiKey: string } }).project.apiKey;
      const burst = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          tiny.request(`/api/v1/ingest/traces`, {
            ...postJson({ name: "flood", input: `q${i}`, output: `a${i}` }),
            apiKey: tinyKey,
          })
        )
      );
      const ok = burst.filter(r => r.status === 200);
      const shed = burst.filter(r => r.status === 429);
      expect(ok.length + shed.length).toBe(8);
      expect(shed.length).toBeGreaterThan(0);
      expect(shed[0]?.headers.get("retry-after")).toBe("1");
      // Everything accepted eventually lands; nothing beyond the accepted set appears.
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const list = await tiny.json("/api/v1/ingest/traces?limit=100", { apiKey: tinyKey });
      expect((list.body as { traces: unknown[] }).traces.length).toBe(ok.length);
    } finally {
      await tiny.stop();
    }
  }, 60_000);
});
