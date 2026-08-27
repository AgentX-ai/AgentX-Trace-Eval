import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Span kind end to end. The point of the column is that the engine answers "what kind of step is
// this" once, at ingest, and every reader gets the same answer - so these check the two things
// that make that true: a stated kind survives the round trip, and a span that states nothing
// still classifies the way it always did.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

type SpanWire = { _id: string; name: string; spanKind: string };

async function spansOfSession(sessionId: string): Promise<SpanWire[]> {
  const res = await api(`/ingest/sessions/${sessionId}/spans`);
  const body = res.body as { spans?: SpanWire[]; traces?: SpanWire[] };
  return body.spans ?? body.traces ?? [];
}

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "span-kind" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("span kind", () => {
  const session = "sess-kind-1";

  it("stores what the producer states, in whatever vocabulary it states it", async () => {
    const root = "root-1";
    // Our own word, an OpenInference word, and a bare span that says nothing.
    await api(
      "/ingest/traces",
      postJson({
        name: "kb_search",
        span_kind: "retriever",
        session_id: session,
        span_id: "s-ret",
        parent_span_id: root,
      }),
    );
    await api(
      "/ingest/traces",
      postJson({ name: "charge_card", spanKind: "TOOL", session_id: session, span_id: "s-tool", parent_span_id: root }),
    );
    await api(
      "/ingest/traces",
      postJson({ name: "format_prompt", session_id: session, span_id: "s-plain", parent_span_id: root }),
    );
    await api(
      "/ingest/traces",
      postJson({ name: "support-agent", model: "gpt-4o", session_id: session, span_id: root }),
    );

    const byName = new Map((await spansOfSession(session)).map(s => [s.name, s.spanKind]));
    // Stated, and folded onto our vocabulary.
    expect(byName.get("kb_search")).toBe("retrieval");
    // camelCase alias on the way in, and case-insensitive.
    expect(byName.get("charge_card")).toBe("tool");
    // Stated nothing, nothing to infer from: a step in the middle, NOT a tool.
    expect(byName.get("format_prompt")).toBe("chain");
    // Stated nothing, but has a model - the rule cost attribution already used.
    expect(byName.get("support-agent")).toBe("llm");
  });

  it("ignores a word it does not recognize rather than storing it as fact", async () => {
    const other = "sess-kind-2";
    await api(
      "/ingest/traces",
      postJson({ name: "mystery", span_kind: "wizardry", model: "gpt-4o", session_id: other, span_id: "s-x" }),
    );
    const spans = await spansOfSession(other);
    expect(spans.find(s => s.name === "mystery")?.spanKind).toBe("llm");
  });

  it("a stated kind beats what the engine would have guessed", async () => {
    const other = "sess-kind-3";
    // Has a model, which the ladder would call an llm; the producer says it is a guardrail.
    await api(
      "/ingest/traces",
      postJson({ name: "jailbreak_check", span_kind: "guardrail", model: "gpt-4o", session_id: other, span_id: "s-g" }),
    );
    const spans = await spansOfSession(other);
    expect(spans.find(s => s.name === "jailbreak_check")?.spanKind).toBe("guardrail");
  });

  it("keeps reading the legacy metadata.kind the SDK has always written", async () => {
    const other = "sess-kind-4";
    await api(
      "/ingest/traces",
      postJson({
        name: "kb_lookup",
        metadata: { kind: "retrieval" },
        output: ["a policy chunk"],
        session_id: other,
        span_id: "s-legacy",
        parent_span_id: "root-legacy",
      }),
    );
    await api("/ingest/traces", postJson({ name: "agent", session_id: other, span_id: "root-legacy" }));
    const spans = await spansOfSession(other);
    expect(spans.find(s => s.name === "kb_lookup")?.spanKind).toBe("retrieval");
  });
});
