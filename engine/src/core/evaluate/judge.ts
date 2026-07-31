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
