import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Sessions is Observe's conversation-level view: one row per session_id, assembled in JS from the
// trace rows. Its counting rules are specific and easy to get subtly wrong - turns are root spans
// only, active time is the sum of root latencies rather than wall-clock (a conversation resumed
// the next day is not a day long), and the agent name comes from roots so this table and Live
// Traces never disagree. All of it is silent when wrong.

let engine: TestEngine;
let key: string;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

// Anchored a minute in the past rather than at a fixed epoch: listSessions windows on the traces'
// own createdAt, which a backdated started_at_unix_nano sets (deliberately - a backfilled trace
// belongs to when the traffic happened), so a hard-coded base would drop out of every window as
// soon as it aged.
const BASE_MS = Date.now() - 60_000;
const nanos = (offsetMs: number) => (BigInt(BASE_MS + offsetMs) * 1_000_000n).toString();

async function ingest(body: Record<string, unknown>) {
  const res = await engine.json("/api/v1/ingest/traces", post(body, key));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { trace_id: string }).trace_id;
}

type SessionSummary = {
  sessionId: string;
  agentName: string | null;
  turnCount: number;
  spanCount: number;
  errorCount: number;
  totalLatencyMs: number;
  firstAt: string;
  lastAt: string;
  judgeRating: number | null;
  judgeName: string | null;
  judges: { name: string; rating: number }[];
};

async function sessions(window = "7d"): Promise<SessionSummary[]> {
  const res = await engine.json(`/api/v1/agent-monitoring/sessions?window=${window}`, { apiKey: key });
  expect(res.status).toBe(200);
  return (res.body as { sessions: SessionSummary[] }).sessions;
}

const find = (list: SessionSummary[], id: string) => list.find(s => s.sessionId === id);

beforeAll(async () => {
  engine = await startEngine();
  const project = await engine.json("/api/v1/projects", post({ name: "Sessions project" }, null));
  expect(project.status).toBe(201);
  key = (project.body as { project: { apiKey: string } }).project.apiKey;

  // A three-turn conversation, where the middle turn ran a child span and the last one errored.
  await ingest({ name: "session-agent", span_id: "s1-t1", session_id: "conv-1", input: "hi", output: "hello", latency_ms: 100, started_at_unix_nano: nanos(0) });
  await ingest({ name: "session-agent", span_id: "s1-t2", session_id: "conv-1", input: "and then?", output: "then this", latency_ms: 200, started_at_unix_nano: nanos(1_000) });
  await ingest({
    name: "tool-step",
    span_id: "s1-t2-child",
    parent_span_id: "s1-t2",
    session_id: "conv-1",
    input: "lookup",
    output: "found",
    latency_ms: 5_000,
    started_at_unix_nano: nanos(1_100),
  });
  await ingest({ name: "session-agent", span_id: "s1-t3", session_id: "conv-1", input: "thanks", output: "", error: "Timeout", latency_ms: 300, started_at_unix_nano: nanos(2_000) });

  // A second, later conversation with a single turn.
  await ingest({ name: "other-agent", span_id: "s2-t1", session_id: "conv-2", input: "one shot", output: "done", latency_ms: 50, started_at_unix_nano: nanos(9_000) });

  // And a trace with no session at all, which must not appear as a session.
  await ingest({ name: "session-agent", span_id: "loner", input: "no session", output: "ok", latency_ms: 10 });
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("session listing", () => {
  it("counts turns from root spans and spans from everything", async () => {
    const conv = find(await sessions(), "conv-1")!;
    expect(conv, "conv-1 missing from the sessions list").toBeTruthy();
    expect(conv.turnCount, "a child span was counted as its own turn").toBe(3);
    expect(conv.spanCount).toBe(4);
  });

  it("sums active time from root latencies only, not wall clock and not child spans", async () => {
    const conv = find(await sessions(), "conv-1")!;
    // 100 + 200 + 300; the child span's 5000ms happened inside turn 2 and is not extra time.
    expect(conv.totalLatencyMs).toBe(600);
  });

  it("counts an error on any span in the conversation", async () => {
    expect(find(await sessions(), "conv-1")!.errorCount).toBe(1);
  });

  it("takes the agent from a root span, so this table agrees with Live Traces", async () => {
    const conv = find(await sessions(), "conv-1")!;
    expect(conv.agentName, "a child span's step label was used as the session's agent").toBe("session-agent");
  });

  it("spans first and last activity across the whole conversation", async () => {
    const conv = find(await sessions(), "conv-1")!;
    expect(new Date(conv.firstAt).getTime()).toBeLessThan(new Date(conv.lastAt).getTime());
    // The timestamps come from the traces' own started_at, not from when they were ingested: the
    // first turn is pinned a minute before this test ran, so it predates the ingest itself.
    expect(new Date(conv.firstAt).getTime()).toBe(BASE_MS);
  });

  it("excludes traces that carry no session id", async () => {
    const list = await sessions();
    expect(list.some(s => s.sessionId === "null" || s.sessionId === null)).toBe(false);
    expect(list.map(s => s.sessionId).sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("orders the most recently active conversation first", async () => {
    const list = await sessions();
    expect(list[0]!.sessionId).toBe("conv-2");
  });

  it("reports no judge score until a session judge has actually run", async () => {
    const conv = find(await sessions(), "conv-1")!;
    expect(conv.judgeRating).toBeNull();
    expect(conv.judgeName).toBeNull();
    expect(conv.judges).toEqual([]);
  });

  it("serves the same conversation's spans through the trace-detail route", async () => {
    const res = await engine.json("/api/v1/ingest/sessions/conv-1/spans", { apiKey: key });
    expect(res.status).toBe(200);
    expect((res.body as { spans: unknown[] }).spans).toHaveLength(4);
  });

  it("answers every window without changing what a session means", async () => {
    for (const window of ["24h", "7d", "30d"]) {
      const list = await sessions(window);
      const conv = find(list, "conv-1");
      expect(conv, `conv-1 missing for window=${window}`).toBeTruthy();
      expect(conv!.turnCount).toBe(3);
    }
  });

  it("keeps another project's conversations out of the list", async () => {
    const other = await engine.json("/api/v1/projects", post({ name: "Other sessions project" }, null));
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const res = await engine.json("/api/v1/agent-monitoring/sessions", { apiKey: otherKey });
    expect((res.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("serves per-session scores for a session nothing has judged yet", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/sessions/conv-1/scores", { apiKey: key });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("undefined");
  });

  it("does not invent a session for an id that has never been seen", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/sessions/no-such-session/scores", { apiKey: key });
    expect(res.status).toBeLessThan(500);
    expect(find(await sessions(), "no-such-session")).toBeUndefined();
  });
});
