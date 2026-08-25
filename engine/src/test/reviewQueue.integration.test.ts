import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The human-review queue: traces that raised NO signal but still want a verdict. Pinned here -
// queueing carries the trace's evidence, duplicates and a full queue are refused loudly (never a
// silent success), labels land with a corrected score, and a labeled row feeds judge calibration
// as a real agreement pair.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

const patch = (body: unknown) => ({
  method: "PATCH",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

type QueueWire = {
  items: {
    _id: string;
    traceId: string;
    source: string;
    status: string;
    label?: string;
    correctedScore: number | null;
    judgeScoreAtQueue: number | null;
    trace: { agentName?: string; query: string; responsePreview: string } | null;
  }[];
  pending: number;
  cap: number;
};

async function ingest(name: string, spanId: string, output = "sure thing"): Promise<string> {
  const res = await api("/ingest/traces", postJson({ name, input: "how do I reset my password?", output, span_id: spanId }));
  return (res.body as { traceId: string }).traceId;
}

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "review-queue" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("review queue", () => {
  it("queues a signal-less trace with its evidence, and refuses a duplicate", async () => {
    const traceId = await ingest("support-agent", "rq-1");
    const queued = await api("/agent-monitoring/review-queue", postJson({ traceId, note: "spot check" }));
    expect(queued.status).toBe(201);

    const list = (await api("/agent-monitoring/review-queue")).body as QueueWire;
    expect(list.pending).toBe(1);
    const item = list.items.find(i => i.traceId === traceId)!;
    expect(item.source).toBe("manual");
    expect(item.status).toBe("pending");
    // The reviewer needs the trace inline - no N+1 fetch per row.
    expect(item.trace?.agentName).toBe("support-agent");
    expect(item.trace?.query).toContain("reset my password");
    expect(item.trace?.responsePreview).toContain("sure thing");

    const again = await api("/agent-monitoring/review-queue", postJson({ traceId }));
    expect(again.status).toBe(409);
    expect((again.body as { reason: string }).reason).toBe("already_queued");

    const missing = await api("/agent-monitoring/review-queue", postJson({ traceId: "nope" }));
    expect(missing.status).toBe(404);
  });

  it("records a good/bad label with an optional corrected score", async () => {
    const traceId = await ingest("billing-agent", "rq-2", "I cannot help with that.");
    const queued = await api("/agent-monitoring/review-queue", postJson({ traceId }));
    const id = (queued.body as { item: { _id: string } }).item._id;

    const labeled = await api(`/agent-monitoring/review-queue/${id}`, patch({ label: "bad", correctedScore: 2, note: "refused a normal request" }));
    expect(labeled.status).toBe(200);
    const item = (labeled.body as { item: QueueWire["items"][number] }).item;
    expect(item.label).toBe("bad");
    expect(item.status).toBe("labeled");
    expect(item.correctedScore).toBe(2);

    // Labeled rows leave the pending count.
    const pendingOnly = (await api("/agent-monitoring/review-queue?status=pending")).body as QueueWire;
    expect(pendingOnly.items.some(i => i._id === id)).toBe(false);

    // Out-of-range corrections are rejected by the schema, not silently clamped.
    const bad = await api(`/agent-monitoring/review-queue/${id}`, patch({ correctedScore: 42 }));
    expect(bad.status).toBe(400);
  });

  it("dismissing removes the item; unknown ids 404", async () => {
    const traceId = await ingest("support-agent", "rq-3");
    const queued = await api("/agent-monitoring/review-queue", postJson({ traceId }));
    const id = (queued.body as { item: { _id: string } }).item._id;
    const gone = await engine.request(`/api/v1/agent-monitoring/review-queue/${id}`, { method: "DELETE", apiKey: key });
    expect(gone.status).toBe(204);
    const after = (await api("/agent-monitoring/review-queue")).body as QueueWire;
    expect(after.items.some(i => i._id === id)).toBe(false);
    const missing = await engine.request("/api/v1/agent-monitoring/review-queue/nope", { method: "DELETE", apiKey: key });
    expect(missing.status).toBe(404);
  });

  it("a labeled item counts toward judge calibration", async () => {
    const before = (await api("/agent-monitoring/calibration?window=7d")).body as { reviewLabelCount: number };
    const traceId = await ingest("support-agent", "rq-4");
    const queued = await api("/agent-monitoring/review-queue", postJson({ traceId }));
    const id = (queued.body as { item: { _id: string } }).item._id;
    await api(`/agent-monitoring/review-queue/${id}`, patch({ label: "good" }));
    const after = (await api("/agent-monitoring/calibration?window=7d")).body as { reviewLabelCount: number };
    expect(after.reviewLabelCount).toBe(before.reviewLabelCount + 1);
  });

  it("is included in backups", async () => {
    const manifest = await api("/export");
    expect(manifest.status).toBe(200);
    const entry = (manifest.body as { entities: { entity: string; rows: number }[] }).entities.find(
      e => e.entity === "review-queue"
    );
    expect(entry, "review-queue must be a backed-up entity - a labeled corpus is real work").toBeDefined();
    expect(entry!.rows).toBeGreaterThan(0);
    // And the rows actually stream (NDJSON body, one row per line).
    const dump = await engine.request("/api/v1/export/review-queue", { apiKey: key });
    expect(dump.status).toBe(200);
    expect(await dump.text()).toContain('"traceId"');
  });
});
