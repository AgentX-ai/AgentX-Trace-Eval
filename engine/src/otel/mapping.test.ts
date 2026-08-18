import { describe, expect, it } from "vitest";
import { otelSpanToIngestInput, reconstructParentToolCalls } from "./mapping.js";
import type { NormalizedSpan } from "./normalize.js";
import type { IngestTraceInput } from "../core/trace/ingest.js";

// The attribute table here decides what an operator actually sees in Observe for OTel traffic:
// which text lands in input/output, whether a tool call is recorded at all, and which rows group
// into one session. Every lookup has fallbacks across three competing conventions, so the
// precedence between them is worth pinning down.

function span(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    traceIdHex: "0123456789abcdef0123456789abcdef",
    spanIdHex: "0123456789abcdef",
    parentSpanIdHex: null,
    name: "chat",
    startTimeUnixNano: 1_700_000_000_000_000_000n,
    endTimeUnixNano: 1_700_000_001_500_000_000n,
    attributes: {},
    resourceAttributes: {},
    scopeName: null,
    statusCode: "STATUS_CODE_UNSET",
    statusMessage: null,
    events: [],
    ...overrides,
  };
}

describe("otelSpanToIngestInput", () => {
  it("derives latency in milliseconds from the span's own clock", () => {
    expect(otelSpanToIngestInput(span()).latency_ms).toBe(1500);
  });

  it("omits latency when the span has no usable duration", () => {
    expect(otelSpanToIngestInput(span({ startTimeUnixNano: 0n, endTimeUnixNano: 0n })).latency_ms).toBeUndefined();
    // End before start (clock skew across processes) is not a negative latency.
    expect(otelSpanToIngestInput(span({ startTimeUnixNano: 10n, endTimeUnixNano: 5n })).latency_ms).toBeUndefined();
  });

  it("prefers the response model over the request model", () => {
    const mapped = otelSpanToIngestInput(
      span({ attributes: { "gen_ai.request.model": "gpt-4o-mini", "gen_ai.response.model": "gpt-4o-mini-2024-07-18" } })
    );
    expect(mapped.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("falls back through provider, scope, and service.name for the framework", () => {
    expect(otelSpanToIngestInput(span({ attributes: { "gen_ai.provider.name": "openai" } })).framework).toBe("openai");
    expect(otelSpanToIngestInput(span({ attributes: { "gen_ai.system": "anthropic" } })).framework).toBe("anthropic");
    expect(otelSpanToIngestInput(span({ scopeName: "openinference.langchain" })).framework).toBe("openinference.langchain");
    expect(otelSpanToIngestInput(span({ resourceAttributes: { "service.name": "checkout" } })).framework).toBe("checkout");
    expect(otelSpanToIngestInput(span()).framework).toBe("otel");
  });

  it("renders the GenAI structured message schema into readable text", () => {
    const mapped = otelSpanToIngestInput(
      span({
        attributes: {
          "gen_ai.input.messages": [{ role: "user", parts: [{ type: "text", content: "where is my order?" }] }],
          "gen_ai.output.messages": [{ role: "assistant", parts: [{ type: "text", content: "shipped monday" }] }],
        },
      })
    );
    expect(mapped.input).toBe("user: where is my order?");
    expect(mapped.output).toBe("assistant: shipped monday");
  });

  it("accepts the messages array as a JSON string, which several exporters send", () => {
    const mapped = otelSpanToIngestInput(
      span({ attributes: { "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hi" }]) } })
    );
    expect(mapped.input).toBe("user: hi");
  });

  it("prepends system instructions to the rendered input", () => {
    const mapped = otelSpanToIngestInput(
      span({
        attributes: {
          "gen_ai.system_instructions": [{ role: "system", content: "be terse" }],
          "gen_ai.input.messages": [{ role: "user", content: "hi" }],
        },
      })
    );
    expect(mapped.input).toBe("system: be terse\nuser: hi");
  });

  it("falls back to OpenLLMetry's indexed attributes, in index order", () => {
    const mapped = otelSpanToIngestInput(
      span({
        attributes: {
          "gen_ai.prompt.1.role": "user",
          "gen_ai.prompt.1.content": "second",
          "gen_ai.prompt.0.role": "system",
          "gen_ai.prompt.0.content": "first",
          "gen_ai.completion.0.role": "assistant",
          "gen_ai.completion.0.content": "answer",
        },
      })
    );
    expect(mapped.input).toBe("system: first\nuser: second");
    expect(mapped.output).toBe("assistant: answer");
  });

  it("sorts indexed attributes numerically, not lexicographically", () => {
    const attributes: Record<string, unknown> = {};
    for (const i of [0, 2, 10]) {
      attributes[`gen_ai.prompt.${i}.role`] = "user";
      attributes[`gen_ai.prompt.${i}.content`] = `msg${i}`;
    }
    expect(otelSpanToIngestInput(span({ attributes })).input).toBe("user: msg0\nuser: msg2\nuser: msg10");
  });

  it("falls back to OpenInference's single raw value last", () => {
    const mapped = otelSpanToIngestInput(span({ attributes: { "input.value": "raw", "output.value": "out" } }));
    expect(mapped.input).toBe("raw");
    expect(mapped.output).toBe("out");
  });

  it("reads token usage under either the current or the deprecated attribute name", () => {
    expect(otelSpanToIngestInput(span({ attributes: { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 4 } })))
      .toMatchObject({ input_tokens: 10, output_tokens: 4 });
    expect(otelSpanToIngestInput(span({ attributes: { "gen_ai.usage.prompt_tokens": 7, "gen_ai.usage.completion_tokens": 2 } })))
      .toMatchObject({ input_tokens: 7, output_tokens: 2 });
  });

  it("records an error from the span status and from an exception event", () => {
    expect(otelSpanToIngestInput(span({ statusCode: "STATUS_CODE_ERROR", statusMessage: "rate limited" })).error).toBe("rate limited");
    expect(otelSpanToIngestInput(span({ statusCode: "STATUS_CODE_ERROR" })).error).toBe("error");
    expect(
      otelSpanToIngestInput(
        span({ events: [{ name: "exception", attributes: { "exception.message": "boom", "exception.type": "ValueError" } }] })
      ).error
    ).toBe("boom");
  });

  it("maps a tool span to a one-element tool_calls array with success derived from status", () => {
    const ok = otelSpanToIngestInput(span({ attributes: { "gen_ai.tool.name": "lookup_order" } }));
    expect(ok.tool_calls).toEqual([{ name: "lookup_order", input: null, output: null, success: true }]);

    const failed = otelSpanToIngestInput(
      span({ attributes: { "gen_ai.tool.name": "lookup_order" }, statusCode: "STATUS_CODE_ERROR", statusMessage: "404" })
    );
    expect(failed.tool_calls).toEqual([{ name: "lookup_order", input: null, output: null, success: false, error: "404" }]);
  });

  it("groups by an explicit session attribute before falling back to the trace id", () => {
    expect(otelSpanToIngestInput(span({ attributes: { "agentx.session_id": "s1", "session.id": "s2" } })).session_id).toBe("s1");
    expect(otelSpanToIngestInput(span({ attributes: { "session.id": "s2", "gen_ai.conversation.id": "s3" } })).session_id).toBe("s2");
    expect(otelSpanToIngestInput(span({ attributes: { "gen_ai.conversation.id": "s3" } })).session_id).toBe("s3");
    expect(otelSpanToIngestInput(span()).session_id).toBe("0123456789abcdef0123456789abcdef");
  });

  it("promotes agentx.prompt_name/version into metadata for the Improve loop", () => {
    const mapped = otelSpanToIngestInput(span({ attributes: { "agentx.prompt_name": "support_v2", "agentx.version": "3" } }));
    expect(mapped.metadata).toMatchObject({ promptName: "support_v2", version: "3" });
  });

  it("omits ids that arrived empty rather than sending blank strings downstream", () => {
    const mapped = otelSpanToIngestInput(span({ spanIdHex: "", parentSpanIdHex: "", traceIdHex: "" }));
    expect(mapped.span_id).toBeUndefined();
    expect(mapped.parent_span_id).toBeUndefined();
    expect(mapped.session_id).toBeUndefined();
  });
});

describe("reconstructParentToolCalls", () => {
  const call = (name: string) => [{ name, input: null, output: null, success: true }];

  it("folds a tool span's call into its root ancestor", () => {
    const root: IngestTraceInput = { name: "agent", span_id: "root" };
    const middle: IngestTraceInput = { name: "llm", span_id: "mid", parent_span_id: "root" };
    const tool: IngestTraceInput = { name: "lookup", span_id: "tool", parent_span_id: "mid", tool_calls: call("lookup") };

    reconstructParentToolCalls([root, middle, tool]);

    expect(root.tool_calls).toEqual(call("lookup"));
    // Neither the intermediate span nor the tool span itself is rewritten.
    expect(middle.tool_calls).toBeUndefined();
    expect(tool.tool_calls).toEqual(call("lookup"));
  });

  it("collects several tool spans onto the same root", () => {
    const root: IngestTraceInput = { name: "agent", span_id: "root" };
    const a: IngestTraceInput = { name: "a", span_id: "a", parent_span_id: "root", tool_calls: call("a") };
    const b: IngestTraceInput = { name: "b", span_id: "b", parent_span_id: "root", tool_calls: call("b") };

    reconstructParentToolCalls([root, a, b]);

    expect(root.tool_calls).toHaveLength(2);
    expect(root.tool_calls).toEqual([...call("a"), ...call("b")]);
  });

  it("stops at the highest ancestor that actually arrived in the batch", () => {
    // The real root was exported in an earlier batch; "mid" is the top of what's here.
    const middle: IngestTraceInput = { name: "llm", span_id: "mid", parent_span_id: "absent-root" };
    const tool: IngestTraceInput = { name: "lookup", span_id: "tool", parent_span_id: "mid", tool_calls: call("lookup") };

    reconstructParentToolCalls([middle, tool]);

    expect(middle.tool_calls).toEqual(call("lookup"));
  });

  it("never folds one tool span into another", () => {
    const outer: IngestTraceInput = { name: "outer", span_id: "outer", tool_calls: call("outer") };
    const inner: IngestTraceInput = { name: "inner", span_id: "inner", parent_span_id: "outer", tool_calls: call("inner") };

    reconstructParentToolCalls([outer, inner]);

    expect(outer.tool_calls).toEqual(call("outer"));
  });

  it("terminates on a parent cycle instead of looping forever", () => {
    const a: IngestTraceInput = { name: "a", span_id: "a", parent_span_id: "b" };
    const b: IngestTraceInput = { name: "b", span_id: "b", parent_span_id: "a" };
    const tool: IngestTraceInput = { name: "t", span_id: "t", parent_span_id: "a", tool_calls: call("t") };

    expect(() => reconstructParentToolCalls([a, b, tool])).not.toThrow();
  });

  it("ignores a span that is its own parent", () => {
    const tool: IngestTraceInput = { name: "t", span_id: "t", parent_span_id: "t", tool_calls: call("t") };
    expect(() => reconstructParentToolCalls([tool])).not.toThrow();
    expect(tool.tool_calls).toEqual(call("t"));
  });

  it("is a no-op for a batch with no tool spans", () => {
    const root: IngestTraceInput = { name: "agent", span_id: "root" };
    const child: IngestTraceInput = { name: "llm", span_id: "child", parent_span_id: "root" };
    reconstructParentToolCalls([root, child]);
    expect(root.tool_calls).toBeUndefined();
  });
});
