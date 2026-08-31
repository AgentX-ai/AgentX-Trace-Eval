// What kind of step a span is: an LLM call, a tool call, a retrieval, the agent turn itself.
//
// This used to be three different guesses in three places - the Code-scorer sandbox, the
// dashboard's span buckets, and the frontend's Execution Timeline - which disagreed about the
// same span. A plain child span with no model and no tool calls rendered as "Tool" in the
// timeline and arrived as "span" in a Code scorer. Both were guesses; neither was wrong given
// what it had, because nothing on the span said what it was.
//
// So a span now states its kind, the way every other tracing product has one:
// LangSmith's required run_type, Langfuse's observation type, OpenInference's
// openinference.span.kind. Whoever produces the span knows the answer; the readers should not be
// re-deriving it from names and column nullness.
//
// Inference is kept as a fallback, not deleted - traces recorded before this existed, and manual
// tracer users who never say, still have to render sensibly. The distinction that matters is that
// a STATED kind is a fact and always wins, while an inferred one is this module's best guess.

// The vocabulary is OpenInference's, minus the kinds nothing in this product can currently
// produce. One deliberate rename: the SDK has stamped metadata.kind = "retrieval" since the RAG
// judges needed {context}, and thousands of stored spans say "retrieval" - so "retrieval" is
// canonical here and OpenInference's "retriever" is accepted as an alias, rather than migrating
// every existing row to gain nothing.
export const SPAN_KINDS = [
  "agent",
  "llm",
  "tool",
  "retrieval",
  "chain",
  "embedding",
  "reranker",
  "guardrail",
  "evaluator",
  "prompt",
] as const;

export type SpanKind = (typeof SPAN_KINDS)[number];

// Every spelling the outside world uses for these, folded onto ours. Sources: OpenInference
// (openinference.span.kind), OTel's GenAI semconv (gen_ai.operation.name), MLflow
// (mlflow.spanType), LangSmith (run_type) and Langfuse (observation type) - so a span that was
// instrumented for any of them classifies correctly here without the producer changing anything.
const ALIASES: Record<string, SpanKind> = {
  // ours / OpenInference
  retriever: "retrieval",
  // Langfuse calls an LLM call with prompt+usage a "generation"; OTel calls the operation "chat"
  // or "text_completion"; LangSmith calls the run type "llm".
  generation: "llm",
  chat: "llm",
  text_completion: "llm",
  completion: "llm",
  // OTel: gen_ai.operation.name = "execute_tool"; MLflow: spanType TOOL; LangSmith: "tool".
  execute_tool: "tool",
  function: "tool",
  // OTel: "invoke_agent" / "create_agent". MLflow: "AGENT".
  invoke_agent: "agent",
  create_agent: "agent",
  // OTel: "embeddings". MLflow/LangSmith: "embedding".
  embeddings: "embedding",
  // MLflow's own vocabulary for the rest.
  llm: "llm",
  parser: "chain",
  // LangSmith's "chain" and MLflow's "CHAIN"/"UNKNOWN" are both "some step in the middle".
  unknown: "chain",
};

// Parse whatever a producer said into our vocabulary, or null when it said nothing we recognize.
// Null is deliberately not "chain": an unrecognized kind is an unknown kind, and pretending
// otherwise would put a guess in a column whose whole purpose is to hold a stated fact.
export function normalizeSpanKind(raw: unknown): SpanKind | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if ((SPAN_KINDS as readonly string[]).includes(value)) return value as SpanKind;
  return ALIASES[value] ?? null;
}

export type SpanKindInput = {
  // The stated kind, if the producer said one (traces.spanKind).
  spanKind?: unknown;
  // Legacy statement: the SDK has written metadata.kind = "retrieval" since well before the
  // column existed, and LangChain/LlamaIndex handlers still do.
  metadata?: unknown;
  name?: string | null;
  model?: string | null;
  toolCalls?: unknown;
  parentSpanId?: string | null;
};

// The one classifier. Stated kind wins; everything after it is the fallback ladder, in the order
// the old readers used, so a trace recorded before any of this still classifies the way it did.
export function resolveSpanKind(span: SpanKindInput): SpanKind {
  const stated =
    normalizeSpanKind(span.spanKind) ?? normalizeSpanKind((span.metadata as { kind?: unknown } | null)?.kind);
  if (stated) return stated;

  // Deliberately NOT here: "a root span is the agent turn". It reads true for an agentic trace
  // and is false for the common flat one, where the root IS the LLM call - the shape every
  // `tracer.trace(..., model=...)` produces. Inferring agent from root-ness alone silently
  // emptied the dashboard's LLM-span count, which is what an inference dressed up as a fact
  // does. A root span that really is an agent turn can say so; until it does, the ladder below
  // classifies it the same way it always did.
  //
  // A span with a model is an LLM call - the rule cost attribution and the Code-scorer sandbox
  // already used, and the only one of these that is nearly always right.
  if (span.model) return "llm";
  if (Array.isArray(span.toolCalls) && span.toolCalls.length > 0) return "tool";
  // Names the SDK auto-generates, kept last: "LLM Call N" is what the Python tracer and six
  // integrations emit, and the Execution Timeline depended on that literal string until now.
  const name = span.name ?? "";
  if (/^llm call/i.test(name)) return "llm";
  if (/^retriev/i.test(name)) return "retrieval";
  // Everything else is a step in the middle. Note this is where the timeline used to say "tool",
  // which is how an unrecognized span got drawn as a tool call it never was.
  return "chain";
}

// Whether this span is a retrieval, for the RAG judges' {context} extraction. Kept as its own
// name because that is what the call sites are asking, and it is the one kind with a hard
// behavioural consequence rather than a label.
export function isRetrievalSpan(span: SpanKindInput): boolean {
  return resolveSpanKind(span) === "retrieval";
}

// Normalizes a row's toolCalls JSON into the (name, failed) list every aggregation shares.
export const toolCallList = (raw: unknown): { name: string; failed: boolean }[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tc): tc is Record<string, unknown> => !!tc && typeof tc === "object")
    .map(tc => ({
      name: typeof tc.name === "string" ? tc.name : "tool",
      failed: tc.success === false,
    }));
};
