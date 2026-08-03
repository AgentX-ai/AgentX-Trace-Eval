// Ported near-verbatim from
// AgentX-web-api/src/helpers/agentMonitoringConditions.ts: pure, dependency-free multi-condition
// evaluation for custom monitor patterns. The semantic detector is injected as a callback so this
// module never imports the LLM layer; core/monitor/detect.ts passes the real judge, tests can pass
// the fast heuristic below.
export type PatternMatchTarget = "response" | "userMessage" | "trace";

export type PatternCondition = {
  connector: "and" | "or" | "nor";
  negate: boolean;
  sources: PatternMatchTarget[];
  detector: "phrase" | "regex" | "semantic" | "external";
  // phrase text / regex body / semantic rubric / external detector's endpoint URL.
  value: string;
  caseSensitive: boolean;
};

// Returns a reason alongside the boolean so a caller can surface *why* something matched, not
// just that it did — semantic's LLM judge and the external detector's user-defined endpoint both
// naturally produce one; phrase/regex don't and simply omit it.
export type DetectorResult = { matched: boolean; reason?: string };

export type SemanticJudge = (rubric: string, text: string) => Promise<DetectorResult>;

// The standard request/response contract for detector: "external" — POSTed to the condition's
// `value` (a URL the user controls, running whatever validation logic they want; AgentX never
// sees or owns that logic, same "call out, don't reimplement" shape as every other self-host
// integration point). Response is deliberately the exact same {matches, reason} shape the
// semantic judge already returns — one calling convention for both "AI decides" and "your code
// decides." Distinct from monitor_profiles.channels' "webhook:<url>" notification targets
// (core/monitor/webhooks.ts) — that one is fire-and-forget and never consumes a response; this one
// is awaited and its verdict IS the detection result, so it needs a timeout.
export type ExternalValidatorRequest = {
  agentId: string | null;
  traceId: string | null;
  condition: { value: string };
  sources: { response: string; userMessage: string; trace: string };
  trace: { input: unknown; output: unknown; error: string | null; toolCalls: TraceLike["toolCalls"] };
};

const EXTERNAL_VALIDATOR_TIMEOUT_MS = 8000;

// Throws on any failure (network error, timeout, non-2xx, unparseable/invalid JSON body) —
// deliberately not swallowed here. Callers (evaluateDetector below) let it propagate the same way
// a semantic judge failure already does, up to detectCustomPatterns's per-pattern try/catch: skip
// *this pattern* for *this trace*, log clearly, never abort the whole sweep or block ingest.
export async function callExternalValidator(url: string, payload: ExternalValidatorRequest): Promise<DetectorResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(EXTERNAL_VALIDATOR_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`External validator ${url} responded ${res.status}`);
  }
  const body = (await res.json()) as { matches?: unknown; reason?: unknown };
  if (typeof body.matches !== "boolean") {
    throw new Error(`External validator ${url} response missing a boolean "matches" field`);
  }
  return { matched: body.matches, reason: typeof body.reason === "string" ? body.reason : undefined };
}

export type TraceLike = {
  input?: unknown;
  output?: unknown;
  error?: string | null;
  toolCalls?: Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }> | null;
};

function stringify(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildSourceTexts({ responseText, trace }: { responseText?: string | null; trace?: TraceLike | null }) {
  return {
    response: responseText ?? "",
    userMessage: stringify(trace?.input),
    trace: [
      stringify(trace?.output),
      trace?.error ?? "",
      ...((trace?.toolCalls ?? []) as NonNullable<TraceLike["toolCalls"]>).map(call =>
        [call.name, stringify(call.output), stringify(call.input)].filter(Boolean).join(" ")
      ),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function normalizeMatchTargets(value: unknown): PatternMatchTarget[] {
  const values = Array.isArray(value) ? value : [value];
  const filtered = Array.from(
    new Set(values.filter((v): v is PatternMatchTarget => v === "response" || v === "userMessage" || v === "trace"))
  );
  return filtered.length ? filtered : ["response"];
}

export function textForSources(sources: unknown, texts: { response: string; userMessage: string; trace: string }): string {
  const targets = normalizeMatchTargets(sources);
  const parts: string[] = [];
  if (targets.includes("response")) parts.push(texts.response);
  if (targets.includes("userMessage")) parts.push(texts.userMessage);
  if (targets.includes("trace")) parts.push(texts.trace);
  return parts.filter(Boolean).join("\n");
}

async function evaluateDetector(
  condition: PatternCondition,
  text: string,
  semanticJudge: SemanticJudge,
  ctx: { agentId: string | null; traceId: string | null; texts: { response: string; userMessage: string; trace: string }; trace?: TraceLike | null }
): Promise<DetectorResult> {
  const value = condition.value?.trim();
  if (!value || !text.trim()) {
    return { matched: false };
  }
  if (condition.detector === "regex") {
    try {
      return { matched: new RegExp(value, condition.caseSensitive ? "" : "i").test(text) };
    } catch {
      return { matched: false };
    }
  }
  if (condition.detector === "semantic") {
    return semanticJudge(value, text);
  }
  if (condition.detector === "external") {
    return callExternalValidator(value, {
      agentId: ctx.agentId,
      traceId: ctx.traceId,
      condition: { value },
      sources: ctx.texts,
      trace: {
        input: ctx.trace?.input ?? null,
        output: ctx.trace?.output ?? null,
        error: ctx.trace?.error ?? null,
        toolCalls: ctx.trace?.toolCalls ?? null,
      },
    });
  }
  const matched = condition.caseSensitive ? text.includes(value) : text.toLowerCase().includes(value.toLowerCase());
  return { matched };
}

// Combine conditions top to bottom: acc starts at the first row, then each row joins with its
// connector (and / or / nor = "and not"). `negate` flips a single row before it joins.
export async function evaluatePatternConditions({
  conditions,
  responseText,
  trace,
  semanticJudge,
  agentId = null,
  traceId = null,
}: {
  conditions: PatternCondition[];
  responseText?: string | null;
  trace?: TraceLike | null;
  semanticJudge: SemanticJudge;
  // Only needed by the "external" detector's request payload — every other detector ignores these.
  agentId?: string | null;
  traceId?: string | null;
}): Promise<{ overall: boolean; reasons: string[] }> {
  if (!conditions.length) {
    return { overall: false, reasons: [] };
  }
  const texts = buildSourceTexts({ responseText, trace });
  let acc: boolean | null = null;
  const reasons: string[] = [];
  for (const condition of conditions) {
    const text = textForSources(condition.sources, texts);
    const result = await evaluateDetector(condition, text, semanticJudge, { agentId, traceId, texts, trace });
    let value = result.matched;
    if (condition.negate) {
      value = !value;
    }
    // Only worth surfacing when this row actually contributed a "yes" to the final verdict — a
    // reason explaining why a negated-away or otherwise-irrelevant row matched would just be
    // confusing noise on the resulting signal.
    if (value && result.reason) {
      reasons.push(result.reason);
    }
    if (acc === null) {
      acc = value;
    } else if (condition.connector === "or") {
      acc = acc || value;
    } else if (condition.connector === "nor") {
      acc = acc && !value;
    } else {
      acc = acc && value;
    }
  }
  return { overall: acc ?? false, reasons };
}

// Fast, dependency-free semantic approximation, useful for tests. Production detection uses a
// real LLM judge instead (see core/monitor/detect.ts).
export const heuristicSemanticJudge: SemanticJudge = async (rubric, text) => {
  const words = rubric
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);
  if (!words.length) {
    return { matched: false };
  }
  const lower = text.toLowerCase();
  const hits = words.filter(word => lower.includes(word)).length;
  return { matched: hits / words.length >= 0.5 };
};
