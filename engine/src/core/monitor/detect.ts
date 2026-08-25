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
import { logger } from "../../log.js";

// Built-in template scorers. Deliberately short: operational run outcomes (trace errors, failed
// tool calls, empty responses, latency) are facts the trace itself records - classified into the
// KPI tallies by classifyOperational below, always on, never listed here. End-user feedback is a
// third stream (core/monitor/userFeedback.ts): human ground truth attached to the trace, raising
// its "negative-feedback" signal directly on a downvote - the user IS the detector, so there is
// nothing to configure and it isn't a scorer either. A scorer is a judgment call someone opts
// into; PII detection is currently the only built-in that qualifies.
export const BUILT_IN_MONITOR_PATTERNS = [
  { key: "secrets-in-response", name: "Secrets in response", description: "Flags responses containing what looks like a leaked credential: API keys (OpenAI/AWS/GitHub/Slack), bearer tokens, JWTs, or private-key blocks. Regex-based, zero LLM cost.", severity: "critical", category: "Safety", detectorKind: "regex" },
  { key: "pii-in-response", name: "PII in response", description: "Flags responses containing what looks like personal data: email addresses, phone numbers, SSNs, or payment card numbers. Regex-based, zero LLM cost.", severity: "high", category: "Safety", detectorKind: "regex" },
  { key: "prompt-injection-echo", name: "Prompt injection echo", description: "Flags responses that repeat known jailbreak/injection phrasings (\"ignore previous instructions\", \"developer mode\", system-prompt disclosure), a sign the agent may be complying with injected instructions.", severity: "high", category: "Safety", detectorKind: "contains" },
  { key: "profanity-in-response", name: "Profanity in response", description: "Flags responses containing profanity, from a small unambiguous wordlist. Zero LLM cost.", severity: "medium", category: "Safety", detectorKind: "regex" },
  { key: "refusal-response", name: "Refusal / non-answer", description: "Flags responses that read as a refusal or deflection (\"I can't help with that\", \"I'm unable to...\"). Some refusals are correct behavior - that's a triage decision, this just surfaces them.", severity: "low", category: "Reliability", detectorKind: "contains" },
  { key: "malformed-json-response", name: "Malformed JSON response", description: "Flags responses that are not parseable JSON. Enable only for agents whose contract is to return JSON - prose responses will (correctly) all flag.", severity: "medium", category: "Reliability", detectorKind: "code" },
] as const;

// Human-readable spec of each built-in template's exact rules, derived from the live check
// tables (SECRET_CHECKS/PII_CHECKS/markers/wordlist) rather than hand-written so the dialog's
// view stays truthful by construction.
function builtInRuleSpec(key: string): string[] {
  switch (key) {
    case "secrets-in-response":
      return SECRET_CHECKS.map(check => `${check.kind}: /${check.pattern.source}/`);
    case "pii-in-response":
      return PII_CHECKS.map(check => `${check.kind}: /${check.pattern.source}/`);
    case "prompt-injection-echo":
      return INJECTION_MARKERS.map(marker => `response contains "${marker}" (case-insensitive)`);
    case "refusal-response":
      return REFUSAL_MARKERS.map(marker => `response contains "${marker}" (case-insensitive)`);
    case "profanity-in-response":
      return [`response matches /${PROFANITY_PATTERN.source}/i (word-boundary wordlist)`];
    case "malformed-json-response":
      return [
        "JSON.parse(response) must succeed - anything unparseable flags",
        "structured (non-string) outputs count as already-parsed JSON and always pass",
      ];
    default:
      return [];
  }
}

// Shared by the SDK-facing GET /monitor/patterns (routes/monitor.ts) and the dashboard-facing
// GET /agent-monitoring/patterns (routes/agentMonitoringDashboard.ts), so the built-in list's
// wire shape has one definition, not two hand-written copies drifting apart.
export function builtInPatternsWire(enabledKeys: string[] = []) {
  const enabled = new Set(enabledKeys);
  return BUILT_IN_MONITOR_PATTERNS.map(p => ({
    _id: p.key,
    workspaceId: "local",
    key: p.key,
    name: p.name,
    description: p.description,
    category: p.category,
    source: "builtIn" as const,
    detectorKind: p.detectorKind,
    // The exact rules each template checks, human-readable, derived from the live check tables
    // above/below so the dialog's "how it detects" view can never drift from the detector.
    ruleSpec: builtInRuleSpec(p.key),
    matchTarget: ["response", "trace"],
    matchMode: "any" as const,
    includeTerms: [] as string[],
    excludeTerms: [] as string[],
    severity: p.severity,
    polarity: "failure" as const,
    // Opt-IN project-wide via PUT /settings/monitoring-defaults' enabledBuiltinPatterns - no
    // template scorer runs until it's switched on. readOnly refers to the pattern's definition
    // (name/detector/severity), not its enablement.
    enabled: enabled.has(p.key),
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

// Operational run-outcome classification - NOT a scorer. Trace errors, failed tool calls, and
// empty responses are objective facts the ingested trace itself records; they always classify
// (no opt-in, no catalog entry, no Signal raised) so the KPI health/failure tallies and the
// tool-schema evidence loop (core/evaluate/toolSchemas.ts joins on agent-tool-failure:<name>)
// keep reading reality even when every scorer is switched off. Latency deliberately absent:
// it's a distribution metric (p95 from the traces table), not a run failure.
function classifyOperational(trace: TraceLike & { latencyMs?: number | null }): DetectedSignal | null {
  // Checked BEFORE the generic trace-error case: when a tool call fails and its exception
  // escapes the agent loop, the SDK records both (success:false on the call AND the span's own
  // error), and "which tool failed" is the more specific, actionable classification.
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

  return null;
}

// The remaining built-in template detectors, all zero-LLM-cost. Deliberately conservative
// patterns/wordlists throughout: a built-in that cries wolf gets switched off, and anything
// project-specific belongs in a custom pattern instead. An agent legitimately ECHOING data the
// user just provided still flags (PII/secrets): whether that's acceptable is a triage decision,
// not a detection one.
const SECRET_CHECKS: { kind: string; pattern: RegExp }[] = [
  { kind: "an OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{25,}/i },
  { kind: "a JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
  { kind: "a private-key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Response-side echoes of known injection phrasings: an agent REPEATING these usually means an
// injected instruction made it into (or through) the model. Input-side injection is the user's
// own prompt - only the response is checked, same as every other built-in.
const INJECTION_MARKERS = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "disregard your instructions",
  "disregard all previous instructions",
  "you are now dan",
  "do anything now",
  "developer mode enabled",
  "my system prompt is",
  "my instructions are as follows",
];

const REFUSAL_MARKERS = [
  "i can't help with that",
  "i cannot help with that",
  "i can't assist with",
  "i cannot assist with",
  "i'm unable to help",
  "i am unable to help",
  "i'm not able to help",
  "i cannot provide that",
  "i can't provide that",
  "i'm sorry, but i can't",
  "i'm sorry, but i cannot",
];

// Small and unambiguous on purpose - words that are profanity in any register. Milder words that
// double as ordinary usage ("damn", "hell", names) are excluded; extend per project with a
// custom pattern instead.
const PROFANITY_PATTERN = /\b(?:mother)?fuck\w*\b|\bshit\w*\b|\basshole\w*\b|\bbitch\w*\b|\bbastard\w*\b|\bcunt\w*\b|\bdickhead\w*\b|\bdumbass\w*\b/i;

function containedMarker(text: string, markers: string[]): string | null {
  const lower = text.toLowerCase();
  return markers.find(marker => lower.includes(marker)) ?? null;
}

// Ordered most-specific/most-severe first: first match wins, one detection per trace, same
// contract as the custom-pattern sweep this short-circuits ahead of. malformed-json-response is
// deliberately last - it's the most generic check, everything else is more actionable.
const BUILT_IN_DETECTORS: { key: string; detect: (trace: TraceLike, responseText: string) => DetectedSignal | null }[] = [
  {
    key: "secrets-in-response",
    detect: (_trace, responseText) => {
      const hits = SECRET_CHECKS.filter(check => check.pattern.test(responseText)).map(check => check.kind);
      if (hits.length === 0) return null;
      return {
        type: "secrets_in_response",
        severity: "critical",
        summary: `The response contains what looks like ${hits.join(" and ")}.`,
        patternKey: "secrets-in-response",
        rootCause: hits.join(", "),
      };
    },
  },
  {
    key: "pii-in-response",
    detect: (_trace, responseText) => {
      const piiKinds = detectPiiKinds(responseText);
      if (piiKinds.length === 0) return null;
      return {
        type: "pii_in_response",
        severity: "high",
        summary: `The response contains what looks like ${piiKinds.join(" and ")}.`,
        patternKey: "pii-in-response",
        rootCause: piiKinds.join(", "),
      };
    },
  },
  {
    key: "prompt-injection-echo",
    detect: (_trace, responseText) => {
      const marker = containedMarker(responseText, INJECTION_MARKERS);
      if (!marker) return null;
      return {
        type: "prompt_injection_echo",
        severity: "high",
        summary: `The response repeats a known injection phrasing ("${marker}") - the agent may be complying with injected instructions.`,
        patternKey: "prompt-injection-echo",
        rootCause: marker,
      };
    },
  },
  {
    key: "profanity-in-response",
    detect: (_trace, responseText) => {
      const match = PROFANITY_PATTERN.exec(responseText);
      if (!match) return null;
      return {
        type: "profanity_in_response",
        severity: "medium",
        summary: "The response contains profanity.",
        patternKey: "profanity-in-response",
        rootCause: match[0],
      };
    },
  },
  {
    key: "refusal-response",
    detect: (_trace, responseText) => {
      const marker = containedMarker(responseText, REFUSAL_MARKERS);
      if (!marker) return null;
      return {
        type: "refusal_response",
        severity: "low",
        summary: `The response reads as a refusal or deflection ("${marker}").`,
        patternKey: "refusal-response",
        rootCause: marker,
      };
    },
  },
  {
    key: "malformed-json-response",
    detect: (trace, responseText) => {
      // A structured (non-string) output is already parsed JSON by definition.
      if (typeof trace.output !== "string") return null;
      try {
        JSON.parse(responseText);
        return null;
      } catch {
        return {
          type: "malformed_json_response",
          severity: "medium",
          summary: "The response is not parseable JSON.",
          patternKey: "malformed-json-response",
        };
      }
    },
  },
];

function detectBuiltIn(trace: TraceLike, enabledKeys: Set<string>): DetectedSignal | null {
  const responseText = typeof trace.output === "string" ? trace.output.trim() : trace.output ? JSON.stringify(trace.output) : "";
  for (const detector of BUILT_IN_DETECTORS) {
    if (!enabledKeys.has(detector.key)) continue;
    const detected = detector.detect(trace, responseText);
    if (detected) return detected;
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
      logger.error({ err: err instanceof Error ? err.message : err }, `Pattern "${pattern.name}" failed to evaluate:`);
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
  // retentionDays/latency threshold are project-level (core/project/projects.ts's
  // MonitoringDefaults) - a single request-scoped fetch, applied uniformly to every agent in this
  // project rather than each agent's own (now-inert) profile fields.
  const defaults = await getMonitoringDefaults(db);
  if (profile && !profile.enabled) {
    return;
  }
  // No project-level sampling gate here (there was one, reading the legacy coverage
  // sample_rate): detection is cheap text checks and runs on ALL ingested traffic - the vendor
  // consensus (Langfuse/LangSmith/Braintrust) is that sampling belongs on the scorers that
  // spend LLM money, and each pattern with semantic conditions still has its own sampleRate
  // gate below. The Settings coverage knob was also a trap: "All traffic" mode never reset the
  // stored rate, silently under-monitoring.

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
        logger.error({ err: err instanceof Error ? err.message : err }, `Pattern "${pattern.name}" failed to evaluate:`);
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
    // Operational classification first (always on): an erroring/failed run is recorded as a KPI
    // event and nothing else - no Signal, no scorer involved. Only operationally-clean traces go
    // on to scorer detection, mirroring the old built-in-then-custom short-circuit order so each
    // checked trace still produces exactly one classification event.
    const operational = profile?.failureDetectionEnabled === false ? null : classifyOperational(trace);
    if (operational) {
      await recordEvent(db, {
        signalId: null,
        patternKey: operational.patternKey,
        type: operational.type,
        severity: operational.severity,
        polarity: "failure",
        agentId,
        traceId: ctx.traceId ?? null,
      });
      if (profile) {
        await pruneRetentionData(db, agentId, defaults.retentionDays);
      }
      return;
    }
    const builtIn =
      profile?.failureDetectionEnabled === false
        ? null
        : detectBuiltIn(trace, new Set(defaults.enabledBuiltinPatterns));
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
