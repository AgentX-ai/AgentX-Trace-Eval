import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  callJudgeJson as callJudgeJsonShared,
  getProviderForModel,
  applyJudgePromptTemplate,
  computeJaccardSimilarity,
  computeBleuScore,
  computeRougeScore,
  computeVectorSimilarity as computeVectorSimilarityShared,
  DEFAULT_JUDGE_PROMPT as SHARED_DEFAULT_JUDGE_PROMPT,
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

// Vector similarity needs an OpenAI client for embeddings regardless of which provider judges the
// rating — self-host's judge model can be Anthropic, but embeddings are OpenAI-only here (matches
// the hosted platform's own vectorSimilarityHelper.ts). Returns null (not a throw) when no
// OPENAI_API_KEY is set, same graceful-degradation behavior as a missing expected/actual string —
// this metric is opt-in, so a missing key shouldn't fail the whole result's scoring.
export async function computeVectorSimilarity(
  expected: string | null | undefined,
  actual: string | null | undefined,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number | null> {
  const client = getOpenAI();
  if (!client) {
    return null;
  }
  try {
    return await computeVectorSimilarityShared(expected, actual, client, model);
  } catch (err) {
    console.error("Vector similarity computation failed:", err);
    return null;
  }
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

// ---------------------------------------------------------------------------
// Tool-calling (core/evaluate/playground.ts only) — Model Portability deliberately never
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

// In-process CPU/network-bound loop, not a hard cost cap — just enough to stop a prompt that keeps
// asking for more tools (or a tool that keeps telling the model to call it again) from looping
// forever. Each round is a full model call, so 5 is already a lot of real API calls for one grid
// cell.
const MAX_TOOL_ROUNDS = 5;

// Drives a real tool-call round-trip: send the conversation (+ tool schemas) to the model, and for
// every tool call it asks for, await `callTool(name, arguments)` — Playground supplies that as an
// HTTP POST to the tool's own endpoint (see playground.ts), this function has no concept of
// "endpoint," just a callback, so it stays a provider-calling primitive, not app-specific business
// logic. A `callTool` failure isolates to that one call's `{error}`, fed back to the model as the
// tool result (lets you see how the prompt handles a failing tool) rather than aborting the run.
// Called with `tools: []` too (Playground always calls this, never callModelCompletion directly) —
// degenerates to exactly one round with no tool_calls, same behavior as callModelCompletion.
export async function callModelWithTools(
  model: string,
  reconstructed: ReconstructedContext,
  tools: ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
): Promise<ModelWithToolsResult> {
  const provider = getProviderForModel(model);
  const toolCalls: ToolCallTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  if (provider === "anthropic") {
    const client = getAnthropic();
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
        max_tokens: 1200,
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

  const client = getOpenAI();
  if (!client) {
    throw new Error(`Model "${model}" needs an OpenAI API key. Set OPENAI_API_KEY and restart agentx-server.`);
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
      // to 'none'", confirmed against a real running model) — "none" isn't in the SDK's own
      // ReasoningEffort type yet (a newer model generation than the SDK's typings know about),
      // hence the cast; only sent when tools are actually in play, so a tool-less run is
      // completely unaffected.
      ...(openaiTools.length > 0 ? { reasoning_effort: "none" as OpenAI.Chat.ChatCompletionReasoningEffort } : {}),
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
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Malformed JSON from the model itself — treat as empty args rather than failing the call.
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
// requests it, frozen for the lifetime of that run — never regenerated mid-run.
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
  const prompt = `Generate exactly ${count} different paraphrased versions of the question below — each one a realistic way a real user might actually type it. Keep the same underlying intent/meaning as the original; only the phrasing/wording should change.${guidanceLine}

Original question: ${query}`;
  try {
    const result = await callJudgeJson({ model: judgeModel, jsonSchema: SMOKE_TEST_VARIANTS_SCHEMA, userMessage: prompt });
    const payload = result.payload as { variants?: unknown } | null;
    const variants = Array.isArray(payload?.variants)
      ? payload!.variants.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    return variants.slice(0, count);
  } catch (err) {
    console.error("Smoke test variant generation failed:", err);
    return [];
  }
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
