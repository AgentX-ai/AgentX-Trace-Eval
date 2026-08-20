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
  { key: "pii-in-response", name: "PII in response", description: "Flags responses containing what looks like personal data: email addresses, phone numbers, SSNs, or payment card numbers. Regex-based, zero LLM cost.", severity: "high", category: "Safety" },
  { key: "latency-regression", name: "Latency regression", description: "Flags responses that exceed the configured latency threshold.", severity: "medium", category: "Performance" },
] as const;

// Shared by the SDK-facing GET /monitor/patterns (routes/monitor.ts) and the dashboard-facing
// GET /agent-monitoring/patterns (routes/agentMonitoringDashboard.ts), so the built-in list's
// wire shape has one definition, not two hand-written copies drifting apart.
export function builtInPatternsWire(disabledKeys: string[] = []) {
  const disabled = new Set(disabledKeys);
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
    // Toggleable project-wide via PUT /settings/monitoring-defaults' disabledBuiltinPatterns -
    // readOnly refers to the pattern's definition (name/detector/severity), not its enablement.
    enabled: !disabled.has(p.key),
    sampleRate: 1,
    readOnly: true,
  }));
}

// Ported from AgentX-web-api/src/services/agentMonitoringService.ts's detectMonitoringSignal,
// most severe first, first match wins. `failed` (an explicit runtime failure flag) has no SDK
// wire equivalent, self-host traces only ever have `error`, so that check is folded into the
// trace-error case here instead of kept separate.
const PII_CHECKS: { kind: string; pattern: RegExp }[] = [
  { kind: "an email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: "a social security number", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  // Major-network prefixes only (Visa/Mastercard/Amex/Discover), optional space/dash grouping.
  { kind: "a payment card number", pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/ },
  // Separators required, so a bare 10-digit id never matches.
  { kind: "a phone number", pattern: /(?:\+?1[ .-])?\(?\d{3}\)[ .-]?\d{3}[.-]\d{4}\b|\b\d{3}[.-]\d{3}[.-]\d{4}\b/ },
];

function detectPiiKinds(text: string): string[] {
  return PII_CHECKS.filter(check => check.pattern.test(text)).map(check => check.kind);
}

function detectBuiltIn(
  trace: TraceLike & { latencyMs?: number | null },
  latencyThresholdMs: number,
  disabledKeys: Set<string>
): DetectedSignal | null {
  // Checked BEFORE the generic trace-error case: when a tool call fails and its exception
  // escapes the agent loop, the SDK records both (success:false on the call AND the span's own
  // error), and "which tool failed" is the more specific, actionable classification - it names
  // the root cause and feeds the tool-schema improvement loop's evidence gathering
  // (core/evaluate/toolSchemas.ts joins on this patternKey). agent-trace-error remains the
  // classification for errors with no failed tool call recorded.
  const failedCall = disabledKeys.has("agent-tool-failure")
    ? undefined
    : (trace.toolCalls ?? []).find(call => call.success === false);
  if (failedCall) {
    return {
      type: "agent_tool_failure",
      severity: "high",
      summary: `The agent's "${failedCall.name}" tool call did not complete successfully.`,
      patternKey: `agent-tool-failure:${failedCall.name}`,
      rootCause: failedCall.name,
    };
  }

  if (trace.error && !disabledKeys.has("agent-trace-error")) {
    return {
      type: "agent_trace_error",
      severity: "high",
      summary: `The agent's execution trace recorded an error: ${trace.error}`,
      patternKey: "agent-trace-error",
      rootCause: trace.error,
    };
  }

  const responseText = typeof trace.output === "string" ? trace.output.trim() : trace.output ? JSON.stringify(trace.output) : "";
  if (!responseText && !disabledKeys.has("empty-agent-response")) {
    return {
      type: "empty_agent_response",
      severity: "medium",
      summary: "The agent returned an empty response.",
      patternKey: "empty-agent-response",
    };
  }

  // Regex-based PII sniff, zero LLM cost - deliberately conservative patterns (prefixed card
  // numbers, separator-required phone numbers) so ids/timestamps in agent output don't
  // false-positive. An agent legitimately ECHOING data the user just provided still flags:
  // whether that's acceptable is a triage decision, not a detection one.
  const piiKinds = disabledKeys.has("pii-in-response") ? [] : detectPiiKinds(responseText);
  if (piiKinds.length > 0) {
    return {
      type: "pii_in_response",
      severity: "high",
      summary: `The response contains what looks like ${piiKinds.join(" and ")}.`,
      patternKey: "pii-in-response",
      rootCause: piiKinds.join(", "),
    };
  }

  const latencyMs = trace.latencyMs;
  if (latencyMs && latencyMs > latencyThresholdMs && !disabledKeys.has("latency-regression")) {
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

// Entry point called from routes/ingest.ts and routes/otlp.ts on every root trace - the same
// opt-in-by-existing posture online evaluators have: active patterns and built-in checks run
// without any per-agent dashboard setup. monitor=true with explicit pattern_ids (mirrors
// tracer.trace(..., monitor=True, pattern_ids=[...])) restricts detection to exactly those
// custom pattern ids, skipping built-ins. An agent whose profile row was explicitly DISABLED
// still opts out below - that's the only remaining per-agent gate.
export async function runMonitorCheck(
  db: Db,
  trace: TraceLike & { latencyMs?: number | null },
  ctx: { agentId?: string | null; traceId?: string | null; patternIds?: string[] }
): Promise<void> {
  const agentId = ctx.agentId ?? null;
  const profile = agentId ? await getProfileRow(db, agentId) : null;
  // sampleRate/retentionDays/latency threshold are project-level (core/project/projects.ts's
  // MonitoringDefaults) - a single request-scoped fetch, applied uniformly to every agent in this
  // project rather than each agent's own (now-inert) profile fields.
  const defaults = await getMonitoringDefaults(db);
  if (profile && !profile.enabled) {
    return;
  }
  // Not gated on `profile` (it was, until this was fixed): monitoring is always-on per trace,
  // while profile rows only exist for agents someone configured explicitly - so gating this
  // project-level setting on one made it a silent no-op for a default install. topics.ts's
  // runClassification always read it unconditionally; both consumers now agree.
  if (!passesSampleRate(defaults.sampleRate)) {
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
    const builtIn =
      profile?.failureDetectionEnabled === false
        ? null
        : detectBuiltIn(trace, defaults.latencyThresholdMs, new Set(defaults.disabledBuiltinPatterns));
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
