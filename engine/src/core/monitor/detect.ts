import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { evaluatePatternConditions, type PatternCondition, type SemanticJudge, type TraceLike } from "./conditions.js";
import { listCustomPatterns, getPatternRow } from "./patterns.js";
import { getProfileRow } from "./profiles.js";
import { upsertSignal, type DetectedSignal } from "./signals.js";
import { recordEvent, pruneRetentionData } from "./events.js";
import { extractWebhookUrls, notifyWebhooks } from "./webhooks.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { getMonitoringDefaults } from "../project/projects.js";

// Built-in checks, evaluated in code rather than stored as pattern rows (same list as
// AgentX-web-api's BUILT_IN_AGENT_MONITORING_PATTERNS). "negative-feedback" is the one entry not
// detected by this file at all: the feedback API (core/monitor/feedback.ts) raises it directly
// when an end user downvotes, since the user is the detector - it's listed here so the Signals
// and Patterns surfaces resolve its name like any other built-in.
export const BUILT_IN_MONITOR_PATTERNS = [
  { key: "negative-feedback", name: "Negative user feedback", description: "Flags responses the end user explicitly downvoted, reported via the feedback API.", severity: "medium", category: "Reliability" },
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
  // Checked BEFORE the generic trace-error case: when a tool call fails and its exception
  // escapes the agent loop, the SDK records both (success:false on the call AND the span's own
  // error), and "which tool failed" is the more specific, actionable classification - it names
  // the root cause and feeds the tool-schema improvement loop's evidence gathering
  // (core/evaluate/toolSchemas.ts joins on this patternKey). agent-trace-error remains the
  // classification for errors with no failed tool call recorded.
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

  if (trace.error) {
    return {
      type: "agent_trace_error",
      severity: "high",
      summary: `The agent's execution trace recorded an error: ${trace.error}`,
      patternKey: "agent-trace-error",
      rootCause: trace.error,
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
// ANTHROPIC_API_KEY). Returns `reason` alongside the boolean (previously discarded here) so
// callers can surface it on the resulting signal, same as Custom Evaluators' own
// {matches, reason} contract does (core/monitor/customEvaluators.ts).
export const llmSemanticJudge: SemanticJudge = async (rubric, text) => {
  const result = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    jsonSchema: semanticMatchSchema,
    userMessage: `Does the following text match this rubric?\n\nRubric: ${rubric}\n\nText:\n${text}\n\nRespond with JSON {"matches": true|false, "reason": "..."}.`,
  });
  const payload = result.payload as { matches?: boolean; reason?: string } | null;
  return { matched: payload?.matches === true, reason: payload?.reason };
};

function withReasons(summary: string, reasons: string[]): string {
  return reasons.length ? `${summary} (${reasons.join("; ")})` : summary;
}

async function detectCustomPatterns(db: Db, trace: TraceLike, agentId: string | null, traceId: string | null): Promise<DetectedSignal | null> {
  const patterns = await listCustomPatterns(db);
  const responseText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
  for (const pattern of patterns) {
    if (!pattern.enabled) continue;
    if (!matchesAgentScope(pattern, agentId)) continue;
    if (!passesSampleRate(pattern.sampleRate)) continue;
    let outcome: { overall: boolean; reasons: string[] };
    try {
      outcome = await evaluatePatternConditions({
        conditions: pattern.conditions as PatternCondition[],
        responseText,
        trace,
        semanticJudge: llmSemanticJudge,
      });
    } catch (err) {
      // A "semantic" condition failing (missing judge API key, provider outage) must not silently
      // skip every other pattern after it, or the entire healthy-tally/failure detection for this
      // trace - isolated per-pattern rather than letting the whole sweep abort partway.
      console.error(`Pattern "${pattern.name}" failed to evaluate:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!outcome.overall) continue;
    return {
      type: "custom_pattern_match",
      severity: pattern.severity,
      polarity: pattern.polarity,
      summary: withReasons(pattern.description || `${pattern.name} matched this response.`, outcome.reasons),
      patternKey: pattern.key,
      rootCause: pattern.name,
    };
  }
  return null;
}

// Entry point called from routes/ingest.ts, two ways: explicitly, when a trace is submitted with
// monitor=true (mirrors tracer.trace(..., monitor=True, pattern_ids=[...]): explicit pattern_ids
// restricts detection to exactly those custom pattern ids, skipping built-ins; omitted runs the
// full default sweep), and implicitly, on every other trace, gated by requireEnabledProfile below
// so a dashboard-enabled AgentMonitoringProfile actually takes effect on regular SDK traces
// instead of only ever mattering for OTLP-ingested ones (routes/otlp.ts already calls this
// unconditionally).
export async function runMonitorCheck(
  db: Db,
  trace: TraceLike & { latencyMs?: number | null },
  ctx: { agentId?: string | null; traceId?: string | null; patternIds?: string[]; requireEnabledProfile?: boolean }
): Promise<void> {
  const agentId = ctx.agentId ?? null;
  // Profile-level gates: enabled/sampleRate/failureDetectionEnabled/infoDetectionEnabled are
  // persisted (core/monitor/profiles.ts) and round-trip through the dashboard's per-agent settings
  // dialog. No profile row (agent never configured) behaves exactly like today for the *explicit*
  // monitor=true path: fully on, unsampled - that's the "no dashboard setup required" SDK-first
  // design goal.
  const profile = agentId ? await getProfileRow(db, agentId) : null;
  // sampleRate/retentionDays/latency threshold are project-level (core/project/projects.ts's
  // MonitoringDefaults) - a single request-scoped fetch, applied uniformly to every agent in this
  // project rather than each agent's own (now-inert) profile fields.
  const defaults = await getMonitoringDefaults(db);
  // The *implicit* path (every trace, not just monitor=true ones) is the opposite: "no profile"
  // must mean "skip", not "fully on" - otherwise every agent would start being monitored (and
  // judge-API-billed) automatically the moment any trace is ingested, before anyone touched the
  // dashboard at all. Only an agent with a real, explicitly-enabled profile gets implicit coverage.
  if (ctx.requireEnabledProfile && !profile?.enabled) {
    return;
  }
  if (profile && !profile.enabled) {
    return;
  }
  if (profile && !passesSampleRate(defaults.sampleRate)) {
    return;
  }

  const scoped = ctx.patternIds && ctx.patternIds.length > 0;

  let detected: DetectedSignal | null = null;

  if (scoped) {
    for (const id of ctx.patternIds!) {
      const pattern = await getPatternRow(db, id);
      if (!pattern || !pattern.enabled) continue;
      if (!matchesAgentScope(pattern, agentId)) continue;
      const responseText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
      let outcome: { overall: boolean; reasons: string[] };
      try {
        outcome = await evaluatePatternConditions({
          conditions: pattern.conditions as PatternCondition[],
          responseText,
          trace,
          semanticJudge: llmSemanticJudge,
        });
      } catch (err) {
        console.error(`Pattern "${pattern.name}" failed to evaluate:`, err instanceof Error ? err.message : err);
        continue;
      }
      if (outcome.overall) {
        detected = {
          type: "custom_pattern_match",
          severity: pattern.severity,
          polarity: pattern.polarity,
          summary: withReasons(pattern.description || `${pattern.name} matched this response.`, outcome.reasons),
          patternKey: pattern.key,
          rootCause: pattern.name,
        };
        break;
      }
    }
  } else {
    const builtIn = profile?.failureDetectionEnabled === false ? null : detectBuiltIn(trace, defaults.latencyThresholdMs);
    detected = builtIn ?? (await detectCustomPatterns(db, trace, agentId, ctx.traceId ?? null));
  }

  if (!detected) {
    // infoDetectionEnabled === false: the agent's profile opted out of the healthy/"proper"
    // tally specifically (core/monitor/performance.ts's health-rate still just won't count this
    // check either way) - failure detection above already ran regardless, this only skips logging
    // the "nothing wrong" case.
    if (profile?.infoDetectionEnabled === false) {
      return;
    }
    // Mirrors the hosted SaaS: a checked trace that matches nothing becomes a healthy "info"
    // tally instead of nothing at all, which is what core/monitor/performance.ts's health-rate
    // computation (GET /agent-monitoring/performance) sums against per agent. Deduped by
    // upsertSignal the same as every other signal, so this is one row per agent (occurrenceCount
    // incrementing), not one row per healthy trace. listSignals defaults to polarity "failure",
    // so this doesn't show up in triage views unless polarity=all/proper is explicitly requested.
    const healthy = { type: "healthy_response", severity: "low", polarity: "proper", summary: "No issues detected.", patternKey: "healthy-response" };
    const signal = await upsertSignal(db, healthy, { agentId: ctx.agentId, traceId: ctx.traceId });
    await recordEvent(db, {
      signalId: signal._id,
      patternKey: healthy.patternKey,
      type: healthy.type,
      severity: healthy.severity,
      polarity: healthy.polarity,
      agentId,
      traceId: ctx.traceId ?? null,
    });
    if (profile) {
      await pruneRetentionData(db, agentId, defaults.retentionDays);
    }
    return;
  }

  const signal = await upsertSignal(db, detected, {
    agentId: ctx.agentId,
    traceId: ctx.traceId,
    evidence: { input: trace.input, output: trace.output },
  });
  await recordEvent(db, {
    signalId: signal._id,
    patternKey: detected.patternKey,
    type: detected.type,
    severity: detected.severity,
    polarity: detected.polarity ?? "failure",
    agentId,
    traceId: ctx.traceId ?? null,
  });
  // Only failure-polarity detections page anyone - a "proper" custom pattern match is a positive
  // signal (see performance.ts's comment on that distinction), not something to alert on.
  if ((detected.polarity ?? "failure") === "failure") {
    notifyWebhooks(extractWebhookUrls(profile?.channels), {
      summary: detected.summary,
      severity: detected.severity,
      patternKey: detected.patternKey,
      agentId,
      rootCause: detected.rootCause,
    });
  }
  if (profile) {
    await pruneRetentionData(db, agentId, defaults.retentionDays);
  }
}
