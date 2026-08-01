import { nanoid } from "nanoid";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Matches AgentX-web-front's MonitoringWindow (src/types/agentMonitoring.ts).
export type MonitoringWindow = "24h" | "7d" | "30d";

function windowConfig(window: MonitoringWindow): { days: number; bucketHours: number } {
  switch (window) {
    case "24h":
      return { days: 1, bucketHours: 1 };
    case "30d":
      return { days: 30, bucketHours: 24 };
    case "7d":
    default:
      return { days: 7, bucketHours: 24 };
  }
}

export type EventRow = {
  id: string;
  signalId: string | null;
  patternKey: string;
  type: string;
  severity: string;
  polarity: string;
  agentId: string | null;
  traceId: string | null;
  createdAt: Date;
};

export async function recordEvent(db: Db, input: Omit<EventRow, "id" | "createdAt">): Promise<void> {
  const row: EventRow = { id: nanoid(), createdAt: new Date(), ...input };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorEvents).values(row);
  } else {
    await db.db.insert(db.schema.monitorEvents).values(row);
  }
}

// Called opportunistically after each write for that agent (see detect.ts) rather than on a
// schedule — self-host has no background job runner (plan task #110's note), and event volume
// here is low enough that a delete-on-write is cheap rather than a real cron.
export async function pruneOldEvents(db: Db, agentId: string | null, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cond =
    agentId === null
      ? and(lt(db.schema.monitorEvents.createdAt, cutoff), isNull(db.schema.monitorEvents.agentId))
      : and(lt(db.schema.monitorEvents.createdAt, cutoff), eq(db.schema.monitorEvents.agentId, agentId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.monitorEvents).where(cond);
  } else {
    await db.db.delete(db.schema.monitorEvents).where(cond);
  }
}

async function listEventsSince(db: Db, since: Date): Promise<EventRow[]> {
  const cond = gte(db.schema.monitorEvents.createdAt, since);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond);
  return rows as EventRow[];
}

async function listTraceLatenciesSince(db: Db, since: Date): Promise<number[]> {
  const cond = gte(db.schema.traces.createdAt, since);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ latencyMs: db.schema.traces.latencyMs }).from(db.schema.traces).where(cond).all()
      : await db.db.select({ latencyMs: db.schema.traces.latencyMs }).from(db.schema.traces).where(cond)
  ) as { latencyMs: number | null }[];
  return rows.map(r => r.latencyMs).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index]!;
}

// Same "custom:" prefix / "healthy-response" special-case classification
// core/monitor/performance.ts's getPerformance already uses for the all-time aggregate — kept
// consistent rather than reinvented, just windowed here instead of all-time.
function isCustomPattern(patternKey: string): boolean {
  return patternKey.startsWith("custom:");
}

type WindowedCounts = {
  total: number;
  healthy: number;
  failing: number;
  systemFailing: number;
  customFailing: number;
  toolFailing: number;
};

function emptyCounts(): WindowedCounts {
  return { total: 0, healthy: 0, failing: 0, systemFailing: 0, customFailing: 0, toolFailing: 0 };
}

function tallyEvent(counts: WindowedCounts, row: EventRow): void {
  counts.total++;
  if (row.patternKey === "healthy-response") {
    counts.healthy++;
    return;
  }
  if (row.polarity !== "failure") {
    return;
  }
  counts.failing++;
  if (isCustomPattern(row.patternKey)) {
    counts.customFailing++;
  } else {
    counts.systemFailing++;
  }
  if (row.patternKey.startsWith("agent-tool-failure")) {
    counts.toolFailing++;
  }
}

function healthRate(counts: WindowedCounts): number | null {
  const denom = counts.healthy + counts.failing;
  return denom > 0 ? counts.healthy / denom : null;
}

export type MonitoringKpisResponse = {
  window: MonitoringWindow;
  totalRuns: number;
  healthRate: number | null;
  failureRate: number | null;
  downvoteRate: number | null;
  toolFailureRate: number | null;
  p95LatencyMs: number | null;
  deltas: {
    healthRate: number | null;
    failureRate: number | null;
    downvoteRate: number | null;
    toolFailureRate: number | null;
  };
  breakdown: {
    totalRuns: number;
    healthyRuns: number;
    failingRuns: number;
    systemFailingRuns: number;
    customFailingRuns: number;
    healthRate: number | null;
  };
};

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) {
    return null;
  }
  return current - previous;
}

export async function getKpis(db: Db, window: MonitoringWindow): Promise<MonitoringKpisResponse> {
  const { days } = windowConfig(window);
  const windowMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  // One query covering the current window and the equal-length window immediately before it
  // (needed for `deltas`), split in JS — same "fetch a set, compute in memory" style already used
  // throughout core/evaluate and core/monitor rather than dialect-specific SQL aggregation.
  const since = new Date(now - windowMs * 2);
  const allEvents = await listEventsSince(db, since);
  const boundary = now - windowMs;

  const current = emptyCounts();
  const previous = emptyCounts();
  for (const row of allEvents) {
    const bucket = row.createdAt.getTime() >= boundary ? current : previous;
    tallyEvent(bucket, row);
  }

  const currentLatencies = await listTraceLatenciesSince(db, new Date(boundary));
  const p95LatencyMs = percentile(currentLatencies, 0.95);

  const currentHealthRate = healthRate(current);
  const previousHealthRate = healthRate(previous);
  const currentFailureRate = current.total > 0 ? current.failing / current.total : null;
  const previousFailureRate = previous.total > 0 ? previous.failing / previous.total : null;
  const currentToolFailureRate = current.total > 0 ? current.toolFailing / current.total : null;
  const previousToolFailureRate = previous.total > 0 ? previous.toolFailing / previous.total : null;

  return {
    window,
    totalRuns: current.total,
    healthRate: currentHealthRate,
    failureRate: currentFailureRate,
    // No native chat UI on self-host to downvote a response from — always null, same convention
    // as EvaluateTab's out-of-scope fields elsewhere in this engine (omit rather than fake).
    downvoteRate: null,
    toolFailureRate: currentToolFailureRate,
    p95LatencyMs,
    deltas: {
      healthRate: delta(currentHealthRate, previousHealthRate),
      failureRate: delta(currentFailureRate, previousFailureRate),
      downvoteRate: null,
      toolFailureRate: delta(currentToolFailureRate, previousToolFailureRate),
    },
    breakdown: {
      totalRuns: current.healthy + current.failing,
      healthyRuns: current.healthy,
      failingRuns: current.failing,
      systemFailingRuns: current.systemFailing,
      customFailingRuns: current.customFailing,
      healthRate: currentHealthRate,
    },
  };
}

export type MonitoringTrendPoint = { label: string; ts?: number; healthRate: number | null };
export type MonitoringTrendResponse = {
  window: MonitoringWindow;
  points: MonitoringTrendPoint[];
  previous?: MonitoringTrendPoint[];
  releases: never[];
};

function bucketize(rows: EventRow[], bucketStartMs: number, bucketCount: number, bucketMs: number): MonitoringTrendPoint[] {
  const buckets: WindowedCounts[] = Array.from({ length: bucketCount }, () => emptyCounts());
  for (const row of rows) {
    const index = Math.floor((row.createdAt.getTime() - bucketStartMs) / bucketMs);
    if (index >= 0 && index < bucketCount) {
      tallyEvent(buckets[index]!, row);
    }
  }
  return buckets.map((counts, i) => {
    const ts = bucketStartMs + i * bucketMs;
    return { label: new Date(ts).toISOString(), ts, healthRate: healthRate(counts) };
  });
}

export async function getTrend(db: Db, window: MonitoringWindow): Promise<MonitoringTrendResponse> {
  const { days, bucketHours } = windowConfig(window);
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const bucketCount = Math.ceil((days * 24 * 60 * 60 * 1000) / bucketMs);
  const now = Date.now();
  const currentStart = now - bucketCount * bucketMs;
  const previousStart = currentStart - bucketCount * bucketMs;

  const rows = await listEventsSince(db, new Date(previousStart));
  const currentRows = rows.filter(r => r.createdAt.getTime() >= currentStart);
  const previousRows = rows.filter(r => r.createdAt.getTime() < currentStart);

  return {
    window,
    points: bucketize(currentRows, currentStart, bucketCount, bucketMs),
    previous: bucketize(previousRows, previousStart, bucketCount, bucketMs),
    // "Releases" are agent-config-version deploy markers on the hosted SaaS's trend chart — no
    // equivalent on self-host, which has no native agent-config-branching system at all (same
    // boundary as Evaluate's agentConfigVersion/robotConfigBranch omission). Always empty rather
    // than faked.
    releases: [],
  };
}

export type MonitoringTopFailingResponse = {
  window: MonitoringWindow;
  agents: { agentId: string; name?: string; failingRuns: number; failureRate: number | null }[];
  tools: { name: string; failures: number; failureRate: number | null }[];
  patterns: { patternKey: string; name: string; count: number }[];
};

export async function getTopFailing(db: Db, window: MonitoringWindow, limit = 10): Promise<MonitoringTopFailingResponse> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await listEventsSince(db, since);

  const byAgent = new Map<string, { total: number; failing: number }>();
  const byTool = new Map<string, number>();
  const byPattern = new Map<string, { patternKey: string; name: string; count: number }>();

  for (const row of rows) {
    if (row.agentId) {
      const entry = byAgent.get(row.agentId) ?? { total: 0, failing: 0 };
      entry.total++;
      if (row.patternKey !== "healthy-response" && row.polarity === "failure") {
        entry.failing++;
      }
      byAgent.set(row.agentId, entry);
    }
    if (row.patternKey === "healthy-response" || row.polarity !== "failure") {
      continue;
    }
    if (row.patternKey.startsWith("agent-tool-failure")) {
      const toolName = row.patternKey.split(":")[1] ?? "unknown";
      byTool.set(toolName, (byTool.get(toolName) ?? 0) + 1);
    }
    const existing = byPattern.get(row.patternKey);
    if (existing) {
      existing.count++;
    } else {
      byPattern.set(row.patternKey, { patternKey: row.patternKey, name: row.type, count: 1 });
    }
  }

  const agents = Array.from(byAgent.entries())
    .map(([agentId, { total, failing }]) => ({
      agentId,
      name: agentId,
      failingRuns: failing,
      failureRate: total > 0 ? failing / total : null,
    }))
    .filter(a => a.failingRuns > 0)
    .sort((a, b) => b.failingRuns - a.failingRuns)
    .slice(0, limit);

  const tools = Array.from(byTool.entries())
    .map(([name, failures]) => ({ name, failures, failureRate: null }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, limit);

  const patterns = Array.from(byPattern.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { window, agents, tools, patterns };
}
