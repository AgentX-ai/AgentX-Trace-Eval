import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  callJudgeJson as callJudgeJsonShared,
  getProviderForModel,
  applyJudgePromptTemplate,
  DEFAULT_JUDGE_PROMPT as SHARED_DEFAULT_JUDGE_PROMPT,
  type JudgeCallResult,
} from "@agentx/judge-core";

// Thin self-host wrapper around @agentx/judge-core (see the shared-package extraction plan):
// the package holds the actual provider-routing/prompt logic, this file supplies self-host's own
// BYO-env-var clients (OPENAI_API_KEY / ANTHROPIC_API_KEY, no platform-managed client, no
// billing) and keeps self-host's existing "throw a clear setup error" UX for a missing key,
// which the package itself doesn't do (it returns a null payload instead, appropriate for a
// library that shouldn't assume how a caller wants to surface that).
export { getProviderForModel, applyJudgePromptTemplate, type JudgeCallResult };

// The hosted SaaS's default judge model ("gpt-5.5") is an internal alias, not a model string a
// plain OpenAI API key can call, so self-host defaults to a real public model name instead.
export const DEFAULT_JUDGE_MODEL = "gpt-4.1-mini";

// Ported verbatim (via @agentx/judge-core) from the hosted SaaS's default judge instructions, so
// a self-host run with no custom judgePrompt scores the same way.
export const DEFAULT_JUDGE_PROMPT = SHARED_DEFAULT_JUDGE_PROMPT;

let openaiClient: OpenAI | null | undefined;
function getOpenAI(): OpenAI | null {
  if (openaiClient === undefined) {
    openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  }
  return openaiClient;
}

let anthropicClient: Anthropic | null | undefined;
function getAnthropic(): Anthropic | null {
  if (anthropicClient === undefined) {
    anthropicClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  }
  return anthropicClient;
}

export type JudgeCriteria = {
  acceptanceCriteria: string;
  rejectionCriteria: string;
  evaluationCriteria: string;
  judgePrompt: string;
  judgeModel: string;
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "number", description: "Rating from 0-10" },
    justification: { type: "string", description: "Detailed explanation" },
  },
  required: ["rating", "justification"],
};

// The actual "score input/output against criteria" primitive — extracted out of
// core/evaluate/runs.ts's scoreOneResult (which additionally resolves a per-question golden
// answer from a dataset, a concept that doesn't apply here) so both offline batch runs and
// core/monitor/onlineEvaluators.ts's live-traffic scoring call the exact same judge logic rather
// than each having their own copy.
export async function scoreAgainstCriteria(
  criteria: JudgeCriteria,
  content: { input: string; output: string; expected?: string; judgeGuideline?: string }
): Promise<{ rating: number; justification: string }> {
  const substitutedPrompt = applyJudgePromptTemplate(criteria.judgePrompt, {
    input: content.input,
    output: content.output,
    expected: content.expected || "N/A",
  });

  const additionalContext = `
${content.judgeGuideline ? `**Judge Guideline (specific to this question):** ${content.judgeGuideline}` : ""}
${criteria.acceptanceCriteria ? `**Acceptance Criteria:** ${criteria.acceptanceCriteria}` : ""}
${criteria.rejectionCriteria ? `**Rejection Criteria:** ${criteria.rejectionCriteria}` : ""}
${criteria.evaluationCriteria ? `**Evaluation Criteria:** ${criteria.evaluationCriteria}` : ""}
`;

  const judgeResult = await callJudgeJson({
    model: criteria.judgeModel,
    jsonSchema: SCORE_SCHEMA,
    userMessage: `${substitutedPrompt}\n${additionalContext}`,
  });
  const payload = judgeResult.payload as { rating: number; justification: string } | null;
  if (!payload) {
    return { rating: 0, justification: "Scoring failed: no result returned from the judge model" };
  }
  return { rating: payload.rating, justification: payload.justification };
}

export async function callJudgeJson({
  userMessage,
  model,
  jsonSchema,
  maxTokens,
}: {
  userMessage: string;
  model: string;
  jsonSchema: object;
  maxTokens?: number;
}): Promise<JudgeCallResult> {
  const provider = getProviderForModel(model);
  if (provider === "anthropic" && !getAnthropic()) {
    throw new Error(
      `Judge model "${model}" needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart agentx-server.`
    );
  }
  if (provider === "openai" && !getOpenAI()) {
    throw new Error(`Judge model "${model}" needs an OpenAI API key. Set OPENAI_API_KEY and restart agentx-server.`);
  }

  return callJudgeJsonShared({
    userMessage,
    model,
    jsonSchema,
    maxTokens,
    openaiClient: getOpenAI(),
    anthropicClient: getAnthropic(),
  });
}

// ---------------------------------------------------------------------------
// Model portability (core/evaluate/portability.ts) — a plain, free-text completion, distinct from
// callJudgeJson above which always forces a JSON-schema-constrained response. Portability needs a
// candidate model's natural answer (to then judge-score it), not a structured verdict.
// Deliberately not added to @agentx/judge-core: that package is a genuine hosted+self-host shared
// extraction today, and there's no visibility here into whether/how AgentX-web-api's own
// Sovereignty Index already does plain completions — a "shared" primitive only self-host actually
// uses would risk presuming parity that hasn't been verified. Revisit if the hosted side wants to
// consolidate onto it.
export type ReconstructedContext = {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
};
export type ModelCompletion = { text: string; usage: { inputTokens: number; outputTokens: number } | null };

export async function callModelCompletion(model: string, reconstructed: ReconstructedContext): Promise<ModelCompletion> {
  const provider = getProviderForModel(model);

  if (provider === "anthropic") {
    const client = getAnthropic();
    if (!client) {
      throw new Error(`Model "${model}" needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart agentx-server.`);
    }
    const response = await client.messages.create({
      model,
      max_tokens: 1200,
      ...(reconstructed.system ? { system: reconstructed.system } : {}),
      messages: reconstructed.messages.map(m => ({ role: m.role, content: m.content })),
    });
    const text = response.content
      .map(block => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("")
      .trim();
    const usage =
      typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : null;
    return { text, usage };
  }

  const client = getOpenAI();
  if (!client) {
    throw new Error(`Model "${model}" needs an OpenAI API key. Set OPENAI_API_KEY and restart agentx-server.`);
  }
  const messages = [
    ...(reconstructed.system ? [{ role: "system" as const, content: reconstructed.system }] : []),
    ...reconstructed.messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const response = await client.chat.completions.create({ model, messages });
  const text = response.choices[0]?.message?.content?.trim() ?? "";
  const usage =
    typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
      ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
      : null;
  return { text, usage };
}

// No "expected results" framing at all, unlike DEFAULT_JUDGE_PROMPT above — a live captured trace
// has no ground truth to compare against, so this judges each candidate's response purely on its
// own merits. Every model in a portability comparison (including the originally-captured output)
// is scored with this exact same rubric, so ratings are directly comparable across models.
const PORTABILITY_JUDGE_PROMPT = `You are evaluating how well an AI response answers a user's question. There is no "correct" reference answer provided for this comparison — judge the response entirely on its own merits.

**User's input:**
{input}

**AI's response:**
{output}

Rate the response from 0-10 on how helpful, accurate, relevant, and well-structured it is. Provide a 1-2 sentence justification for your rating.`;

export async function scorePortabilityResponse(
  input: string,
  output: string,
  judgeModel: string = DEFAULT_JUDGE_MODEL
): Promise<{ rating: number; justification: string }> {
  const prompt = applyJudgePromptTemplate(PORTABILITY_JUDGE_PROMPT, { input, output, expected: "" });
  const result = await callJudgeJson({ model: judgeModel, jsonSchema: SCORE_SCHEMA, userMessage: prompt });
  const payload = result.payload as { rating: number; justification: string } | null;
  if (!payload) {
    throw new Error("Judge model returned no result");
  }
  return { rating: payload.rating, justification: payload.justification };
}
