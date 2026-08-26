import { describe, expect, it } from "vitest";
import { normalizeSpanKind, resolveSpanKind, isRetrievalSpan } from "./spanKind.js";

// One classifier replacing three that disagreed. What is pinned: a stated kind always beats a
// guess, the fallback ladder still classifies old traces the way the old readers did, and the
// vocabularies other products emit fold onto ours so an already-instrumented span arrives
// classified.

describe("normalizeSpanKind", () => {
  it("takes our own vocabulary as-is, case and whitespace insensitively", () => {
    expect(normalizeSpanKind("tool")).toBe("tool");
    expect(normalizeSpanKind("  LLM  ")).toBe("llm");
    expect(normalizeSpanKind("Retrieval")).toBe("retrieval");
  });

  it("folds the other products' spellings onto ours", () => {
    // OpenInference
    expect(normalizeSpanKind("RETRIEVER")).toBe("retrieval");
    // Langfuse
    expect(normalizeSpanKind("generation")).toBe("llm");
    // OTel GenAI semconv operation names
    expect(normalizeSpanKind("execute_tool")).toBe("tool");
    expect(normalizeSpanKind("chat")).toBe("llm");
    expect(normalizeSpanKind("embeddings")).toBe("embedding");
    expect(normalizeSpanKind("invoke_agent")).toBe("agent");
  });

  it("returns null rather than guessing when it does not recognize the word", () => {
    expect(normalizeSpanKind("banana")).toBeNull();
    expect(normalizeSpanKind("")).toBeNull();
    expect(normalizeSpanKind(null)).toBeNull();
    expect(normalizeSpanKind(42)).toBeNull();
  });
});

describe("resolveSpanKind", () => {
  it("believes a stated kind over anything it could infer", () => {
    // Has a model, which would otherwise make it an llm - the producer said otherwise.
    expect(resolveSpanKind({ spanKind: "guardrail", model: "gpt-4o", parentSpanId: "p" })).toBe("guardrail");
    // Has tool calls, which would otherwise make it a tool.
    expect(resolveSpanKind({ spanKind: "agent", toolCalls: [{ name: "x" }], parentSpanId: "p" })).toBe("agent");
  });

  it("still reads the legacy metadata.kind the SDK has always written", () => {
    expect(resolveSpanKind({ metadata: { kind: "retrieval" }, name: "kb_search", parentSpanId: "p" })).toBe(
      "retrieval",
    );
    // The column wins over metadata when both are present.
    expect(resolveSpanKind({ spanKind: "tool", metadata: { kind: "retrieval" }, parentSpanId: "p" })).toBe("tool");
  });

  it("does not call a root span an agent turn just because it is root", () => {
    // The common flat trace IS the LLM call at its root; inferring "agent" from structure alone
    // emptied the dashboard's LLM-span count when this was tried.
    expect(resolveSpanKind({ name: "support-agent", model: "gpt-4o", parentSpanId: null })).toBe("llm");
    // A root that genuinely is an agent turn says so.
    expect(resolveSpanKind({ spanKind: "agent", name: "support-agent", model: "gpt-4o" })).toBe("agent");
  });

  it("keeps the old inference order for spans that state nothing", () => {
    expect(resolveSpanKind({ model: "gpt-4o", parentSpanId: "p" })).toBe("llm");
    expect(resolveSpanKind({ toolCalls: [{ name: "lookup_order" }], parentSpanId: "p" })).toBe("tool");
    expect(resolveSpanKind({ name: "LLM Call 2", parentSpanId: "p" })).toBe("llm");
    expect(resolveSpanKind({ name: "Retrieval 1", parentSpanId: "p" })).toBe("retrieval");
  });

  it("calls an unrecognized child span a chain, not a tool", () => {
    // This is the bug that started it: the timeline's catch-all drew this as a tool call.
    expect(resolveSpanKind({ name: "format_prompt", parentSpanId: "p" })).toBe("chain");
    expect(resolveSpanKind({ name: "format_prompt", toolCalls: [], parentSpanId: "p" })).toBe("chain");
  });

  it("does not treat an unrecognized stated kind as a statement", () => {
    // Falls through to inference rather than storing nonsense as fact.
    expect(resolveSpanKind({ spanKind: "wizardry", model: "gpt-4o", parentSpanId: "p" })).toBe("llm");
  });
});

describe("isRetrievalSpan", () => {
  it("matches a stated retrieval whatever it is called", () => {
    expect(isRetrievalSpan({ spanKind: "retriever", name: "kb_search", parentSpanId: "p" })).toBe(true);
    expect(isRetrievalSpan({ metadata: { kind: "retrieval" }, name: "kb_search", parentSpanId: "p" })).toBe(true);
  });

  it("still matches the legacy name convention, and nothing else", () => {
    expect(isRetrievalSpan({ name: "Retrieval 1", parentSpanId: "p" })).toBe(true);
    expect(isRetrievalSpan({ name: "kb_search", parentSpanId: "p" })).toBe(false);
    expect(isRetrievalSpan({ name: "LLM Call 1", parentSpanId: "p" })).toBe(false);
  });
});
