import { getDb, withProjectId } from "../../storage/db.js";
import { logger } from "../../log.js";
import { listProjectRows } from "../project/projects.js";
import { acquireSweepLease } from "../shared/sweepLease.js";
import { evaluateAlertRulesOnce, type RuleEvaluation } from "./alertRules.js";

// The alert-rule evaluator: every SWEEP_INTERVAL_MS, evaluate each project's enabled alert rules
// against their windows and drive the firing/resolved lifecycle (core/monitor/alertRules.ts).
// Same shape as the session and improvement sweeps: one interval, a cross-replica lease so N
// engines on one database elect a single evaluator per tick, and a manual project-scoped
// trigger that bypasses the lease for tests and demos. AGENTX_ALERT_SWEEP=false disables it.

const SWEEP_INTERVAL_MS = 60_000;
const LEASE_TTL_MS = 5 * 60_000;

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;
// Manual (route-triggered) sweeps in flight, by project: the route bypasses the cross-replica
// lease on purpose, but a burst of POSTs must not run the same project's pass concurrently.
const manualSweeps = new Set<string>();

export async function sweepAlertRulesOnce(options: { projectId?: string | null } = {}): Promise<RuleEvaluation[]> {
  const baseDb = getDb();
  const listed = await listProjectRows(baseDb);
  const projects = options.projectId ? listed.filter(p => p.id === options.projectId) : listed;
  const results: RuleEvaluation[] = [];
  for (const project of projects) {
    try {
      results.push(...(await evaluateAlertRulesOnce(withProjectId(baseDb, project.id))));
    } catch (err) {
      // One project's failure (a metric query erroring on its tier) must not skip the others.
      logger.error({ err: err instanceof Error ? err.message : err, projectId: project.id }, "Alert sweep failed for project");
    }
  }
  return results;
}

// The manual route's entry point: one pass for the caller's project, serialized per project.
export async function runManualAlertSweep(projectId: string): Promise<{ evaluated: number; results: RuleEvaluation[]; skipped?: true }> {
  if (manualSweeps.has(projectId)) {
    return { evaluated: 0, results: [], skipped: true };
  }
  manualSweeps.add(projectId);
  try {
    const results = await sweepAlertRulesOnce({ projectId });
    return { evaluated: results.length, results };
  } finally {
    manualSweeps.delete(projectId);
  }
}

export function startAlertSweep(): void {
  if (process.env.AGENTX_ALERT_SWEEP === "false") {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweeping) return; // a slow round must not stack a second sweep
    acquireSweepLease(getDb(), "alert-sweep", LEASE_TTL_MS)
      .then(acquired => {
        if (!acquired || sweeping) return null;
        sweeping = true;
        return sweepAlertRulesOnce().finally(() => {
          sweeping = false;
        });
      })
      .catch((err: unknown) => logger.error({ err }, "Alert sweep failed"));
  }, SWEEP_INTERVAL_MS);
  // Never keep the process alive just for the sweep.
  sweepTimer.unref();
}

export function stopAlertSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  // A stop mid-pass must not leave the guard set, or a later start() would never sweep again.
  sweeping = false;
}
