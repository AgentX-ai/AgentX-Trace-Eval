// Shared "filter + sample" routing/throttling primitive: the same shape both monitor_patterns
// (core/monitor/patterns.ts) and monitor_online_evaluators (core/monitor/onlineEvaluators.ts) use
// to scope which agents' traces they apply to and sample how often they run. Originally lived
// only in detect.ts; pulled out once a third module needed the exact same two checks.

// "selected", not "specific": matches AgentX-web-front's actual convention exactly
// (PatternApplyToAgentsDialog.tsx/monitoringUnitSettingsUtils.ts both write scopeMode: "selected"
// when scoping to specific agents — verified by reading the real dashboard code, not guessed).
// Getting this string wrong silently no-ops the entire scoping feature from the real UI: every
// non-"all" value up to "specific" would incorrectly fall through to "matches everything".
export function matchesAgentScope(row: { scopeMode: string; agentIds: unknown }, agentId: string | null): boolean {
  if (row.scopeMode !== "selected") {
    return true;
  }
  const agentIds = (row.agentIds as string[] | null) ?? [];
  return agentId !== null && agentIds.includes(agentId);
}

// Sampling is meant for automatic sweeps, not an explicit "check this exact one" request — a
// caller naming something by id is asking "does this match right now", not "sample this trace".
export function passesSampleRate(sampleRate: number): boolean {
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  return Math.random() < sampleRate;
}
