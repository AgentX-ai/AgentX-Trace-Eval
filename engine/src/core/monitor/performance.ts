import type { Db } from "../../storage/db.js";
import { isOperationalKey, listEventsSince } from "./events.js";
import { getAgentNamesById } from "./agents.js";

// Matches AgentX-web-front's MonitoringHealthRate/MonitoringAgentPerformance/
// MonitoringPerformanceResponse (src/types/agentMonitoring.ts).
export type MonitoringHealthRate = {
  totalRuns: number;
  healthyRuns: number;
  failingRuns: number;
  operationalFailingRuns: number;
  scorerFailingRuns: number;
  healthRate: number | null;
};

function emptyHealthRate(): MonitoringHealthRate {
  return { totalRuns: 0, healthyRuns: 0, failingRuns: 0, operationalFailingRuns: 0, scorerFailingRuns: 0, healthRate: null };
}

function finalize(rate: MonitoringHealthRate): MonitoringHealthRate {
  rate.totalRuns = rate.healthyRuns + rate.failingRuns;
  rate.healthRate = rate.totalRuns > 0 ? rate.healthyRuns / rate.totalRuns : null;
  return rate;
}

// Aggregates the KPI event ledger per agent - the same rows getKpis tallies, just grouped. Reads
// events rather than Signals: operational outcomes (trace errors, tool failures, empty responses)
// classify into events WITHOUT raising a Signal (detect.ts's classifyOperational), so a
// signal-based tally would count an erroring agent as healthy. Evaluator rows (continuous judge
// ratings / custom-scorer verdicts) are skipped, same as tallyEvent - they aren't run outcomes.
// "proper"-polarity custom pattern matches count toward neither side: not a failure, but not the
// "nothing went wrong" baseline either.
export async function getPerformance(db: Db) {
  const rows = await listEventsSince(db, new Date(0));
  const overall = emptyHealthRate();
  const byAgent = new Map<string, MonitoringHealthRate>();

  for (const row of rows) {
    if (row.onlineEvaluatorId || row.customEvaluatorId) continue;
    if (!row.agentId) continue;
    if (!byAgent.has(row.agentId)) byAgent.set(row.agentId, emptyHealthRate());
    const agentRate = byAgent.get(row.agentId)!;

    if (row.patternKey === "healthy-response") {
      overall.healthyRuns++;
      agentRate.healthyRuns++;
      continue;
    }
    if (row.polarity !== "failure") {
      continue;
    }

    overall.failingRuns++;
    agentRate.failingRuns++;
    if (isOperationalKey(row.patternKey)) {
      overall.operationalFailingRuns++;
      agentRate.operationalFailingRuns++;
    } else {
      overall.scorerFailingRuns++;
      agentRate.scorerFailingRuns++;
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
