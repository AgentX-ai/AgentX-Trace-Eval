import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";

// Extracted from AgentX-web-api's src/services/evaluationAnalysisService.ts (callJudgeJson /
// callOpenAIJson / getProviderForModel / stripJsonFences) and
// src/helpers/evaluationJudgeDefaults.ts (the constants below), the first slice of Pattern 3:
// one shared implementation instead of separate copies in the hosted SaaS and self-host.
//
// The one real change from a literal copy-paste: OpenAI/Anthropic clients are injected params,
// not module-level singleton imports, since AgentX-web-api and AgentX-trace-eval each construct
// their own (app-managed API keys vs. BYO env vars), that's what actually makes this portable
// across both. Behavior otherwise matches AgentX-web-api's implementation exactly (including
// using OpenAI's Responses API, not Chat Completions), since that's the production behavior this
// extraction must not change.

export type TokenUsage = { inputTokens: number; outputTokens: number };
// `error`/`failureReason` are populated on failure (empty provider response, or a JSON parse
// failure) so callers with their own logging setup (e.g. AgentX-web-api's structured `logger`,
// see its evaluationAnalysisService.ts) can reproduce their exact original log level/message/
// error object instead of relying on this package's own console.error fallback below, which
// still fires unconditionally as a baseline for callers that don't inspect these fields.
export type JudgeFailureReason = "emptyResponse" | "parseError";
export type JudgeCallResult = { payload: unknown; usage: TokenUsage | null; error?: unknown; failureReason?: JudgeFailureReason };
export type LlmProvider = "openai" | "anthropic";

export function getProviderForModel(model: string): LlmProvider {
  return model.startsWith("claude-") ? "anthropic" : "openai";
}

// OpenAI's reasoning-model generation (gpt-5.x) rejects some params a normal chat model accepts —
// temperature (see below) and, per core/evaluate/judge.ts's callModelWithTools, function tools
// unless reasoning_effort is forced to "none". Ad-hoc string-prefix check since the model catalog
// (portability_models) carries no such flag itself.
export function isReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5");
}

function stripJsonFences(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function callJudgeJson({
  userMessage,
  model,
  jsonSchema,
  maxTokens = 1200,
  openaiClient,
  anthropicClient,
}: {
  userMessage: string;
  model: string;
  jsonSchema: object;
  // Default (1200) matches L1's short per-item judgments; callers generating a much richer
  // schema (e.g. a full qualitative report) should pass a larger value or Anthropic will
  // truncate the JSON mid-object.
  maxTokens?: number;
  openaiClient?: OpenAI | null;
  anthropicClient?: Anthropic | null;
}): Promise<JudgeCallResult> {
  const provider = getProviderForModel(model);

  if (provider === "openai") {
    return callOpenAIJson({ userMessage, model, jsonSchema, client: openaiClient ?? null });
  }

  if (!anthropicClient) {
    console.error("judge-core: Anthropic client not provided, cannot call model", model);
    return { payload: null, usage: null };
  }

  const response = await anthropicClient.messages.create({
    model,
    max_tokens: maxTokens,
    system:
      "You are a strict evaluation judge. Return only valid JSON. Do not include markdown fences or explanatory text.",
    messages: [
      {
        role: "user",
        content: `${userMessage}\n\nYour response must strictly conform to this JSON schema:\n${JSON.stringify(jsonSchema, null, 2)}`,
      },
    ],
  });

  const usage: TokenUsage | null =
    typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null;

  const text = response.content
    .map(block => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    return { payload: null, usage, failureReason: "emptyResponse" };
  }
  try {
    return { payload: JSON.parse(stripJsonFences(text)), usage };
  } catch (error) {
    console.error("judge-core: Anthropic judge returned invalid JSON", error);
    // payload must stay null on a parse failure, matching callOpenAIJson below — a caller that
    // only checks `if (!payload)` (a common, reasonable pattern given the type says JudgeCallResult
    // returns a parsed object or null) would otherwise silently accept the raw response *string* as
    // if it were the parsed object. That's exactly what happened here before this fix: `{ ...text }`
    // spread the string into an object keyed by character index ("0", "1", "2", ...), which then got
    // persisted and silently broke every downstream field lookup (analysis.overallAssessment,
    // .instructionAdherence, etc. all reading as undefined). error/failureReason still let a caller
    // that wants the raw text for logging/debugging get at it via those fields.
    return { payload: null, usage, error, failureReason: "parseError" };
  }
}

async function callOpenAIJson({
  userMessage,
  model,
  jsonSchema,
  client,
}: {
  userMessage: string;
  model: string;
  jsonSchema: object;
  client: OpenAI | null;
}): Promise<JudgeCallResult> {
  if (!client) {
    console.error("judge-core: OpenAI client not provided, cannot call model", model);
    return { payload: null, usage: null };
  }

  const enhancedUserMessage = `${userMessage}\n\nIMPORTANT: Your response must strictly conform to this JSON schema:\n${JSON.stringify(jsonSchema, null, 2)}`;

  const response = await client.responses.create({
    model,
    temperature: isReasoningModel(model) ? undefined : 0,
    input: enhancedUserMessage,
    text: { format: { type: "json_object" as const } },
  });

  const usage: TokenUsage | null =
    typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      : null;

  const rawContent = typeof response?.output_text === "string" ? response.output_text.trim() : null;
  if (!rawContent) {
    console.error("judge-core: OpenAI returned an empty response");
    return { payload: null, usage, failureReason: "emptyResponse" };
  }

  try {
    return { payload: JSON.parse(rawContent), usage };
  } catch (error) {
    console.error("judge-core: error parsing OpenAI response", error);
    return { payload: null, usage, error, failureReason: "parseError" };
  }
}

// ---------------------------------------------------------------------------
// Judge prompt defaults (from AgentX-web-api/src/helpers/evaluationJudgeDefaults.ts)
// ---------------------------------------------------------------------------

// Variable names substitutable into a custom judgePrompt via {name} tokens. Kept small and
// deliberately not exhaustive: everything else that used to be threaded into the judge prompt
// (chain of thought, capabilities/references, criteria, per-question judge guideline, delegation
// notes) is still always appended by the caller after the substituted template, so a custom
// prompt can never silently lose that context even if it doesn't reference these three variables.
export const JUDGE_PROMPT_VARIABLES = ["input", "output", "expected"] as const;
export type JudgePromptVariable = (typeof JUDGE_PROMPT_VARIABLES)[number];

// Substitutes {name} tokens in a judge prompt template with the given values. Unknown tokens (not
// in `vars`) are left as-is rather than stripped, so a typo'd variable name is visible in the
// resulting prompt instead of silently disappearing.
export function applyJudgePromptTemplate(template: string, vars: Record<string, string>): string {
  // `vars[key] as string` (not `?? match`): this package's tsconfig has noUncheckedIndexedAccess
  // on, unlike the original web-api code this was extracted from, so a plain `vars[key]` here
  // types as `string | undefined` even after the `key in vars` check. The cast is erased at
  // compile time and changes nothing at runtime — it's the same `key in vars ? vars[key] : match`
  // as the original, not the `?? match` fallback that would actually change behavior.
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? (vars[key] as string) : match));
}

// Default judge model, used whenever a config has no judgeModel set.
export const DEFAULT_JUDGE_MODEL = "gpt-5.5";

// Default judge prompt, used whenever a config has no custom judgePrompt. This is the full
// message sent to the judge model (a raw, user-editable template): the caller substitutes
// {input}/{output}/{expected} into it, then appends per-run context (chain of thought,
// capabilities/references, criteria, judge guideline, delegation notes) that isn't part of the
// editable text since it's either bulky, structurally tied to a runtime condition, or specific to
// a single scoring path.
export const DEFAULT_JUDGE_PROMPT = `You are an expert AI evaluator. Please evaluate the following agent response against the expected results.

**User Query:** {input}

**Agent Response:**
{output}

**Expected Results:**
{expected}

Please provide:
1. A rating from 0-10 (where 0 is completely wrong, 5 is partially correct, and 10 is perfect)
2. A detailed justification explaining your rating

**LANGUAGE:** Provide your justification (and any text in your response) in the same language(s) as the evaluation dataset, i.e. the language of the User Query and Expected Results above.

CRITICAL EVALUATION RULES:
- Expected Results Are the Authoritative Ground Truth: When Expected Results are provided, treat them as correct by definition, they are the benchmark for this test. Your only job is to measure how well the agent's response agrees with the Expected Results. It is NOT your role to decide whether the Expected Results are objectively true.
- Never Argue With or Second-Guess the Expected Results: Do not use your own knowledge, outside knowledge, or "current law/facts" to dispute, correct, or fact-check the Expected Results, even if you believe them to be wrong in the real world. Score alignment only: a response that contradicts the Expected Results scores low even if you personally think the response is correct, and a response that matches them scores high even if you personally disagree. Do not editorialize in the justification that the Expected Results are wrong, outdated, or contrary to reality, anchor every statement to agreement (or disagreement) with the Expected Results, not to external truth.
- Factual Accuracy is Paramount: If the expected result contains specific facts (dates, numbers, names), the agent MUST provide those exact facts. Providing context or additional information does NOT compensate for wrong core facts.
- Dates and Numbers Must Match: If expected result is "996" and agent says "966" or any other number, this is WRONG and should receive a low score (0-3 range), regardless of how detailed the explanation is.
- No Credit for "Context" When Core Fact is Wrong: Additional historical context, nuanced explanations, or caveats do NOT make up for incorrect primary facts.
- Be Strict on Factual Queries: When the query asks for a specific fact (e.g., "When was X established?", "Who was Y?"), the response must contain that exact fact to score above 5.
- Tools Are OPTIONAL Unless Specified: Do NOT deduct points for the agent not invoking tools (e.g. retrieve) when the test step does not explicitly require specific capabilities or tools. Many queries (e.g. "2+2=?", simple general knowledge) do not need any tools. Only expect tool/capability usage when the test explicitly lists expected capabilities, expected knowledge base, or required tools.
- References in Prompt Trace = Retrieval: If "Actual Capabilities or References Used" lists documents, the agent had retrieval context available and used it; do not penalize for "Tools: None" when references are present, the agent may have used pre-supplied context instead of an explicit retrieve call.

Consider:
- Accuracy: Does the response contain the EXACT facts from expected results? (dates, numbers, names must match precisely)
- Completeness: Does it cover all aspects mentioned in expected results?
- Capability/Tool Usage: Only require tools or capabilities when explicitly specified; otherwise tools are optional. If references appear in the prompt trace, the agent had document context, do not penalize for no explicit tool call.
- Relevance: Is the response on-topic and helpful?
- Quality: Is the response well-structured and clear?`;

// ---------------------------------------------------------------------------
// Evaluation-run "analysis" narrative — the structured write-up an LLM judge produces about a
// whole run (as opposed to callJudgeJson's per-item rating). Shared between AgentX-web-api's
// evaluationAnalysisService.ts (buildRichFinalAnalysis, its L4 final-reduce step) and
// AgentX-trace-eval's core/evaluate/analysis.ts (self-host's single-judge equivalent) — both ask
// a judge model for the exact same seven fields below, so the type and JSON-schema shape were
// duplicated by hand in three places (those two backends plus the frontend's types/evaluate.ts)
// before this was extracted.
//
// Deliberately excluded: instructionChanges (hosted-only — gets written into a live agent's
// RobotConfig, which self-host has no equivalent of) and delegationAnalysis (hosted-only —
// team-evaluation concept). Callers that need them add their own fields/properties alongside
// AnalysisNarrative / analysisNarrativeSchemaProperties()'s output.
// ---------------------------------------------------------------------------

export type AnalysisRating = "high" | "medium" | "low";

export type AnalysisNarrative = {
  summary: string;
  consistencyScore: number;
  instructionAdherence: { score: number; analysis: string; deviations: string[]; rating?: AnalysisRating };
  responsePatterns: { similarities: string[]; differences: string[]; outliers: string[]; rating?: AnalysisRating };
  reasoningAnalysis: {
    cotQuality: string;
    reasoningPatterns: string[];
    reasoningGaps: string[];
    rating?: AnalysisRating;
  };
  toolUsageAnalysis: { effectiveness: string; patterns: string[]; issues: string[]; rating?: AnalysisRating };
  recommendations: {
    category: "instructions" | "tools" | "knowledge" | "reasoning" | "consistency" | "other";
    priority: AnalysisRating;
    recommendation: string;
    reasoning: string;
  }[];
  overallAssessment: { strengths: string[]; weaknesses: string[]; rating?: AnalysisRating };
};

// JSON-schema `properties` for the AnalysisNarrative fields, meant to be spread into a caller's
// own full object schema alongside caller-specific fields (instructionChanges,
// delegationAnalysis) and the caller's own top-level `required` array.
//
// requireRatings controls whether each nested object's own `required` list includes "rating":
// self-host (analysis.ts) always required it; hosted's existing schema never has, for any of the
// four sub-sections. Parameterized rather than picking one, so plugging this in changes neither
// caller's existing judge-call behavior.
export function analysisNarrativeSchemaProperties({ requireRatings = false }: { requireRatings?: boolean } = {}) {
  const ratingIfRequired = requireRatings ? (["rating"] as const) : [];
  return {
    summary: { type: "string", description: "A few sentences on how this agent performed overall." },
    consistencyScore: { type: "number", description: "0-10: how consistent responses were across similar inputs." },
    instructionAdherence: {
      type: "object",
      properties: {
        score: { type: "number", description: "0-10" },
        analysis: { type: "string" },
        deviations: { type: "array", items: { type: "string" } },
        rating: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["score", "analysis", "deviations", ...ratingIfRequired],
    },
    responsePatterns: {
      type: "object",
      properties: {
        similarities: { type: "array", items: { type: "string" }, description: "What's consistently good." },
        differences: { type: "array", items: { type: "string" } },
        outliers: { type: "array", items: { type: "string" } },
        rating: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["similarities", "differences", "outliers", ...ratingIfRequired],
    },
    reasoningAnalysis: {
      type: "object",
      properties: {
        cotQuality: { type: "string" },
        reasoningPatterns: { type: "array", items: { type: "string" } },
        reasoningGaps: { type: "array", items: { type: "string" } },
        rating: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["cotQuality", "reasoningPatterns", "reasoningGaps", ...ratingIfRequired],
    },
    toolUsageAnalysis: {
      type: "object",
      properties: {
        effectiveness: { type: "string" },
        patterns: { type: "array", items: { type: "string" } },
        issues: { type: "array", items: { type: "string" } },
        rating: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["effectiveness", "patterns", "issues", ...ratingIfRequired],
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["instructions", "tools", "knowledge", "reasoning", "consistency", "other"],
          },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          recommendation: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["category", "priority", "recommendation", "reasoning"],
      },
    },
    overallAssessment: {
      type: "object",
      properties: {
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
        rating: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["strengths", "weaknesses", "rating"],
    },
  };
}

// ---------------------------------------------------------------------------
// Similarity metrics — ported from AgentX-web-api's src/helpers/vectorSimilarityHelper.ts
// (verbatim algorithm, same behavior), extracted here so self-host's engine doesn't need a second
// copy. computeVectorSimilarity takes an injected OpenAI client (same DI pattern as callJudgeJson
// above) rather than a module-level singleton import, since AgentX-web-api and AgentX-trace-eval
// each construct their own client (app-managed API key vs. BYO env var).
// ---------------------------------------------------------------------------

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function computeJaccardSimilarity(expected: string | null | undefined, actual: string | null | undefined): number | null {
  if (!expected?.trim() || !actual?.trim()) {
    return null;
  }
  const a = new Set(tokenize(expected));
  const b = new Set(tokenize(actual));
  if (a.size === 0 && b.size === 0) {
    return null;
  }
  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) {
    return null;
  }
  return intersectionSize / unionSize;
}

function getNgrams(tokens: string[], n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const gram = tokens.slice(i, i + n).join(" ");
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

// Sentence-level BLEU (up to 4-gram) with brevity penalty. Higher-order n-grams (n>=2) use
// Chen & Cherry (2014) method-1 additive smoothing — otherwise a single unmatched 3- or 4-gram
// (common on short eval responses) zeroes out the whole geometric-mean score. Unigram precision
// (n=1) is left unsmoothed: a response sharing zero words with the expected result should score 0.
export function computeBleuScore(expected: string | null | undefined, actual: string | null | undefined): number | null {
  if (!expected?.trim() || !actual?.trim()) {
    return null;
  }
  const reference = tokenize(expected);
  const candidate = tokenize(actual);
  if (reference.length === 0 || candidate.length === 0) {
    return null;
  }

  const maxOrder = Math.min(4, candidate.length, reference.length);
  const precisions: number[] = [];
  for (let n = 1; n <= maxOrder; n++) {
    const refGrams = getNgrams(reference, n);
    const candGrams = getNgrams(candidate, n);
    let matches = 0;
    let total = 0;
    for (const [gram, count] of candGrams) {
      matches += Math.min(count, refGrams.get(gram) || 0);
      total += count;
    }
    precisions.push(n === 1 ? (total > 0 ? matches / total : 0) : (matches + 1) / (total + 1));
  }

  if (precisions[0] === 0) {
    return 0;
  }

  const logSum = precisions.reduce((sum, p) => sum + Math.log(p), 0) / precisions.length;
  const brevityPenalty = candidate.length > reference.length ? 1 : Math.exp(1 - reference.length / candidate.length);
  return Math.max(0, Math.min(1, brevityPenalty * Math.exp(logSum)));
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

// ROUGE-L: F1 of precision/recall over the longest common (in-order) subsequence.
export function computeRougeScore(expected: string | null | undefined, actual: string | null | undefined): number | null {
  if (!expected?.trim() || !actual?.trim()) {
    return null;
  }
  const reference = tokenize(expected);
  const candidate = tokenize(actual);
  if (reference.length === 0 || candidate.length === 0) {
    return null;
  }

  const lcsLength = longestCommonSubsequenceLength(reference, candidate);
  if (lcsLength === 0) {
    return 0;
  }
  const recall = lcsLength / reference.length;
  const precision = lcsLength / candidate.length;
  return Math.max(0, Math.min(1, (2 * precision * recall) / (precision + recall)));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

async function getEmbedding(client: OpenAI, text: string, model: string): Promise<number[] | null> {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  const response = await client.embeddings.create({ model, input: trimmed });
  return response.data?.[0]?.embedding ?? null;
}

export async function computeVectorSimilarity(
  expected: string | null | undefined,
  actual: string | null | undefined,
  openaiClient: OpenAI,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number | null> {
  if (!expected?.trim() || !actual?.trim()) {
    return null;
  }
  const [expectedEmb, actualEmb] = await Promise.all([
    getEmbedding(openaiClient, expected, model),
    getEmbedding(openaiClient, actual, model),
  ]);
  if (!expectedEmb || !actualEmb) {
    return null;
  }
  return Math.max(0, Math.min(1, cosineSimilarity(expectedEmb, actualEmb)));
}
