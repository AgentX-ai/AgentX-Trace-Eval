import type { NormalizedSpan } from "./normalize.js";
import type { IngestTraceInput } from "../core/trace/ingest.js";

// Maps one normalized OTel span onto AgentX's flat trace row (core/trace/ingest.ts's existing
// IngestTraceInput - the same type the SDK's own tracer.trace() payload fills). One span = one
// row: AgentX's schema is already "one row per named call" (mirrors a single tracer.trace(name,
// ...) call), which is what an OTel span is too - no aggregation across a whole OTel trace needed,
// unlike products that model traces as a full span tree.
//
// Attribute names are a moving target (the GenAI semconv is still "Development" status as of
// mid-2026, and has already renamed/deprecated fields more than once - gen_ai.system ->
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
      // Not JSON - plenty of instrumentations send a plain string here instead of a structured
      // messages array; callers fall back to treating it as already-rendered text.
    }
  }
  return undefined;
}

type MessagePart = { type?: string; content?: unknown };
type Message = { role?: string; parts?: MessagePart[]; content?: unknown };

// Renders the GenAI semconv's "Input/Output/System instructions messages JSON schema" (array of
// { role, parts: [{ type, content }] }, or a flatter { role, content } some instrumentations use)
// into readable text - AgentX's schema stores input/output as unstructured JSON/text, not a
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
// gen_ai.completion.{i}.role / .content, indexed attributes rather than one structured value -
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

// A span that IS a tool call (gen_ai.tool.name set on it directly, e.g. gen_ai.operation.name =
// "execute_tool") maps to a one-element tool_calls array, with success/error derived from the
// span's own error status so the engine's "Tool failure" check (which keys on success === false,
// same contract as the SDK's trace_tool_call) works on OTel traffic too. Folding these child
// spans up into the parent interaction's tool_calls happens as a second, batch-level pass - see
// reconstructParentToolCalls below.
function extractToolCalls(span: NormalizedSpan) {
  const attributes = span.attributes;
  const name = strAttr(attributes["gen_ai.tool.name"]);
  if (!name) {
    return undefined;
  }
  const error = extractError(span);
  return [
    {
      name,
      input: attributes["gen_ai.tool.call.arguments"] ?? null,
      output: attributes["gen_ai.tool.call.result"] ?? null,
      success: !error,
      ...(error ? { error } : {}),
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
  // Semconv names for prompt-caching usage - subsets of inputTokens above, same posture as the
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
    tool_calls: extractToolCalls(span),
    // Conversation grouping, in priority order: an explicit session attribute (the OTel semconv's
    // session.id, GenAI's gen_ai.conversation.id, or the documented agentx.session_id escape
    // hatch) makes OTel traffic a first-class citizen of the Sessions surface - multi-request
    // conversations group exactly like SDK traces, so session coherence and session-scoped online
    // evaluators apply. Without one, the OTel trace id still groups the single interaction's own
    // spans together, the closest free grouping available on the wire.
    session_id:
      strAttr(attrs["agentx.session_id"]) ??
      strAttr(attrs["session.id"]) ??
      strAttr(attrs["gen_ai.conversation.id"]) ??
      (span.traceIdHex || undefined),
    // Real span hierarchy, promoted to first-class ingestTraceSchema fields (see core/trace/
    // ingest.ts) so a session's rows can be assembled into a tree - kept in metadata.otel too
    // below, harmless redundancy, not worth a second edit to remove now that both exist.
    // normalize.ts's base64ToHex falls back to "" (not null/undefined) for malformed wire ids, so
    // these are guarded to "" -> undefined rather than trusting truthiness alone would already
    // catch it (it does, but the intent is worth being explicit about here).
    span_id: span.spanIdHex || undefined,
    parent_span_id: span.parentSpanIdHex || undefined,
    started_at_unix_nano: span.startTimeUnixNano > 0n ? span.startTimeUnixNano.toString() : undefined,
    metadata: {
      // Prompt identity, the documented convention for OTel traffic: set agentx.prompt_name (and
      // optionally agentx.version) as span attributes and the whole Improve loop lights up -
      // prompt-registry evidence gathering matches on metadata.promptName, version comparison on
      // metadata.version, exactly as if the SDK's metadata={"promptName": ...} had been passed.
      ...(strAttr(attrs["agentx.prompt_name"]) ? { promptName: strAttr(attrs["agentx.prompt_name"]) } : {}),
      ...(strAttr(attrs["agentx.version"]) ? { version: strAttr(attrs["agentx.version"]) } : {}),
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

// Second pass over a mapped batch: fold each tool-call span's one-element tool_calls summary up
// into its ROOT ancestor within the batch - the root, specifically, because that's the one span
// Monitor checks (child spans are skipped by default, see routes/otlp.ts) and the one the
// dashboard's Tool quality column and Tool Schema evidence gathering read, the same place the
// SDK's trace_tool_call dual-writes its flat summary. This is what makes all three work for OTel
// traffic, whose GenAI semconv scatters tool calls across child spans instead. The tool span
// itself is left unchanged (the timeline still shows it as its own step). In-batch only: a parent
// exported in an earlier OTLP batch can't be updated retroactively, which in practice is rare
// (exporters batch a trace's spans together).
export function reconstructParentToolCalls(candidates: IngestTraceInput[]): void {
  const bySpanId = new Map<string, IngestTraceInput>();
  // Tool-span identity is fixed BEFORE any folding: pre-fold, a non-empty tool_calls can only
  // have come from extractToolCalls (gen_ai.tool.name on the span itself). Testing tool_calls
  // during the fold instead would misclassify a parent as a tool span as soon as its first child
  // folded in, hiding it from its remaining children.
  const toolSpanIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.span_id) continue;
    bySpanId.set(candidate.span_id, candidate);
    if (candidate.tool_calls && candidate.tool_calls.length > 0) toolSpanIds.add(candidate.span_id);
  }
  for (const candidate of candidates) {
    if (!candidate.span_id || !toolSpanIds.has(candidate.span_id) || !candidate.parent_span_id) continue;
    // Walk to the topmost ancestor reachable within the batch, cycle-guarded; a missing parent
    // ends the walk at the highest span that did arrive.
    let top = bySpanId.get(candidate.parent_span_id);
    const visited = new Set<string>([candidate.span_id]);
    while (top?.parent_span_id && top.span_id && !visited.has(top.span_id)) {
      visited.add(top.span_id);
      const next = bySpanId.get(top.parent_span_id);
      if (!next) break;
      top = next;
    }
    if (!top || top === candidate) continue;
    if (top.span_id && toolSpanIds.has(top.span_id)) continue;
    top.tool_calls = [...(top.tool_calls ?? []), ...candidate.tool_calls!.map(call => ({ ...call }))];
  }
}
