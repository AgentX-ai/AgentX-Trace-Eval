import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// "Turn production traffic into a golden dataset case" is the close-the-loop feature, and it is
// two clicks in the dashboard - so the same trace gets added twice constantly. Deduplication and
// multi-turn ordering are what stop a dataset quietly filling with near-copies in the wrong
// sequence, and neither is visible until someone reads the dataset back.

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

async function newDataset(name: string): Promise<string> {
  const res = await engine.json("/api/v1/custom-agent-evaluations/datasets", post({ name, questions: [] }, key));
  expect(res.status).toBe(201);
  return (res.body as { _id?: string; id?: string })._id ?? (res.body as { id: string }).id;
}

async function preview(body: Record<string, unknown>) {
  return engine.json("/api/v1/evaluate/datasets/case-preview", post(body, key));
}

async function addCase(datasetId: string, body: Record<string, unknown>) {
  return engine.json(`/api/v1/evaluate/datasets/${datasetId}/cases`, post(body, key));
}

const nanos = (offsetMs: number) => (1_760_000_000_000_000_000n + BigInt(offsetMs) * 1_000_000n).toString();

beforeAll(async () => {
  engine = await startEngine();
  // Own project: the default one ships with seeded example traffic.
  const project = await engine.json("/api/v1/projects", post({ name: "Curation project" }, null));
  key = (project.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("previewing a case from one trace", () => {
  it("uses the trace's own question and records where it came from", async () => {
    const traceId = await ingest({ name: "curate-agent", input: "do you ship to Spain?", output: "Yes, 3-5 business days." });
    const res = await preview({ traceId });
    expect(res.status).toBe(200);

    const body = res.body as { case: { main_question: { query: string }; follow_up_questions: unknown[]; source: { traceId: string } }; turns: { actualOutput: string }[] };
    expect(body.case.main_question.query).toBe("do you ship to Spain?");
    expect(body.case.follow_up_questions).toEqual([]);
    expect(body.case.source.traceId).toBe(traceId);
    // The actual answer comes back alongside, so a human writes the expected result with the real
    // response in front of them rather than from memory.
    expect(body.turns[0]!.actualOutput).toBe("Yes, 3-5 business days.");
  });

  it("404s for a trace that does not exist, and 400s with no identifier at all", async () => {
    expect((await preview({ traceId: "nope" })).status).toBe(404);
    expect((await preview({})).status).toBe(400);
  });
});

describe("previewing a case from a multi-turn session", () => {
  it("makes the first turn the main question and the rest follow-ups, in time order", async () => {
    const sessionId = "curation-session-ordered";
    // Ingested out of order on purpose - only started_at_unix_nano says what really came first.
    await ingest({ name: "curate-agent", span_id: "turn-3", session_id: sessionId, input: "and to Portugal?", output: "Yes.", started_at_unix_nano: nanos(2000) });
    await ingest({ name: "curate-agent", span_id: "turn-1", session_id: sessionId, input: "do you ship to Spain?", output: "Yes, 3-5 days.", started_at_unix_nano: nanos(0) });
    await ingest({ name: "curate-agent", span_id: "turn-2", session_id: sessionId, input: "how much?", output: "Four euro.", started_at_unix_nano: nanos(1000) });

    const res = await preview({ sessionId });
    expect(res.status).toBe(200);
    const body = res.body as {
      case: { main_question: { query: string }; follow_up_questions: { query: string }[]; source: { sessionId: string } };
      turns: { query: string }[];
    };
    expect(body.case.main_question.query).toBe("do you ship to Spain?");
    expect(body.case.follow_up_questions.map(f => f.query)).toEqual(["how much?", "and to Portugal?"]);
    expect(body.case.source.sessionId).toBe(sessionId);
    expect(body.turns.map(t => t.query)).toEqual(["do you ship to Spain?", "how much?", "and to Portugal?"]);
  });

  it("ignores child spans, which are steps inside a turn rather than turns", async () => {
    const sessionId = "curation-session-with-children";
    await ingest({ name: "curate-agent", span_id: "root-a", session_id: sessionId, input: "first question", output: "first answer", started_at_unix_nano: nanos(0) });
    await ingest({
      name: "tool-step",
      span_id: "child-a",
      parent_span_id: "root-a",
      session_id: sessionId,
      input: "internal lookup",
      output: "internal result",
      started_at_unix_nano: nanos(10),
    });

    const res = await preview({ sessionId });
    const body = res.body as { case: { follow_up_questions: unknown[] }; turns: { query: string }[] };
    expect(body.turns.map(t => t.query)).toEqual(["first question"]);
    expect(body.case.follow_up_questions).toEqual([]);
  });

  it("404s for a session with no usable turns", async () => {
    expect((await preview({ sessionId: "no-such-session" })).status).toBe(404);
  });
});

describe("adding a case to a dataset", () => {
  it("stores the case and reports the new count", async () => {
    const datasetId = await newDataset("curated-1");
    const traceId = await ingest({ name: "curate-agent", input: "what is the warranty?", output: "Two years." });
    const previewed = (await preview({ traceId })).body as { case: Record<string, unknown> };

    const added = await addCase(datasetId, { case: previewed.case });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ ok: true, caseCount: 1 });

    const dataset = await engine.json(`/api/v1/custom-agent-evaluations/datasets/${datasetId}`, { apiKey: key });
    expect(JSON.stringify(dataset.body)).toContain("what is the warranty?");
  });

  it("refuses the same trace twice, naming the provenance as the reason", async () => {
    const datasetId = await newDataset("curated-2");
    const traceId = await ingest({ name: "curate-agent", input: "can I cancel?", output: "Within 14 days." });
    const previewed = (await preview({ traceId })).body as { case: Record<string, unknown> };

    expect((await addCase(datasetId, { case: previewed.case })).status).toBe(201);
    const again = await addCase(datasetId, { case: previewed.case });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ duplicate: { reason: "same-source" } });
  });

  it("refuses a different trace asking the same question, ignoring case and spacing", async () => {
    const datasetId = await newDataset("curated-3");
    const first = await ingest({ name: "curate-agent", input: "How do I reset my password?", output: "Settings > Security." });
    const second = await ingest({ name: "curate-agent", input: "  how   do i RESET my password?  ", output: "Same place." });

    const firstCase = ((await preview({ traceId: first })).body as { case: Record<string, unknown> }).case;
    const secondCase = ((await preview({ traceId: second })).body as { case: Record<string, unknown> }).case;

    expect((await addCase(datasetId, { case: firstCase })).status).toBe(201);
    const again = await addCase(datasetId, { case: secondCase });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ duplicate: { reason: "same-query" } });
    expect(JSON.stringify(again.body)).toContain("How do I reset my password?");
  });

  it("adds the duplicate anyway when the caller opts out of deduplication", async () => {
    const datasetId = await newDataset("curated-4");
    const traceId = await ingest({ name: "curate-agent", input: "is there a trial?", output: "14 days." });
    const previewed = ((await preview({ traceId })).body as { case: Record<string, unknown> }).case;

    expect((await addCase(datasetId, { case: previewed })).status).toBe(201);
    const forced = await addCase(datasetId, { case: previewed, dedupe: false });
    expect(forced.status).toBe(201);
    expect(forced.body).toMatchObject({ caseCount: 2 });
  });

  it("keeps distinct questions apart", async () => {
    const datasetId = await newDataset("curated-5");
    const a = await ingest({ name: "curate-agent", input: "where is my order?", output: "Shipped." });
    const b = await ingest({ name: "curate-agent", input: "how do I return an item?", output: "Within 30 days." });
    for (const traceId of [a, b]) {
      const previewed = ((await preview({ traceId })).body as { case: Record<string, unknown> }).case;
      expect((await addCase(datasetId, { case: previewed })).status).toBe(201);
    }
    const dataset = await engine.json(`/api/v1/custom-agent-evaluations/datasets/${datasetId}`, { apiKey: key });
    const serialized = JSON.stringify(dataset.body);
    expect(serialized).toContain("where is my order?");
    expect(serialized).toContain("how do I return an item?");
  });

  it("404s when the dataset does not exist", async () => {
    const traceId = await ingest({ name: "curate-agent", input: "anything?", output: "sure" });
    const previewed = ((await preview({ traceId })).body as { case: Record<string, unknown> }).case;
    expect((await addCase("no-such-dataset", { case: previewed })).status).toBe(404);
  });

  it("400s a case with no question text", async () => {
    const datasetId = await newDataset("curated-6");
    expect((await addCase(datasetId, { case: { main_question: { query: "   " }, source: { traceId: "x" } } })).status).toBe(400);
    expect((await addCase(datasetId, { case: { main_question: { query: "hi" } } })).status).toBe(400);
    expect((await addCase(datasetId, {})).status).toBe(400);
  });

  it("carries a multi-turn session into the dataset as a case with follow-ups", async () => {
    const datasetId = await newDataset("curated-7");
    const sessionId = "curation-session-to-dataset";
    await ingest({ name: "curate-agent", span_id: "d-turn-1", session_id: sessionId, input: "first?", output: "yes", started_at_unix_nano: nanos(0) });
    await ingest({ name: "curate-agent", span_id: "d-turn-2", session_id: sessionId, input: "second?", output: "also yes", started_at_unix_nano: nanos(1000) });

    const previewed = ((await preview({ sessionId })).body as { case: Record<string, unknown> }).case;
    expect((await addCase(datasetId, { case: previewed })).status).toBe(201);

    const dataset = await engine.json(`/api/v1/custom-agent-evaluations/datasets/${datasetId}`, { apiKey: key });
    const serialized = JSON.stringify(dataset.body);
    expect(serialized).toContain("first?");
    expect(serialized).toContain("second?");
  });
});
