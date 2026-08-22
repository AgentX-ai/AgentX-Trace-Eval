import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enableBuiltinScorers, startEngine, type TestEngine } from "./server.js";

// One signal per (pattern, agent), with the count operators triage by - maintained across
// concurrent detections in detached post-ingest work, which is where the read-modify-write version
// lost updates and, on Postgres, lost whole detections to a unique-index violation.

let engine: TestEngine;
let key: string;

// Signal mechanics are driven by the PII template scorer (enabled per project by newProject via
// enableBuiltinScorers): a deterministic, zero-LLM scorer that raises real Signals. Operational
// outcomes (trace errors, tool failures) no longer raise Signals at all - they classify into KPI
// events only (see detect.ts's classifyOperational) - so the tool-failure test below asserts on
// the events surface (top-failing) instead.
const PII_OUTPUT = "Sure - I sent the receipt to ada.lovelace@example.com a moment ago.";

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

type Signal = {
  _id: string;
  patternKey?: string;
  agentId?: { _id: string; name: string } | string | null;
  occurrenceCount?: number;
  occurrences?: unknown[];
  status?: string;
  summary?: string;
};

async function signals(apiKey = key): Promise<Signal[]> {
  const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100&polarity=all", { apiKey });
  expect(res.status).toBe(200);
  return (res.body as { signals: Signal[] }).signals ?? [];
}

async function waitForCount(apiKey: string, patternKey: string, expected: number, timeoutMs = 25_000): Promise<Signal | undefined> {
  const deadline = Date.now() + timeoutMs;
  let found: Signal | undefined;
  while (Date.now() < deadline) {
    found = (await signals(apiKey)).find(s => s.patternKey === patternKey);
    if (found && (found.occurrenceCount ?? 0) >= expected) return found;
    await new Promise(r => setTimeout(r, 200));
  }
  return found;
}

async function newProject(name: string): Promise<string> {
  const res = await engine.json("/api/v1/projects", post({ name }, null));
  expect(res.status).toBe(201);
  const apiKey = (res.body as { project: { apiKey: string } }).project.apiKey;
  await enableBuiltinScorers(engine, apiKey);
  return apiKey;
}

beforeAll(async () => {
  engine = await startEngine();
  key = await newProject("Signals project");
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("signal deduplication and counting", () => {
  it("folds repeated detections into one signal and counts every one", async () => {
    const projectKey = await newProject("Sequential counting");
    for (let i = 0; i < 5; i++) {
      await engine.json("/api/v1/ingest/traces", post({ name: "repeat-agent", span_id: `rep-${i}`, input: "q", output: PII_OUTPUT }, projectKey));
    }
    const signal = await waitForCount(projectKey, "pii-in-response", 5);
    expect(signal, "no signal was raised at all").toBeTruthy();
    expect(signal!.occurrenceCount, "occurrences were dropped").toBe(5);

    const rows = (await signals(projectKey)).filter(s => s.patternKey === "pii-in-response");
    expect(rows, "the same pattern and agent produced more than one signal row").toHaveLength(1);
  }, 60_000);

  it("counts every detection when they all arrive at once", async () => {
    // The same workload, fired together. On SQLite this serialises; the assertion matters most on
    // Postgres (see the dialect suite), but the contract is the same on both.
    const projectKey = await newProject("Concurrent counting");
    const count = 12;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        engine.json("/api/v1/ingest/traces", post({ name: "burst-agent", span_id: `burst-sig-${i}`, input: "q", output: PII_OUTPUT }, projectKey))
      )
    );

    const signal = await waitForCount(projectKey, "pii-in-response", count);
    expect(signal).toBeTruthy();
    expect(signal!.occurrenceCount, `${count} detections were counted as ${signal!.occurrenceCount}`).toBe(count);
    expect((await signals(projectKey)).filter(s => s.patternKey === "pii-in-response")).toHaveLength(1);
    expect(engine.log()).not.toContain("Monitor check failed");
  }, 90_000);

  it("records one occurrence entry per detection, each pointing at its own trace", async () => {
    const projectKey = await newProject("Occurrence list");
    const traceIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await engine.json("/api/v1/ingest/traces", post({ name: "occ-agent", span_id: `occ-${i}`, input: "q", output: PII_OUTPUT }, projectKey));
      traceIds.push((res.body as { trace_id: string }).trace_id);
    }
    const signal = await waitForCount(projectKey, "pii-in-response", 3);
    const detail = await engine.json(`/api/v1/agent-monitoring/signals/${signal!._id}`, { apiKey: projectKey });
    const occurrences = ((detail.body as { signal?: { occurrences?: { traceId: string }[] } }).signal?.occurrences ??
      (detail.body as { occurrences?: { traceId: string }[] }).occurrences ??
      []) as { traceId: string }[];
    expect(occurrences.length).toBe(3);
    expect(occurrences.map(o => o.traceId).sort()).toEqual([...traceIds].sort());
  }, 60_000);

  it("keeps separate signals for different agents hitting the same pattern", async () => {
    const projectKey = await newProject("Per-agent signals");
    await engine.json("/api/v1/ingest/traces", post({ name: "agent-one", span_id: "a1", input: "q", output: PII_OUTPUT }, projectKey));
    await engine.json("/api/v1/ingest/traces", post({ name: "agent-two", span_id: "a2", input: "q", output: PII_OUTPUT }, projectKey));

    const deadline = Date.now() + 20_000;
    let rows: Signal[] = [];
    while (Date.now() < deadline) {
      rows = (await signals(projectKey)).filter(s => s.patternKey === "pii-in-response");
      if (rows.length >= 2) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(rows, "two agents' failures were folded into one signal").toHaveLength(2);
    for (const row of rows) {
      expect(row.occurrenceCount).toBe(1);
    }
  }, 60_000);

  it("keeps separate signals for different scorers on the same agent", async () => {
    const projectKey = await newProject("Per-pattern signals");
    const first = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "multi-agent", span_id: "m1", input: "q", output: PII_OUTPUT }, projectKey)
    );
    const downvoted = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "multi-agent", span_id: "m2", input: "q", output: "a perfectly clean answer" }, projectKey)
    );
    // The second scorer kind: an end-user downvote raises negative-feedback directly.
    const downRes = await engine.json(
      "/api/v1/feedback",
      post({ traceId: (downvoted.body as { trace_id: string }).trace_id, rating: "down" }, projectKey)
    );
    expect(downRes.status, JSON.stringify(downRes.body)).toBeLessThan(300);
    expect(first.status).toBe(200);

    const deadline = Date.now() + 20_000;
    let keys: string[] = [];
    while (Date.now() < deadline) {
      keys = (await signals(projectKey)).map(s => s.patternKey ?? "");
      if (keys.includes("pii-in-response") && keys.includes("negative-feedback")) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(keys).toContain("pii-in-response");
    expect(keys).toContain("negative-feedback");
  }, 60_000);

  it("names the failing tool in the operational event key, so two broken tools are two entries", async () => {
    // Tool failures are operational outcomes, not scorers: no Signal is raised, but each failure
    // classifies into the KPI events with a per-tool patternKey (the tool-schema evidence loop
    // joins on it), surfaced through top-failing.
    const projectKey = await newProject("Per-tool events");
    for (const tool of ["lookup_order", "cancel_order"]) {
      await engine.json(
        "/api/v1/ingest/traces",
        post({ name: "tool-agent", span_id: `tool-${tool}`, input: "q", output: "sorry", tool_calls: [{ name: tool, success: false }] }, projectKey)
      );
    }
    const deadline = Date.now() + 20_000;
    let keys: string[] = [];
    while (Date.now() < deadline) {
      const res = await engine.json("/api/v1/agent-monitoring/top-failing?window=24h", { apiKey: projectKey });
      keys = ((res.body as { patterns?: { patternKey: string }[] }).patterns ?? [])
        .map(p => p.patternKey)
        .filter(k => k.startsWith("agent-tool-failure"));
      if (keys.length >= 2) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(keys.sort()).toEqual(["agent-tool-failure:cancel_order", "agent-tool-failure:lookup_order"]);
    // And no Signal was raised for them - they are not triage items.
    expect((await signals(projectKey)).filter(s => (s.patternKey ?? "").startsWith("agent-tool-failure"))).toEqual([]);
  }, 60_000);

  it("keeps counting into an existing signal after it has been triaged", async () => {
    const projectKey = await newProject("Triaged counting");
    await engine.json("/api/v1/ingest/traces", post({ name: "triage-agent", span_id: "tr-1", input: "q", output: PII_OUTPUT }, projectKey));
    const signal = await waitForCount(projectKey, "pii-in-response", 1);

    const patched = await engine.json(`/api/v1/agent-monitoring/signals/${signal!._id}`, {
      ...post({ status: "resolved" }, projectKey),
      method: "PATCH",
    });
    expect(patched.status).toBeLessThan(300);

    await engine.json("/api/v1/ingest/traces", post({ name: "triage-agent", span_id: "tr-2", input: "q", output: PII_OUTPUT }, projectKey));
    const after = await waitForCount(projectKey, "pii-in-response", 2);
    expect(after!.occurrenceCount, "a recurrence after triage was not counted").toBe(2);
    expect(after!._id, "a recurrence created a second signal instead of reopening the first").toBe(signal!._id);
  }, 60_000);

  it("keeps one project's signals out of another's list", async () => {
    const projectKey = await newProject("Signal isolation");
    await engine.json("/api/v1/ingest/traces", post({ name: "isolated-agent", span_id: "iso-1", input: "q", output: PII_OUTPUT }, projectKey));
    await waitForCount(projectKey, "pii-in-response", 1);

    const otherKey = await newProject("Signal isolation other");
    expect((await signals(otherKey)).filter(s => JSON.stringify(s).includes("isolated-agent"))).toEqual([]);
  }, 60_000);
});
