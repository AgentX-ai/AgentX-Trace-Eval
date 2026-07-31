import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { evaluatePatternConditions, type PatternCondition, type SemanticJudge, type TraceLike } from "./conditions.js";
import { listCustomPatterns, getPatternRow } from "./patterns.js";
import { resolveLatencyThresholdMs } from "./profiles.js";
import { upsertSignal, type DetectedSignal } from "./signals.js";

// Built-in checks, evaluated in code rather than stored as pattern rows (same list as
// AgentX-web-api's BUILT_IN_AGENT_MONITORING_PATTERNS, minus "negative-feedback": that one is
// native-chat-UI-only, an SDK trace has no vote/downvote concept to detect).
export const BUILT_IN_MONITOR_PATTERNS = [
  { key: "agent-response-failed", name: "Failed response", description: "Flags responses explicitly marked as failed.", severity: "high", category: "Reliability" },
  { key: "agent-trace-error", name: "Trace error", description: "Flags agent runs where the execution trace contains an error.", severity: "high", category: "Tooling" },
  { key: "agent-tool-failure", name: "Tool failure", description: "Flags failed tool calls recorded in the trace.", severity: "high", category: "Tooling" },
  { key: "empty-agent-response", name: "Empty agent response", description: "Flags responses where the agent returned no usable text.", severity: "medium", category: "Reliability" },
  { key: "latency-regression", name: "Latency regression", description: "Flags responses that exceed the configured latency threshold.", severity: "medium", category: "Performance" },
] as const;

// Shared by the SDK-facing GET /monitor/patterns (routes/monitor.ts) and the dashboard-facing
// GET /agent-monitoring/patterns (routes/agentMonitoringDashboard.ts), so the built-in list's
// wire shape has one definition, not two hand-written copies drifting apart.
export function builtInPatternsWire() {
  return BUILT_IN_MONITOR_PATTERNS.map(p => ({
    _id: p.key,
    workspaceId: "local",
    key: p.key,
    name: p.name,
    description: p.description,
    category: p.category,
    source: "builtIn" as const,
    detectorKind: "contains",
    matchTarget: ["response", "trace"],
    matchMode: "any" as const,
    includeTerms: [] as string[],
    excludeTerms: [] as string[],
    severity: p.severity,
    polarity: "failure" as const,
    enabled: true,
    sampleRate: 1,
    readOnly: true,
  }));
}

// Ported from AgentX-web-api/src/services/agentMonitoringService.ts's detectMonitoringSignal,
// most severe first, first match wins. `failed` (an explicit runtime failure flag) has no SDK
// wire equivalent, self-host traces only ever have `error`, so that check is folded into the
// trace-error case here instead of kept separate.
function detectBuiltIn(trace: TraceLike & { latencyMs?: number | null }, latencyThresholdMs: number): DetectedSignal | null {
  if (trace.error) {
    return {
      type: "agent_trace_error",
      severity: "high",
      summary: `The agent's execution trace recorded an error: ${trace.error}`,
      patternKey: "agent-trace-error",
      rootCause: trace.error,
    };
  }

  const failedCall = (trace.toolCalls ?? []).find(call => call.success === false);
  if (failedCall) {
    return {
      type: "agent_tool_failure",
      severity: "high",
      summary: `The agent's "${failedCall.name}" tool call did not complete successfully.`,
      patternKey: `agent-tool-failure:${failedCall.name}`,
      rootCause: failedCall.name,
    };
  }

  const responseText = typeof trace.output === "string" ? trace.output.trim() : trace.output ? JSON.stringify(trace.output) : "";
  if (!responseText) {
    return {
      type: "empty_agent_response",
      severity: "medium",
      summary: "The agent returned an empty response.",
      patternKey: "empty-agent-response",
    };
  }

  const latencyMs = trace.latencyMs;
  if (latencyMs && latencyMs > latencyThresholdMs) {
    return {
      type: "latency_regression",
      severity: "medium",
      summary: `The agent took ${Math.round(latencyMs / 1000)}s to respond, above the ${Math.round(
        latencyThresholdMs / 1000
      )}s threshold.`,
      patternKey: "latency-regression",
    };
  }

  return null;
}

const semanticMatchSchema = {
  type: "object",
  properties: { matches: { type: "boolean" }, reason: { type: "string" } },
  required: ["matches"],
};

// Real LLM-based semantic judge for custom patterns' "semantic" detector, reusing the same
// multi-provider judge-calling helper Evaluate's judge scoring uses (BYO OPENAI_API_KEY /
// ANTHROPIC_API_KEY). AgentX-web-api's equivalent (evaluateSemanticPattern) also returns a reason;
// self-host folds that straight into the signal's rootCause via the caller.
const llmSemanticJudge: SemanticJudge = async (rubric, text) => {
  const result = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    jsonSchema: semanticMatchSchema,
    userMessage: `Does the following text match this rubric?\n\nRubric: ${rubric}\n\nText:\n${text}\n\nRespond with JSON {"matches": true|false, "reason": "..."}.`,
  });
  const payload = result.payload as { matches?: boolean } | null;
  return payload?.matches === true;
};

async function detectCustomPatterns(db: Db, trace: TraceLike): Promise<DetectedSignal | null> {
  const patterns = await listCustomPatterns(db);
  const responseText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
  for (const pattern of patterns) {
    if (!pattern.enabled) continue;
    const matched = await evaluatePatternConditions({
      conditions: pattern.conditions as PatternCondition[],
      responseText,
      trace,
      semanticJudge: llmSemanticJudge,
    });
    if (!matched) continue;
    return {
      type: "custom_pattern_match",
      severity: pattern.severity,
      polarity: pattern.polarity,
      summary: pattern.description || `${pattern.name} matched this response.`,
      patternKey: pattern.key,
      rootCause: pattern.name,
    };
  }
  return null;
}

// Entry point called from routes/ingest.ts when a trace is submitted with monitor=true. Mirrors
// tracer.trace(..., monitor=True, pattern_ids=[...]): explicit pattern_ids restricts detection to
// exactly those custom pattern ids (skipping built-ins); omitted runs the full default sweep
// (all built-in checks plus every enabled custom pattern).
export async function runMonitorCheck(
  db: Db,
  trace: TraceLike & { latencyMs?: number | null },
  ctx: { agentId?: string | null; traceId?: string | null; patternIds?: string[] }
): Promise<void> {
  const scoped = ctx.patternIds && ctx.patternIds.length > 0;

  let detected: DetectedSignal | null = null;

  if (scoped) {
    for (const id of ctx.patternIds!) {
      const pattern = await getPatternRow(db, id);
      if (!pattern || !pattern.enabled) continue;
      const responseText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
      const matched = await evaluatePatternConditions({
        conditions: pattern.conditions as PatternCondition[],
        responseText,
        trace,
        semanticJudge: llmSemanticJudge,
      });
      if (matched) {
        detected = {
          type: "custom_pattern_match",
          severity: pattern.severity,
          polarity: pattern.polarity,
          summary: pattern.description || `${pattern.name} matched this response.`,
          patternKey: pattern.key,
          rootCause: pattern.name,
        };
        break;
      }
    }
  } else {
    const latencyThresholdMs = await resolveLatencyThresholdMs(db, ctx.agentId ?? "default");
    detected = detectBuiltIn(trace, latencyThresholdMs) ?? (await detectCustomPatterns(db, trace));
  }

  if (!detected) {
    return;
  }

  await upsertSignal(db, detected, {
    agentId: ctx.agentId,
    traceId: ctx.traceId,
    evidence: { input: trace.input, output: trace.output },
  });
}
