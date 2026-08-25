import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// GET /ingest/traces?search= - database-side search for the dashboard's Live Traces box: LIKE
// across agent name, input/output text, model, error, and trace/session ids, composed with the
// keyset cursor so paging within a term stays consistent.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

type Wire = { traces: { _id: string; name: string }[]; hasNextPage: boolean; nextCursor: string | null };

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "trace-search" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  await api("/ingest/traces", postJson({
    name: "support-agent",
    input: "Where is my order #8123?",
    output: "It shipped yesterday via UPS.",
    model: "gpt-4o-mini",
    span_id: "srch-1",
  }));
  await api("/ingest/traces", postJson({
    name: "billing-agent",
    input: "I want a refund for invoice 55",
    output: "Refund of 100% issued.",
    span_id: "srch-2",
  }));
  await api("/ingest/traces", postJson({
    name: "billing-agent",
    input: "how do I update my card?",
    output: "",
    error: "upstream timeout",
    span_id: "srch-3",
  }));
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("GET /ingest/traces?search=", () => {
  it("matches input/output text case-insensitively, database-side", async () => {
    const res = (await api("/ingest/traces?search=REFUND")).body as Wire;
    expect(res.traces).toHaveLength(1);
    expect(res.traces[0]!.name).toBe("billing-agent");
    const shipped = (await api("/ingest/traces?search=shipped yesterday")).body as Wire;
    expect(shipped.traces).toHaveLength(1);
    expect(shipped.traces[0]!.name).toBe("support-agent");
  });

  it("matches agent name, model, and error text", async () => {
    expect(((await api("/ingest/traces?search=billing-agent")).body as Wire).traces).toHaveLength(2);
    expect(((await api("/ingest/traces?search=gpt-4o-mini")).body as Wire).traces).toHaveLength(1);
    const errored = (await api("/ingest/traces?search=upstream timeout")).body as Wire;
    expect(errored.traces).toHaveLength(1);
  });

  it("resolves a pasted trace id and escapes LIKE wildcards", async () => {
    const all = (await api("/ingest/traces")).body as Wire;
    const id = all.traces[0]!._id;
    const byId = (await api(`/ingest/traces?search=${id}`)).body as Wire;
    expect(byId.traces.map(t => t._id)).toContain(id);
    // "100%" must match the literal text, not "100 followed by anything".
    const literal = (await api(`/ingest/traces?search=${encodeURIComponent("100%")}`)).body as Wire;
    expect(literal.traces).toHaveLength(1);
    expect(literal.traces[0]!.name).toBe("billing-agent");
    // A wildcard-only term matches nothing rather than everything.
    const wild = (await api(`/ingest/traces?search=${encodeURIComponent("zz%zz")}`)).body as Wire;
    expect(wild.traces).toHaveLength(0);
  });

  it("composes with cursor pagination", async () => {
    const page1 = (await api("/ingest/traces?search=billing-agent&limit=1")).body as Wire;
    expect(page1.traces).toHaveLength(1);
    expect(page1.hasNextPage).toBe(true);
    const page2 = (await api(`/ingest/traces?search=billing-agent&limit=1&cursor=${page1.nextCursor}`)).body as Wire;
    expect(page2.traces).toHaveLength(1);
    expect(page2.traces[0]!._id).not.toBe(page1.traces[0]!._id);
    expect(page2.hasNextPage).toBe(false);
  });
});
