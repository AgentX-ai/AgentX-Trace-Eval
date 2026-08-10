import { getTraceRow, type TraceRow } from "../trace/ingest.js";
import type { Db } from "../../storage/db.js";
import { callModelCompletion, scorePortabilityResponse, type ReconstructedContext } from "./judge.js";
import { getPortabilityModel, estimateCostUSD, type PortabilityModel } from "./models.js";

// Model portability: "would a different model handle this specific captured input about as
// well?" — an input-only replay, not a full agent re-run. Self-host doesn't own the agent (no
// system prompt/tools/history guaranteed the way native autotune's RobotConfig would have them),
// but traces.input/traces.metadata are opaque JSON, and what's actually in them depends entirely
// on how the caller instrumented (checked against the real AgentX-Python tracer: the raw
// Anthropic client patch captures the full `messages` array, the manual tracer.trace() API is
// fully free-form, the higher-level framework integrations flatten to text). reconstructMessages
// below makes a best-effort, multi-shape attempt at recovering structure — same defensive posture
// as routes/otlp.ts's own "try every known convention" OTel attribute parsing — rather than
// assuming one fixed shape or silently only ever doing single-turn-text replay.
//
// Deliberately NOT reconstructing tool-calling ability: even when metadata contains tool
// definitions, replaying them requires translating an arbitrary captured schema into each
// candidate provider's own tool-call format, which is real, separate work — out of scope here.
// Tool definitions found in metadata are surfaced for display only (toolsFound below).

const SYSTEM_PROMPT_METADATA_KEYS = ["systemPrompt", "system_prompt", "system", "instructions"];
const TOOLS_METADATA_KEYS = ["tools", "toolDefinitions", "tool_definitions"];

function extractContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    // Multi-modal / block-style content (e.g. [{type: "text", text: "..."}]) — best-effort join
    // of any text-bearing parts, since a candidate model call here only ever sends plain text.
    return value
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as { text?: unknown; content?: unknown };
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as { text?: unknown; content?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  return JSON.stringify(value);
}

function isMessageArray(value: unknown): value is { role?: unknown; content?: unknown }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => item && typeof item === "object" && "role" in (item as object))
  );
}

function findMetadataString(metadata: unknown, keys: string[]): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function findMetadataValue(metadata: unknown, keys: string[]): unknown {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] != null) {
      return record[key];
    }
  }
  return null;
}

export type ReconstructionResult = ReconstructedContext & {
  usedStructuredInput: boolean;
  toolsFound: unknown;
};

export function reconstructMessages(trace: Pick<TraceRow, "input" | "metadata">): ReconstructionResult {
  let system: string | undefined;
  let messages: { role: "user" | "assistant"; content: string }[] = [];
  let usedStructuredInput = false;

  if (isMessageArray(trace.input)) {
    usedStructuredInput = true;
    for (const item of trace.input) {
      const role = typeof item.role === "string" ? item.role : "user";
      const content = extractContent(item.content);
      if (!content) continue;
      if (role === "system" || role === "developer") {
        // Multiple system entries (rare) are joined — better than silently dropping all but one.
        system = system ? `${system}\n${content}` : content;
      } else {
        messages.push({ role: role === "assistant" ? "assistant" : "user", content });
      }
    }
  } else {
    const content = extractContent(trace.input);
    if (content) {
      messages = [{ role: "user", content }];
    }
  }

  if (!system) {
    const found = findMetadataString(trace.metadata, SYSTEM_PROMPT_METADATA_KEYS);
    if (found) {
      system = found;
    }
  }

  return {
    system,
    messages,
    usedStructuredInput,
    toolsFound: findMetadataValue(trace.metadata, TOOLS_METADATA_KEYS),
  };
}

export type PortabilityResult = {
  model: string;
  provider: "openai" | "anthropic" | "custom" | null;
  isBaseline: boolean;
  outputText: string | null;
  rating: number | null;
  justification: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUSD: number | null;
  error: string | null;
};

export async function getPortabilityPreview(db: Db, traceId: string): Promise<ReconstructionResult | null> {
  const trace = await getTraceRow(db, traceId);
  if (!trace) return null;
  return reconstructMessages(trace);
}

export async function runModelPortabilityCheck(
  db: Db,
  traceId: string,
  candidateModelIds: string[]
): Promise<{ reconstructed: ReconstructionResult; results: PortabilityResult[] } | null> {
  const trace = await getTraceRow(db, traceId);
  if (!trace) return null;
  const reconstructed = reconstructMessages(trace);

  const results: PortabilityResult[] = [];

  // Baseline: the trace's own already-captured output, re-scored under the portability rubric so
  // its rating is directly comparable to the candidates (it was never judged against this rubric
  // when first ingested — Monitor's checks are pattern/rating checks, not a quality score).
  const baselineOutputText = extractContent(trace.output);
  const baselineModel = trace.model ? await getPortabilityModel(db, trace.model) : null;
  try {
    const { rating, justification } = await scorePortabilityResponse(
      reconstructed.messages[reconstructed.messages.length - 1]?.content ?? "",
      baselineOutputText
    );
    results.push({
      model: trace.model ?? "(unknown)",
      provider: baselineModel?.provider ?? null,
      isBaseline: true,
      outputText: baselineOutputText || null,
      rating,
      justification,
      latencyMs: trace.latencyMs,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      estimatedCostUSD: estimateCostUSD(baselineModel, trace.inputTokens, trace.outputTokens),
      error: null,
    });
  } catch (err) {
    results.push({
      model: trace.model ?? "(unknown)",
      provider: baselineModel?.provider ?? null,
      isBaseline: true,
      outputText: baselineOutputText || null,
      rating: null,
      justification: null,
      latencyMs: trace.latencyMs,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      estimatedCostUSD: estimateCostUSD(baselineModel, trace.inputTokens, trace.outputTokens),
      error: err instanceof Error ? err.message : "Scoring failed",
    });
  }

  // Each candidate is isolated — one model failing (bad key, rate limit, not enabled on the
  // user's account) must not blank out the rest of the comparison, same posture as every other
  // multi-target loop in this engine (detectCustomPatterns, runOnlineEvaluators).
  for (const modelId of candidateModelIds) {
    const model: PortabilityModel | null = await getPortabilityModel(db, modelId);
    try {
      const start = Date.now();
      const completion = await callModelCompletion(modelId, {
        system: reconstructed.system,
        messages: reconstructed.messages,
      });
      const latencyMs = Date.now() - start;
      const { rating, justification } = await scorePortabilityResponse(
        reconstructed.messages[reconstructed.messages.length - 1]?.content ?? "",
        completion.text
      );
      results.push({
        model: modelId,
        provider: model?.provider ?? null,
        isBaseline: false,
        outputText: completion.text,
        rating,
        justification,
        latencyMs,
        inputTokens: completion.usage?.inputTokens ?? null,
        outputTokens: completion.usage?.outputTokens ?? null,
        estimatedCostUSD: estimateCostUSD(model, completion.usage?.inputTokens ?? null, completion.usage?.outputTokens ?? null),
        error: null,
      });
    } catch (err) {
      results.push({
        model: modelId,
        provider: model?.provider ?? null,
        isBaseline: false,
        outputText: null,
        rating: null,
        justification: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUSD: null,
        error: err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  return { reconstructed, results };
}
