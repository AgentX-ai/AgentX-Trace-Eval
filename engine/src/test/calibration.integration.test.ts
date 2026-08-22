import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enableBuiltinScorers, startEngine, type TestEngine } from "./server.js";

// Judge Calibration compares each reported real-world outcome against the verdict AgentX had
// already recorded. A confusion matrix computed the wrong way round outputs a confident percentage
// either way, so this builds one of each cell and checks the arithmetic against it.

let engine: TestEngine;
let key: string;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

async function ingest(body: Record<string, unknown>): Promise<string> {
  const res = await engine.json("/api/v1/ingest/traces", post(body, key));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { trace_id: string }).trace_id;
}

async function reportOutcome(body: Record<string, unknown>) {
  return engine.json("/api/v1/outcomes", post(body, key));
}

async function calibration() {
  const res = await engine.json("/api/v1/agent-monitoring/calibration", { apiKey: key });
  expect(res.status).toBe(200);
  return res.body as {
    reportedCount: number;
    noVerdictCount: number;
    comparedCount: number;
    agreementRate: number | null;
    falsePositiveRate: number | null;
    falseNegativeRate: number | null;
  };
}

/** Waits until the detached monitor pass has recorded an event for this trace. */
async function waitForVerdict(traceId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await engine.json(`/api/v1/agent-monitoring/traces/${traceId}/evaluations`, { apiKey: key });
    if (JSON.stringify(res.body).length > 30) return;
    await new Promise(r => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  engine = await startEngine();
  const project = await engine.json("/api/v1/projects", post({ name: "Calibration project" }, null));
  expect(project.status).toBe(201);
  key = (project.body as { project: { apiKey: string } }).project.apiKey;
  await enableBuiltinScorers(engine, key);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("outcome reporting", () => {
  it("requires an outcome, an explicit isNegative, and something to attach to", async () => {
    expect((await reportOutcome({})).status).toBe(400);
    expect((await reportOutcome({ outcome: "reopened" })).status).toBe(400);
    expect((await reportOutcome({ outcome: "reopened", isNegative: "yes", traceId: "t" })).status).toBe(400);
    expect((await reportOutcome({ outcome: "reopened", isNegative: true })).status).toBe(400);
    expect((await reportOutcome({ outcome: "   ", isNegative: true, traceId: "t" })).status).toBe(400);
  });

  it("accepts a report against a trace", async () => {
    const traceId = await ingest({ name: "cal-agent", input: "q", output: "a" });
    const res = await reportOutcome({ traceId, outcome: "ticket_reopened", isNegative: true, reason: "user came back", reportedBy: "servicenow" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).toContain("ticket_reopened");
  });
});

describe("end-user feedback", () => {
  it("requires a trace id and an up/down rating", async () => {
    expect((await engine.json("/api/v1/feedback", post({}, key))).status).toBe(400);
    expect((await engine.json("/api/v1/feedback", post({ traceId: "t" }, key))).status).toBe(400);
    expect((await engine.json("/api/v1/feedback", post({ traceId: "t", rating: "meh" }, key))).status).toBe(400);
  });

  it("404s a rating against a trace that does not exist", async () => {
    const res = await engine.json("/api/v1/feedback", post({ traceId: "no-such-trace", rating: "up" }, key));
    expect(res.status).toBe(404);
  });

  it("records a thumbs up and lists it back against the trace", async () => {
    const traceId = await ingest({ name: "feedback-agent", input: "q", output: "a" });
    const created = await engine.json("/api/v1/feedback", post({ traceId, rating: "up", comment: "spot on", endUserId: "u-1" }, key));
    expect(created.status).toBe(201);

    const listed = await engine.json(`/api/v1/feedback/trace/${traceId}`, { apiKey: key });
    expect(listed.status).toBe(200);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).toContain("spot on");
    expect(serialized).toContain("u-1");
  });

  it("raises a signal from a downvote, since the user is the detector", async () => {
    const traceId = await ingest({ name: "downvoted-agent", input: "q", output: "a" });
    const created = await engine.json("/api/v1/feedback", post({ traceId, rating: "down", comment: "completely wrong" }, key));
    expect(created.status).toBe(201);

    const deadline = Date.now() + 15_000;
    let signal: { summary?: string } | undefined;
    while (Date.now() < deadline && !signal) {
      const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: key });
      signal = ((res.body as { signals?: { patternKey?: string; summary?: string }[] }).signals ?? []).find(
        s => s.patternKey === "negative-feedback"
      );
      if (!signal) await new Promise(r => setTimeout(r, 150));
    }
    expect(signal, "a downvote did not raise a signal").toBeTruthy();
    expect(signal!.summary).toContain("completely wrong");
  }, 40_000);

  it("also files the vote as an outcome report, so it counts toward calibration", async () => {
    const before = (await calibration()).reportedCount;
    const traceId = await ingest({ name: "counted-agent", input: "q", output: "a" });
    await engine.json("/api/v1/feedback", post({ traceId, rating: "up" }, key));
    expect((await calibration()).reportedCount).toBe(before + 1);
  });

  it("lists multiple votes on one trace newest first", async () => {
    const traceId = await ingest({ name: "multi-feedback-agent", input: "q", output: "a" });
    await engine.json("/api/v1/feedback", post({ traceId, rating: "up", comment: "first" }, key));
    await new Promise(r => setTimeout(r, 1_100));
    await engine.json("/api/v1/feedback", post({ traceId, rating: "down", comment: "second" }, key));

    const listed = await engine.json(`/api/v1/feedback/trace/${traceId}`, { apiKey: key });
    const rows = (listed.body as { feedback: { comment: string }[] }).feedback;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.comment).toBe("second");
  }, 30_000);
});

describe("judge calibration", () => {
  // One of each cell of the confusion matrix, in a project of its own so nothing else lands in
  // the window. AgentX "flags" a trace when a signal was raised for it; a clean trace records
  // only the healthy-response tally, which is deliberately not counted as a flag.
  it("computes agreement, false positives and false negatives from reported reality", async () => {
    const fresh = await engine.json("/api/v1/projects", post({ name: "Matrix project" }, null));
    const matrixKey = (fresh.body as { project: { apiKey: string } }).project.apiKey;
    await enableBuiltinScorers(engine, matrixKey);

    const ingestTo = async (body: Record<string, unknown>) => {
      const res = await engine.json("/api/v1/ingest/traces", post(body, matrixKey));
      expect(res.status).toBe(200);
      return (res.body as { trace_id: string }).trace_id;
    };

    // AgentX flags these two (a recorded trace error raises a signal).
    const flaggedAndReallyBad = await ingestTo({ name: "m-agent", input: "q", output: "", error: "Boom" });
    const flaggedButActuallyFine = await ingestTo({ name: "m-agent", input: "q", output: "", error: "Boom" });
    // AgentX considers these two healthy.
    const healthyAndReallyFine = await ingestTo({ name: "m-agent", input: "q", output: "a good answer" });
    const healthyButActuallyBad = await ingestTo({ name: "m-agent", input: "q", output: "another good answer" });
    // And one AgentX never checked at all - no verdict to compare against.
    const neverChecked = await ingestTo({ name: "m-agent", input: "q", output: "unchecked", monitor: false });

    // Wait for the detached monitor pass on the four checked traces.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const kpis = await engine.json("/api/v1/agent-monitoring/kpis", { apiKey: matrixKey });
      if ((kpis.body as { totalRuns: number }).totalRuns >= 4) break;
      await new Promise(r => setTimeout(r, 200));
    }

    const report = async (traceId: string, isNegative: boolean) => {
      const res = await engine.json("/api/v1/outcomes", post({ traceId, outcome: "reviewed", isNegative }, matrixKey));
      expect(res.status).toBe(201);
    };
    await report(flaggedAndReallyBad, true); // true positive
    await report(flaggedButActuallyFine, false); // false positive
    await report(healthyAndReallyFine, false); // true negative
    await report(healthyButActuallyBad, true); // false negative
    await report(neverChecked, true); // no verdict - excluded

    const res = await engine.json("/api/v1/agent-monitoring/calibration", { apiKey: matrixKey });
    const result = res.body as {
      reportedCount: number;
      noVerdictCount: number;
      comparedCount: number;
      agreementRate: number | null;
      falsePositiveRate: number | null;
      falseNegativeRate: number | null;
    };

    expect(result.reportedCount).toBe(5);
    expect(result.noVerdictCount, "a trace AgentX never checked was counted as a verdict").toBe(1);
    expect(result.comparedCount).toBe(4);
    // 1 true positive + 1 true negative out of 4 compared.
    expect(result.agreementRate).toBeCloseTo(0.5, 10);
    // Of the two AgentX flagged, one turned out fine.
    expect(result.falsePositiveRate).toBeCloseTo(0.5, 10);
    // Of the two AgentX called healthy, one turned out bad.
    expect(result.falseNegativeRate).toBeCloseTo(0.5, 10);
  }, 90_000);

  it("reports nulls rather than a fabricated score when nothing has been reported", async () => {
    const fresh = await engine.json("/api/v1/projects", post({ name: "Quiet calibration project" }, null));
    const quietKey = (fresh.body as { project: { apiKey: string } }).project.apiKey;
    await enableBuiltinScorers(engine, quietKey);
    const res = await engine.json("/api/v1/agent-monitoring/calibration", { apiKey: quietKey });
    expect(res.body).toMatchObject({
      reportedCount: 0,
      comparedCount: 0,
      agreementRate: null,
      falsePositiveRate: null,
      falseNegativeRate: null,
    });
  });

  it("keeps one project's outcome reports out of another's calibration", async () => {
    const fresh = await engine.json("/api/v1/projects", post({ name: "Isolated calibration project" }, null));
    const otherKey = (fresh.body as { project: { apiKey: string } }).project.apiKey;
    await enableBuiltinScorers(engine, otherKey);
    const traceId = await ingest({ name: "cal-agent", input: "q", output: "a" });
    await reportOutcome({ traceId, outcome: "reviewed", isNegative: true });

    const res = await engine.json("/api/v1/agent-monitoring/calibration", { apiKey: otherKey });
    expect((res.body as { reportedCount: number }).reportedCount).toBe(0);
  });
});
