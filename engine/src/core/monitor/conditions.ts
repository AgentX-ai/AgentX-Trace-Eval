// Ported near-verbatim from
// AgentX-web-api/src/helpers/agentMonitoringConditions.ts: pure, dependency-free multi-condition
// evaluation for custom monitor patterns. The semantic detector is injected as a callback so this
// module never imports the LLM layer; core/monitor/detect.ts passes the real judge, tests can pass
// the fast heuristic below. (regexSafety.js is the one import, and is itself pure.)
import { compileUserRegex, hasNestedQuantifier } from "./regexSafety.js";
import { logger } from "../../log.js";

export type PatternMatchTarget = "response" | "userMessage" | "trace";

export type PatternCondition = {
  connector: "and" | "or" | "nor";
  negate: boolean;
  sources: PatternMatchTarget[];
  detector: "phrase" | "regex" | "semantic";
  // phrase text / regex body / semantic rubric.
  value: string;
  caseSensitive: boolean;
};

// Returns a reason alongside the boolean so a caller can surface *why* something matched, not
// just that it did - semantic's LLM judge naturally produces one; phrase/regex don't and simply
// omit it.
export type DetectorResult = { matched: boolean; reason?: string };

export type SemanticJudge = (rubric: string, text: string) => Promise<DetectorResult>;

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

async function evaluateDetector(condition: PatternCondition, text: string, semanticJudge: SemanticJudge): Promise<DetectorResult> {
  const value = condition.value?.trim();
  if (!value || !text.trim()) {
    return { matched: false };
  }
  if (condition.detector === "regex") {
    // Rejected at save time now (regexSafety.ts), but a row stored before that would still reach
    // here. RE2 below would run it in linear time anyway; the skip stays so the operator is told
    // the pattern is wrong rather than left wondering why it never fires.
    if (hasNestedQuantifier(value)) {
      logger.error(
        { pattern: value },
        "Skipping monitor regex: nested unbounded quantifiers can take exponential time. Edit the pattern to remove the nesting."
      );
      return { matched: false };
    }
    // Matched against agent output, which end users influence - see compileUserRegex.
    const compiled = compileUserRegex(value, { caseSensitive: condition.caseSensitive });
    if (!compiled.ok) {
      // Reaches here only for a row stored before save-time validation, or one using syntax RE2
      // does not accept (lookaround, backreferences). Silence would look like "never matches".
      logger.error({ err: compiled.error, pattern: value }, "Skipping monitor regex: it does not compile");
      return { matched: false };
    }
    return { matched: compiled.regex.test(text) };
  }
  if (condition.detector === "semantic") {
    return semanticJudge(value, text);
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
}: {
  conditions: PatternCondition[];
  responseText?: string | null;
  trace?: TraceLike | null;
  semanticJudge: SemanticJudge;
}): Promise<{ overall: boolean; reasons: string[] }> {
  if (!conditions.length) {
    return { overall: false, reasons: [] };
  }
  const texts = buildSourceTexts({ responseText, trace });
  let acc: boolean | null = null;
  const reasons: string[] = [];
  for (const condition of conditions) {
    const text = textForSources(condition.sources, texts);
    const result = await evaluateDetector(condition, text, semanticJudge);
    let value = result.matched;
    if (condition.negate) {
      value = !value;
    }
    // Only worth surfacing when this row actually contributed a "yes" to the final verdict - a
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
