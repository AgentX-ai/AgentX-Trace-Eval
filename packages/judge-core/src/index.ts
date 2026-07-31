import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";

// Extracted from AgentX-web-api's src/services/evaluationAnalysisService.ts (callJudgeJson /
// callOpenAIJson / getProviderForModel / stripJsonFences) and
// src/helpers/evaluationJudgeDefaults.ts (the constants below), the first slice of Pattern 3:
// one shared implementation instead of separate copies in the hosted SaaS and self-host.
//
// The one real change from a literal copy-paste: OpenAI/Anthropic clients are injected params,
// not module-level singleton imports, since AgentX-web-api and AgentX-SelfHosted each construct
// their own (app-managed API keys vs. BYO env vars), that's what actually makes this portable
// across both. Behavior otherwise matches AgentX-web-api's implementation exactly (including
// using OpenAI's Responses API, not Chat Completions), since that's the production behavior this
// extraction must not change.

export type TokenUsage = { inputTokens: number; outputTokens: number };
export type JudgeCallResult = { payload: unknown; usage: TokenUsage | null };
export type LlmProvider = "openai" | "anthropic";

export function getProviderForModel(model: string): LlmProvider {
  return model.startsWith("claude-") ? "anthropic" : "openai";
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
    return { payload: null, usage };
  }
  try {
    return { payload: JSON.parse(stripJsonFences(text)), usage };
  } catch (error) {
    console.error("judge-core: Anthropic judge returned invalid JSON", error);
    return { payload: text, usage };
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
    temperature: model.startsWith("gpt-5") ? undefined : 0,
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
    return { payload: null, usage };
  }

  try {
    return { payload: JSON.parse(rawContent), usage };
  } catch (error) {
    console.error("judge-core: error parsing OpenAI response", error);
    return { payload: null, usage };
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
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? (vars[key] ?? match) : match));
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
