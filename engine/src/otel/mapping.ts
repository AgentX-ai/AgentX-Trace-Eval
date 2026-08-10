import type { NormalizedSpan } from "./normalize.js";
import type { IngestTraceInput } from "../core/trace/ingest.js";

// Maps one normalized OTel span onto AgentX's flat trace row (core/trace/ingest.ts's existing
// IngestTraceInput — the same type the SDK's own tracer.trace() payload fills). One span = one
// row: AgentX's schema is already "one row per named call" (mirrors a single tracer.trace(name,
// ...) call), which is what an OTel span is too — no aggregation across a whole OTel trace needed,
// unlike products that model traces as a full span tree.
//
// Attribute names are a moving target (the GenAI semconv is still "Development" status as of
// mid-2026, and has already renamed/deprecated fields more than once — gen_ai.system ->
// gen_ai.provider.name, gen_ai.prompt/completion -> gen_ai.input.messages/output.messages), so
// every lookup below tries the current name first and falls back to older/adjacent conventions
// (OpenLLMetry's legacy indexed attributes, OpenInference's input.value/output.value) rather than
// assuming any one instrumentation library's exact version. Same "big attribute mapping table"
// approach LangSmith's own OTel ingestion uses.

function strAttr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function numAttr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function coerceToArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON — plenty of instrumentations send a plain string here instead of a structured
      // messages array; callers fall back to treating it as already-rendered text.
    }
  }
  return undefined;
}

type MessagePart = { type?: string; content?: unknown };
type Message = { role?: string; parts?: MessagePart[]; content?: unknown };

// Renders the GenAI semconv's "Input/Output/System instructions messages JSON schema" (array of
// { role, parts: [{ type, content }] }, or a flatter { role, content } some instrumentations use)
// into readable text — AgentX's schema stores input/output as unstructured JSON/text, not a
// message-array type, matching what tracer.trace() itself has always accepted from the SDK.
function renderMessages(messages: unknown[] | undefined): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  const lines = (messages as Message[]).map(m => {
    const role = m.role ?? "unknown";
    if (Array.isArray(m.parts)) {
      const text = m.parts
        .map(p => (typeof p.content === "string" ? p.content : JSON.stringify(p.content)))
        .join(" ");
      return `${role}: ${text}`;
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${role}: ${content}`;
  });
  return lines.join("\n");
}

// OpenLLMetry (pre-v1.38) legacy convention: gen_ai.prompt.{i}.role / .content and
// gen_ai.completion.{i}.role / .content, indexed attributes rather than one structured value —
// still what a large share of real-world Traceloop-instrumented apps send, deprecated or not.
function renderIndexedAttrs(attributes: Record<string, unknown>, prefix: "gen_ai.prompt" | "gen_ai.completion") {
  const byIndex = new Map<number, { role?: string; content?: unknown }>();
  const re = new RegExp(`^${prefix.replace(".", "\\.")}\\.(\\d+)\\.(role|content)$`);
  for (const [key, value] of Object.entries(attributes)) {
    const match = key.match(re);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    const field = match[2] as "role" | "content";
    const entry = byIndex.get(index) ?? {};
    if (field === "role") {
      entry.role = typeof value === "string" ? value : undefined;
    } else {
      entry.content = value;
    }
    byIndex.set(index, entry);
  }
  if (byIndex.size === 0) {
    return undefined;
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  return indices
    .map(i => {
      const entry = byIndex.get(i);
      const content = typeof entry?.content === "string" ? entry.content : JSON.stringify(entry?.content);
      return `${entry?.role ?? "unknown"}: ${content}`;
    })
    .join("\n");
}

function extractInput(attributes: Record<string, unknown>): string | undefined {
  const messages = renderMessages(coerceToArray(attributes["gen_ai.input.messages"]));
  const systemInstructions = renderMessages(coerceToArray(attributes["gen_ai.system_instructions"]));
  if (messages || systemInstructions) {
    return [systemInstructions, messages].filter(Boolean).join("\n");
  }
  const legacy = renderIndexedAttrs(attributes, "gen_ai.prompt");
  if (legacy) {
    return legacy;
  }
  // OpenInference (Arize): a single raw (often already-JSON) string, no structured schema.
  return strAttr(attributes["input.value"]);
}

function extractOutput(attributes: Record<string, unknown>): string | undefined {
  const messages = renderMessages(coerceToArray(attributes["gen_ai.output.messages"]));
  if (messages) {
    return messages;
  }
  const legacy = renderIndexedAttrs(attributes, "gen_ai.completion");
  if (legacy) {
    return legacy;
  }
  return strAttr(attributes["output.value"]);
}

function extractError(span: NormalizedSpan): string | undefined {
  if (span.statusCode === "STATUS_CODE_ERROR") {
    return span.statusMessage || "error";
  }
  const exceptionEvent = span.events.find(e => e.name === "exception");
  if (exceptionEvent) {
    return strAttr(exceptionEvent.attributes["exception.message"]) ?? strAttr(exceptionEvent.attributes["exception.type"]);
  }
  return undefined;
}

// Best-effort only: a span that IS a tool call (gen_ai.tool.name set on it directly, e.g.
// gen_ai.operation.name = "execute_tool") maps to a one-element tool_calls array. Reconstructing a
// parent LLM span's tool_calls from separate child tool-call spans isn't attempted — the GenAI
// semconv doesn't define a stable way to do that yet, see this file's header comment.
function extractToolCalls(attributes: Record<string, unknown>) {
  const name = strAttr(attributes["gen_ai.tool.name"]);
  if (!name) {
    return undefined;
  }
  return [
    {
      name,
      input: attributes["gen_ai.tool.call.arguments"] ?? null,
      output: attributes["gen_ai.tool.call.result"] ?? null,
    },
  ];
}

export function otelSpanToIngestInput(span: NormalizedSpan): IngestTraceInput {
  const attrs = span.attributes;

  const model = strAttr(attrs["gen_ai.response.model"]) ?? strAttr(attrs["gen_ai.request.model"]);
  const framework =
    strAttr(attrs["gen_ai.provider.name"]) ??
    strAttr(attrs["gen_ai.system"]) ??
    span.scopeName ??
    strAttr(span.resourceAttributes["service.name"]) ??
    "otel";
  const inputTokens = numAttr(attrs["gen_ai.usage.input_tokens"]) ?? numAttr(attrs["gen_ai.usage.prompt_tokens"]);
  const outputTokens = numAttr(attrs["gen_ai.usage.output_tokens"]) ?? numAttr(attrs["gen_ai.usage.completion_tokens"]);
  // Semconv names for prompt-caching usage — subsets of inputTokens above, same posture as the
  // Python SDK's own per-integration extraction (see core/trace/ingest.ts's ingestTraceSchema).
  const cacheReadTokens = numAttr(attrs["gen_ai.usage.cache_read_input_tokens"]);
  const cacheWriteTokens = numAttr(attrs["gen_ai.usage.cache_creation_input_tokens"]);

  const latencyNanos = span.endTimeUnixNano - span.startTimeUnixNano;
  const latencyMs = latencyNanos > 0n ? Number(latencyNanos / 1_000_000n) : undefined;

  return {
    name: span.name,
    input: extractInput(attrs),
    output: extractOutput(attrs),
    error: extractError(span),
    latency_ms: latencyMs,
    framework,
    model,
    tool_calls: extractToolCalls(attrs),
    // Groups every span from the same OTel trace together in the dashboard's trace list. Not a
    // perfect match for AgentX's own multi-request "conversation session" concept, but the closest
    // free grouping available on the wire, and better than leaving every OTel-ingested trace
    // ungrouped.
    session_id: span.traceIdHex || undefined,
    // Real span hierarchy, promoted to first-class ingestTraceSchema fields (see core/trace/
    // ingest.ts) so a session's rows can be assembled into a tree — kept in metadata.otel too
    // below, harmless redundancy, not worth a second edit to remove now that both exist.
    // normalize.ts's base64ToHex falls back to "" (not null/undefined) for malformed wire ids, so
    // these are guarded to "" -> undefined rather than trusting truthiness alone would already
    // catch it (it does, but the intent is worth being explicit about here).
    span_id: span.spanIdHex || undefined,
    parent_span_id: span.parentSpanIdHex || undefined,
    started_at_unix_nano: span.startTimeUnixNano > 0n ? span.startTimeUnixNano.toString() : undefined,
    metadata: {
      otel: {
        traceId: span.traceIdHex,
        spanId: span.spanIdHex,
        parentSpanId: span.parentSpanIdHex,
        scopeName: span.scopeName,
        resourceAttributes: span.resourceAttributes,
      },
    },
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}
