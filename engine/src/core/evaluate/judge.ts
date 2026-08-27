import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../../storage/db.js";
import { getAppSettings } from "../settings/appSettings.js";
import { isMultiTenant } from "../../auth/mode.js";
import { checkAndRecordJudgeCall } from "../shared/usage.js";

// Multi-tenant hard rule: provider keys come only from the org's own settings row - the
// process env belongs to the operator, and letting a tenant's judge calls fall back to it
// would bill one party's key for another party's usage.
const envKey = (name: string): string | null => (isMultiTenant() ? null : process.env[name] || null);
import { getPortabilityModelRaw, type PortabilityModelRow } from "./models.js";
import { logger } from "../../log.js";
import {
  callJudgeJson as callJudgeJsonShared,
  getProviderForModel,
  isReasoningModel,
  applyJudgePromptTemplate,
  computeJaccardSimilarity,
  computeBleuScore,
  computeRougeScore,
  computeVectorSimilarity as computeVectorSimilarityShared,
  DEFAULT_JUDGE_PROMPT as SHARED_DEFAULT_JUDGE_PROMPT,
  DEFAULT_REFERENCE_FREE_JUDGE_PROMPT,
  REFERENCE_FREE_EXPECTED_PLACEHOLDER,
  DEFAULT_EMBEDDING_MODEL,
  type JudgeCallResult,
} from "@agentx/judge-core";

// Thin self-host wrapper around @agentx/judge-core (see the shared-package extraction plan):
// the package holds the actual provider-routing/prompt logic, this file supplies self-host's own
// BYO-env-var clients (OPENAI_API_KEY / ANTHROPIC_API_KEY, no platform-managed client, no
// billing) and keeps self-host's existing "throw a clear setup error" UX for a missing key,
// which the package itself doesn't do (it returns a null payload instead, appropriate for a
// library that shouldn't assume how a caller wants to surface that).
export { getProviderForModel, applyJudgePromptTemplate, computeJaccardSimilarity, computeBleuScore, computeRougeScore, type JudgeCallResult };

// The hosted SaaS's default judge model ("gpt-5.5") is an internal alias, not a model string a
// plain OpenAI API key can call, so self-host defaults to a real public model name instead.
export const DEFAULT_JUDGE_MODEL = "gpt-5.6-luna";

// Ported verbatim (via @agentx/judge-core) from the hosted SaaS's default judge instructions, so
// a self-host run with no custom judgePrompt scores the same way.
export const DEFAULT_JUDGE_PROMPT = SHARED_DEFAULT_JUDGE_PROMPT;
export { DEFAULT_REFERENCE_FREE_JUDGE_PROMPT };

// DB-stored key (Platform Settings, live-editable) wins over the .env var - checked fresh on
// every call (a local sqlite read, cheap), but the actual SDK client is only reconstructed when
// the *resolved* key string changes. That's what makes a key update from the settings UI take
// effect immediately with no server restart, without needing an explicit cache-invalidation call.
let cachedOpenAIKey: string | null = null;
let cachedOpenAIClient: OpenAI | null = null;
async function getOpenAI(): Promise<OpenAI | null> {
  const settings = await getAppSettings(getDb());
  const key = settings.openaiApiKey || envKey("OPENAI_API_KEY");
  if (key !== cachedOpenAIKey) {
    cachedOpenAIKey = key;
    cachedOpenAIClient = key ? new OpenAI({ apiKey: key }) : null;
  }
  return cachedOpenAIClient;
}

let cachedAnthropicKey: string | null = null;
let cachedAnthropicClient: Anthropic | null = null;
async function getAnthropic(): Promise<Anthropic | null> {
  const settings = await getAppSettings(getDb());
  const key = settings.anthropicApiKey || envKey("ANTHROPIC_API_KEY");
  if (key !== cachedAnthropicKey) {
    cachedAnthropicKey = key;
    cachedAnthropicClient = key ? new Anthropic({ apiKey: key }) : null;
  }
  return cachedAnthropicClient;
}

// Gemini has no separate branch anywhere below: Google publishes an OpenAI-compatible endpoint
// (https://ai.google.dev/gemini-api/docs/openai) that implements chat completions, tool calling,
// and structured JSON output against the same OpenAI SDK, so a Gemini call is just an OpenAI SDK
// client pointed at Google's baseURL - every OpenAI-shaped branch in this file (callJudgeJson,
// callModelCompletion, callModelWithTools) already handles it with zero new code.
const GEMINI_OPENAI_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
let cachedGeminiKey: string | null = null;
let cachedGeminiClient: OpenAI | null = null;
async function getGemini(): Promise<OpenAI | null> {
  const settings = await getAppSettings(getDb());
  const key = settings.geminiApiKey || envKey("GEMINI_API_KEY");
  if (key !== cachedGeminiKey) {
    cachedGeminiKey = key;
    cachedGeminiClient = key ? new OpenAI({ apiKey: key, baseURL: GEMINI_OPENAI_COMPAT_BASE_URL }) : null;
  }
  return cachedGeminiClient;
}

// Custom (bring-your-own-endpoint) portability_models rows - cached by the resolved
// baseUrl+apiKey pair, same "rebuild only when the actual config changes" idiom as
// getOpenAI/getAnthropic above, so editing a custom model's key in the dashboard takes effect
// immediately without needing to clear this cache explicitly.
const customClientCache = new Map<string, OpenAI>();
function getCustomClient(row: PortabilityModelRow): OpenAI {
  const cacheKey = `${row.baseUrl}::${row.apiKey ?? ""}`;
  let client = customClientCache.get(cacheKey);
  if (!client) {
    // Most self-hosted/local model servers don't require a key at all; the SDK still needs a
    // non-empty string to construct, hence the placeholder.
    client = new OpenAI({ apiKey: row.apiKey || "not-required", baseURL: row.baseUrl! });
    customClientCache.set(cacheKey, client);
  }
  return client;
}

// Every mainstream self-hosted/local model server (vLLM, Ollama, LM Studio, text-generation-webui,
// LocalAI, ...) implements the OpenAI-compatible chat completions API, and the OpenAI SDK accepts
// any baseURL - so a "custom" catalog row doesn't need a third parallel branch anywhere below, it
// folds into the existing "openai" branch with a different client. Gemini folds in the same way,
// via Google's own OpenAI-compat endpoint (see getGemini above). This is the single place that
// decides which: every caller below (callJudgeJson/callModelCompletion/callModelWithTools) checks
// here instead of calling getProviderForModel + getOpenAI directly.
//
// keyLabel/envVar ride along separately from `provider` so a missing-key error can still say
// "Gemini"/"GEMINI_API_KEY" instead of a misleading "OpenAI" even though Gemini reuses the OpenAI
// SDK code path. isGemini lets callModelWithTools skip the one OpenAI-reasoning-model-specific
// param (reasoning_effort) that Google's compat layer doesn't recognize.
type ModelRouting = {
  provider: "openai" | "anthropic";
  openaiClient: OpenAI | null;
  keyLabel: "OpenAI" | "Anthropic" | "Gemini";
  envVar: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY";
  isGemini: boolean;
  // Custom baseURL (vLLM/Ollama/LM Studio/...) - like isGemini, marks an OpenAI-compat endpoint
  // that reuses the OpenAI code path but may not implement every native-OpenAI feature (strict
  // json_schema structured outputs being the current example, see callJudgeJson below).
  isCustom: boolean;
};

async function resolveModelRouting(model: string): Promise<ModelRouting> {
  const custom = await getPortabilityModelRaw(getDb(), model);
  if (custom?.provider === "custom" && custom.baseUrl) {
    return {
      provider: "openai",
      openaiClient: getCustomClient(custom),
      keyLabel: "OpenAI",
      envVar: "OPENAI_API_KEY",
      isGemini: false,
      isCustom: true,
    };
  }
  if (custom?.provider === "gemini" || (!custom && model.startsWith("gemini-"))) {
    return {
      provider: "openai",
      openaiClient: await getGemini(),
      keyLabel: "Gemini",
      envVar: "GEMINI_API_KEY",
      isGemini: true,
      isCustom: false,
    };
  }
  const provider = getProviderForModel(model);
  return {
    provider,
    openaiClient: provider === "openai" ? await getOpenAI() : null,
    keyLabel: provider === "openai" ? "OpenAI" : "Anthropic",
    envVar: provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
    isGemini: false,
    isCustom: false,
  };
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

// The actual "score input/output against criteria" primitive - extracted out of
// core/evaluate/runs.ts's scoreOneResult (which additionally resolves a per-question golden
// answer from a dataset, a concept that doesn't apply here) so both offline batch runs and
// core/monitor/onlineEvaluators.ts's live-traffic scoring call the exact same judge logic rather
// than each having their own copy.
export async function scoreAgainstCriteria(
  criteria: JudgeCriteria,
  content: {
    input: string;
    output: string;
    expected?: string;
    judgeGuideline?: string;
    context?: string;
    // The agent's actual execution trajectory (rendered by core/trace/trajectory.ts) - appended
    // as its own labeled block so any judge, default or custom, can weigh the path taken (tools
    // called, order, failures) and not just the final answer.
    trajectory?: string;
    // toolContext="detailed" only (core/trace/trajectory.ts's renderUsedToolDefinitions):
    // definitions of the tools the agent USED plus a one-line unused-tools mention - placed
    // AFTER the trajectory, since it explains the calls the judge just read.
    toolDefinitions?: string;
  }
): Promise<{ rating: number; justification: string }> {
  // Mode-aware prompt selection. With no reference answer, the default prompt's Expected Results
  // rules ("authoritative ground truth", "must match... low score") would anchor the judge on a
  // benchmark that reads "N/A" - so the default swaps to the reference-free sibling, and a CUSTOM
  // prompt (whose structure we can't rewrite) gets a substitution that defuses those rules
  // in place. With a reference answer, behavior is exactly what it always was.
  const hasExpected = !!content.expected;
  const promptTemplate =
    !hasExpected && criteria.judgePrompt === DEFAULT_JUDGE_PROMPT
      ? DEFAULT_REFERENCE_FREE_JUDGE_PROMPT
      : criteria.judgePrompt;
  const substitutedPrompt = applyJudgePromptTemplate(promptTemplate, {
    input: content.input,
    output: content.output,
    expected: content.expected || REFERENCE_FREE_EXPECTED_PLACEHOLDER,
    // RAG-style prompts (the built-in metric pack) reference {context}; every other template
    // simply never mentions the token, so this is inert for them.
    context: content.context || "(no retrieval context provided)",
  });

  const additionalContext = `
${content.trajectory ? `**Agent execution trajectory (what the agent actually did to produce the output):**\n${content.trajectory}\n` : ""}
${content.toolDefinitions ? `**Tool definitions (for the tools in the trajectory above):**\n${content.toolDefinitions}\n` : ""}
${content.judgeGuideline ? `**Judge Guideline (specific to this question):** ${content.judgeGuideline}` : ""}
${criteria.acceptanceCriteria ? `**Acceptance Criteria:** ${criteria.acceptanceCriteria}` : ""}
${criteria.rejectionCriteria ? `**Rejection Criteria:** ${criteria.rejectionCriteria}` : ""}
${criteria.evaluationCriteria ? `**Evaluation Criteria:** ${criteria.evaluationCriteria}` : ""}
`;

  const judgeResult = await callJudgeJson({
    model: criteria.judgeModel,
    jsonSchema: SCORE_SCHEMA,
    // Both SCORE_SCHEMA properties are required, so OpenAI's strict structured outputs apply:
    // the decoder cannot produce unparseable JSON at all on that path.
    strictSchema: true,
    userMessage: `${substitutedPrompt}\n${additionalContext}`,
  });
  const payload = judgeResult.payload as { rating: number; justification: string } | null;
  if (!payload) {
    // A judge that returned nothing usable is a FAILURE, not a verdict. This used to return
    // rating 0, which offline was averaged into the run/gate as if the agent had answered
    // terribly, and online raised a real Signal - a provider hiccup indistinguishable from a
    // catastrophic answer. Throwing routes every caller onto its existing failure path
    // (offline: status "skipped", rating null; online: judge_failure event, no Signal).
    throw new JudgeFailedError(judgeResult.failureReason ?? "emptyResponse");
  }
  return { rating: payload.rating, justification: payload.justification };
}

// The judge model was reachable but produced no usable verdict (empty response or unparseable
// JSON, after judge-core's automatic retry). Distinct from the setup errors thrown by
// callJudgeJson below (missing API key, quota) so callers can label the failure precisely.
export class JudgeFailedError extends Error {
  readonly failureReason: string;
  constructor(failureReason: string) {
    super(`Judge scoring failed: the judge model returned no usable verdict (${failureReason}, retried once)`);
    this.name = "JudgeFailedError";
    this.failureReason = failureReason;
  }
}

export async function callJudgeJson({
  userMessage,
  model,
  jsonSchema,
  maxTokens,
  strictSchema,
}: {
  userMessage: string;
  model: string;
  jsonSchema: object;
  maxTokens?: number;
  // Pass only for schemas whose every property is required - see judge-core's callJudgeJson.
  strictSchema?: boolean;
}): Promise<JudgeCallResult> {
  // Metering + daily quota, both scoped by the request's tenancy context (see
  // core/shared/usage.ts). Every judge path in the engine funnels through here.
  await checkAndRecordJudgeCall(model);
  const { provider, openaiClient, keyLabel, envVar, isGemini, isCustom } = await resolveModelRouting(model);
  if (provider === "anthropic" && !(await getAnthropic())) {
    throw new Error(
      `Judge model "${model}" needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart agentx-server.`
    );
  }
  if (provider === "openai" && !openaiClient) {
    throw new Error(`Judge model "${model}" needs a ${keyLabel} API key. Set ${envVar} and restart agentx-server.`);
  }

  return callJudgeJsonShared({
    userMessage,
    model,
    jsonSchema,
    maxTokens,
    // Strict structured outputs only on the real OpenAI endpoint - the OpenAI-compat layers
    // (Gemini, vLLM/Ollama/... custom baseURLs) don't reliably implement json_schema strict
    // mode, and a rejected request would turn a fine judge model into a scoring failure.
    strictSchema: strictSchema && !isGemini && !isCustom,
    openaiClient,
    anthropicClient: await getAnthropic(),
  });
}

// Vector similarity needs an OpenAI client for embeddings regardless of which provider judges the
// rating - self-host's judge model can be Anthropic, but embeddings are OpenAI-only here (matches
// the hosted platform's own vectorSimilarityHelper.ts). Returns null (not a throw) when no
// OPENAI_API_KEY is set, same graceful-degradation behavior as a missing expected/actual string -
// this metric is opt-in, so a missing key shouldn't fail the whole result's scoring.
export async function computeVectorSimilarity(
  expected: string | null | undefined,
  actual: string | null | undefined,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number | null> {
  const client = await getOpenAI();
  if (!client) {
    return null;
  }
  try {
    return await computeVectorSimilarityShared(expected, actual, client, model);
  } catch (err) {
    logger.error({ err: err }, "Vector similarity computation failed:");
    return null;
  }
}

// Raw embedding vector for a piece of text - used by Topics' "Map" view (core/monitor/topics.ts's
// getTopicsMap) to position classified traces by semantic similarity via UMAP. Same
// graceful-degradation posture as computeVectorSimilarity above (null, not a throw, on a missing
// key or API failure - Topics classification itself shouldn't fail just because the map's
// embedding call did). @agentx/judge-core has its own private getEmbedding used internally by
// computeVectorSimilarityShared, but it's unexported and embeddings are self-host-only here
// anyway (matching computeVectorSimilarity's own reasoning for staying out of the shared
// package), so this calls the OpenAI client directly rather than adding a new export there.
export async function computeEmbedding(text: string, model: string = DEFAULT_EMBEDDING_MODEL): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const client = await getOpenAI();
  if (!client) {
    return null;
  }
  try {
    const response = await client.embeddings.create({ model, input: trimmed });
    return response.data?.[0]?.embedding ?? null;
  } catch (err) {
    logger.error({ err: err }, "Embedding computation failed:");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model portability (core/evaluate/portability.ts) - a plain, free-text completion, distinct from
// callJudgeJson above which always forces a JSON-schema-constrained response. Portability needs a
// candidate model's natural answer (to then judge-score it), not a structured verdict.
// Deliberately not added to @agentx/judge-core: that package is a genuine hosted+self-host shared
// extraction today, and there's no visibility here into whether/how AgentX-web-api's own
// Sovereignty Index already does plain completions - a "shared" primitive only self-host actually
// uses would risk presuming parity that hasn't been verified. Revisit if the hosted side wants to
// consolidate onto it.
export type ReconstructedContext = {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
};
export type ModelCompletion = { text: string; usage: { inputTokens: number; outputTokens: number } | null };

export async function callModelCompletion(model: string, reconstructed: ReconstructedContext): Promise<ModelCompletion> {
  const { provider, openaiClient, keyLabel, envVar } = await resolveModelRouting(model);

  if (provider === "anthropic") {
    const client = await getAnthropic();
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

  const client = openaiClient;
  if (!client) {
    throw new Error(`Model "${model}" needs a ${keyLabel} API key. Set ${envVar} and restart agentx-server.`);
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

// ---------------------------------------------------------------------------
// Tool-calling (core/evaluate/playground.ts only) - Model Portability deliberately never
// reproduces tool-calling (README: translating an arbitrary captured schema into each provider's
// own format is real separate work it doesn't attempt), so this is a genuinely separate primitive
// from callModelCompletion above rather than an extension of it; that function and its one caller
// are untouched.
// ---------------------------------------------------------------------------

export type ToolDefinition = { name: string; description?: string; parameters: Record<string, unknown> };
export type ToolCallTrace = { name: string; arguments: Record<string, unknown>; result?: unknown; error?: string };
export type ModelWithToolsResult = {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  toolCalls: ToolCallTrace[];
};

// In-process CPU/network-bound loop, not a hard cost cap - just enough to stop a prompt that keeps
// asking for more tools (or a tool that keeps telling the model to call it again) from looping
// forever. Each round is a full model call, so 5 is already a lot of real API calls for one grid
// cell.
const MAX_TOOL_ROUNDS = 5;

// Drives a real tool-call round-trip: send the conversation (+ tool schemas) to the model, and for
// every tool call it asks for, await `callTool(name, arguments)` - Playground supplies that as an
// HTTP POST to the tool's own endpoint (see playground.ts), this function has no concept of
// "endpoint," just a callback, so it stays a provider-calling primitive, not app-specific business
// logic. A `callTool` failure isolates to that one call's `{error}`, fed back to the model as the
// tool result (lets you see how the prompt handles a failing tool) rather than aborting the run.
// Called with `tools: []` too (Playground always calls this, never callModelCompletion directly) -
// degenerates to exactly one round with no tool_calls, same behavior as callModelCompletion.
export async function callModelWithTools(
  model: string,
  reconstructed: ReconstructedContext,
  tools: ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  // Per-model overrides (Playground's "Model settings" - see playground.ts). Both omitted means
  // today's exact defaults: Anthropic still gets its required max_tokens: 1200, OpenAI stays
  // uncapped, neither provider gets an explicit temperature.
  options?: { maxTokens?: number; temperature?: number }
): Promise<ModelWithToolsResult> {
  const { provider, openaiClient, keyLabel, envVar, isGemini } = await resolveModelRouting(model);
  const toolCalls: ToolCallTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  if (provider === "anthropic") {
    const client = await getAnthropic();
    if (!client) {
      throw new Error(`Model "${model}" needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart agentx-server.`);
    }
    const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = reconstructed.messages.map(m => ({ role: m.role, content: m.content }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model,
        // Required on every Anthropic request, can't be omitted - 1200 is today's unchanged
        // default when the caller doesn't override it.
        max_tokens: options?.maxTokens ?? 1200,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(reconstructed.system ? { system: reconstructed.system } : {}),
        messages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      });
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;

      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUseBlocks.length === 0) {
        const text = response.content
          .map(block => ("text" in block && typeof block.text === "string" ? block.text : ""))
          .join("")
          .trim();
        return { text, usage: { inputTokens, outputTokens }, toolCalls };
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const args = (block.input as Record<string, unknown>) ?? {};
        const trace: ToolCallTrace = { name: block.name, arguments: args };
        try {
          trace.result = await callTool(block.name, args);
        } catch (err) {
          trace.error = err instanceof Error ? err.message : "Tool call failed";
        }
        toolCalls.push(trace);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(trace.error ? { error: trace.error } : trace.result),
          ...(trace.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    return { text: "", usage: { inputTokens, outputTokens }, toolCalls };
  }

  const client = openaiClient;
  if (!client) {
    throw new Error(`Model "${model}" needs a ${keyLabel} API key. Set ${envVar} and restart agentx-server.`);
  }
  const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(reconstructed.system ? [{ role: "system" as const, content: reconstructed.system }] : []),
    ...reconstructed.messages.map(m => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      // Reasoning models in this catalog reject function tools alongside a nonzero reasoning
      // effort ("Function tools with reasoning_effort are not supported... set reasoning_effort
      // to 'none'", confirmed against a real running model) - "none" isn't in the SDK's own
      // ReasoningEffort type yet (a newer model generation than the SDK's typings know about),
      // hence the cast; only sent when tools are actually in play, so a tool-less run is
      // completely unaffected. Gated to reasoning models only: non-reasoning OpenAI models
      // (gpt-4o-mini) reject the parameter outright with "Unrecognized request argument"
      // (confirmed live), and Gemini's OpenAI-compat layer doesn't document it either.
      ...(openaiTools.length > 0 && !isGemini && isReasoningModel(model)
        ? { reasoning_effort: "none" as OpenAI.Chat.ChatCompletionReasoningEffort }
        : {}),
      // max_tokens is deprecated on chat completions in favor of max_completion_tokens (the
      // unified param that also covers reasoning-model completions) - only sent when overridden,
      // preserving today's "uncapped unless told otherwise" default.
      ...(options?.maxTokens !== undefined ? { max_completion_tokens: options.maxTokens } : {}),
      // Reasoning models reject a non-default temperature outright - silently omitted rather than
      // letting the call 400, same isolation posture as everywhere else a per-model quirk exists.
      ...(options?.temperature !== undefined && !isReasoningModel(model) ? { temperature: options.temperature } : {}),
    });
    inputTokens += response.usage?.prompt_tokens ?? 0;
    outputTokens += response.usage?.completion_tokens ?? 0;

    const message = response.choices[0]?.message;
    const toolCallsInRound = message?.tool_calls ?? [];
    if (toolCallsInRound.length === 0) {
      return { text: message?.content?.trim() ?? "", usage: { inputTokens, outputTokens }, toolCalls };
    }

    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: toolCallsInRound });
    for (const call of toolCallsInRound) {
      // openai v7: tool_calls is a union of function and custom tool calls. Everything this loop
      // executes came from the function tools we sent, so a non-function member (a model echoing
      // a custom tool we never offered) is answered with an error result rather than crashed on.
      if (call.type !== "function") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Unsupported tool call type: ${call.type}` }),
        });
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Malformed JSON from the model itself - treat as empty args rather than failing the call.
      }
      const trace: ToolCallTrace = { name: call.function.name, arguments: args };
      try {
        trace.result = await callTool(call.function.name, args);
      } catch (err) {
        trace.error = err instanceof Error ? err.message : "Tool call failed";
      }
      toolCalls.push(trace);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(trace.error ? { error: trace.error } : trace.result),
      });
    }
  }

  return { text: "", usage: { inputTokens, outputTokens }, toolCalls };
}

const SMOKE_TEST_VARIANTS_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: { type: "string" },
      description: "Paraphrased variants of the original question, same intent, different wording",
    },
  },
  required: ["variants"],
};

// Smoke test: paraphrased variants of a question, to catch an agent that's brittle to phrasing
// rather than genuinely wrong (see AgentX-Python's DatasetBuilder.add_case's smoke_test_count/
// smoke_test_guidance). Called once at init_run time (core/evaluate/runs.ts) per question that
// requests it, frozen for the lifetime of that run - never regenerated mid-run.
//
// Best-effort: a judge-call failure (missing API key, provider outage) returns an empty array
// rather than failing the whole run. Smoke tests are additive on top of a run's normal questions;
// losing them shouldn't block scoring the questions that matter.
export async function generateSmokeTestVariants(
  query: string,
  count: number,
  guidance: string | undefined,
  judgeModel: string = DEFAULT_JUDGE_MODEL
): Promise<string[]> {
  const guidanceLine = guidance ? `\nStyle guidance for the variants: ${guidance}` : "";
  const prompt = `Generate exactly ${count} different paraphrased versions of the question below - each one a realistic way a real user might actually type it. Keep the same underlying intent/meaning as the original; only the phrasing/wording should change.${guidanceLine}

Original question: ${query}`;
  try {
    const result = await callJudgeJson({ model: judgeModel, jsonSchema: SMOKE_TEST_VARIANTS_SCHEMA, userMessage: prompt });
    const payload = result.payload as { variants?: unknown } | null;
    const variants = Array.isArray(payload?.variants)
      ? payload!.variants.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    return variants.slice(0, count);
  } catch (err) {
    logger.error({ err: err }, "Smoke test variant generation failed:");
    return [];
  }
}

// No "expected results" framing at all, unlike DEFAULT_JUDGE_PROMPT above - a live captured trace
// has no ground truth to compare against, so this judges each candidate's response purely on its
// own merits. Every model in a portability comparison (including the originally-captured output)
// is scored with this exact same rubric, so ratings are directly comparable across models.
const PORTABILITY_JUDGE_PROMPT = `You are evaluating how well an AI response answers a user's question. There is no "correct" reference answer provided for this comparison - judge the response entirely on its own merits.

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
