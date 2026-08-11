import type { Db } from "../../storage/db.js";
import { listSignalRows } from "./signals.js";
import { getAgentNamesById } from "./agents.js";

// Matches AgentX-web-front's MonitoringHealthRate/MonitoringAgentPerformance/
// MonitoringPerformanceResponse (src/types/agentMonitoring.ts).
export type MonitoringHealthRate = {
  totalRuns: number;
  healthyRuns: number;
  failingRuns: number;
  systemFailingRuns: number;
  customFailingRuns: number;
  healthRate: number | null;
};

function emptyHealthRate(): MonitoringHealthRate {
  return { totalRuns: 0, healthyRuns: 0, failingRuns: 0, systemFailingRuns: 0, customFailingRuns: 0, healthRate: null };
}

function finalize(rate: MonitoringHealthRate): MonitoringHealthRate {
  rate.totalRuns = rate.healthyRuns + rate.failingRuns;
  rate.healthRate = rate.totalRuns > 0 ? rate.healthyRuns / rate.totalRuns : null;
  return rate;
}

// Sums the "healthy-response" tally detect.ts's runMonitorCheck now records against
// failure-polarity signals, per agent and overall - the same underlying rows
// GET /agent-monitoring/signals reads, just aggregated instead of listed. "proper"-polarity
// custom pattern matches (a deliberate positive-signal pattern, distinct from the built-in
// healthy tally) count toward neither side: they're not a failure, but they're not the "nothing
// went wrong" baseline either.
export async function getPerformance(db: Db) {
  const rows = await listSignalRows(db);
  const overall = emptyHealthRate();
  const byAgent = new Map<string, MonitoringHealthRate>();

  for (const row of rows) {
    if (!row.agentId) continue;
    if (!byAgent.has(row.agentId)) byAgent.set(row.agentId, emptyHealthRate());
    const agentRate = byAgent.get(row.agentId)!;

    if (row.patternKey === "healthy-response") {
      overall.healthyRuns += row.occurrenceCount;
      agentRate.healthyRuns += row.occurrenceCount;
      continue;
    }
    if (row.polarity !== "failure") {
      continue;
    }

    overall.failingRuns += row.occurrenceCount;
    agentRate.failingRuns += row.occurrenceCount;
    // Built-in checks' pattern keys (agent-trace-error, agent-tool-failure:<name>,
    // empty-agent-response, latency-regression, ...) never start with "custom:" - see
    // patterns.ts's createPattern, the only place that prefix is assigned.
    if (row.patternKey.startsWith("custom:")) {
      overall.customFailingRuns += row.occurrenceCount;
      agentRate.customFailingRuns += row.occurrenceCount;
    } else {
      overall.systemFailingRuns += row.occurrenceCount;
      agentRate.systemFailingRuns += row.occurrenceCount;
    }
  }

  const agentNamesById = await getAgentNamesById(db, Array.from(byAgent.keys()));

  return {
    overall: finalize(overall),
    byAgent: Array.from(byAgent.entries()).map(([agentId, rate]) => ({
      agentId,
      name: agentNamesById.get(agentId) ?? agentId,
      ...finalize(rate),
    })),
  };
}
