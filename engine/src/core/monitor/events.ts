import { nanoid } from "nanoid";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getTraceRow } from "../trace/ingest.js";
import { getAgentNamesById } from "./agents.js";
import { productionTracesOnly } from "../trace/evalTraffic.js";

// Matches AgentX-web-front's MonitoringWindow (src/types/agentMonitoring.ts).
export type MonitoringWindow = "24h" | "7d" | "30d";

export function windowConfig(window: MonitoringWindow): { days: number; bucketHours: number } {
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
  projectId: string | null;
  signalId: string | null;
  patternKey: string;
  type: string;
  severity: string;
  polarity: string;
  agentId: string | null;
  traceId: string | null;
  createdAt: Date;
  // Set only for online-evaluator rows (core/monitor/onlineEvaluators.ts) - a continuous judge
  // rating on sampled live traffic, not a failure/healthy pattern-match tally. Every classification
  // function below must skip these (see tallyEvent/getTopFailing), or they'd silently corrupt the
  // health-rate math those routes already ship.
  onlineEvaluatorId: string | null;
  rating: number | null;
  justification: string | null;
  // Set only for custom-evaluator rows (core/monitor/customEvaluators.ts) - a per-check boolean
  // verdict, recorded whether or not it raised a Signal. Same "skip in classification math" rule
  // as onlineEvaluatorId above, for the same reason.
  customEvaluatorId: string | null;
  matched: boolean | null;
  // Optional metadata a custom evaluator's endpoint can additionally return alongside `matches`
  // (CustomEvaluatorResponse's comment) - never drives the matched/hit decision itself, just
  // recorded for visibility. Null whenever the endpoint didn't report one, or for non-custom-
  // evaluator rows entirely (this is not reused for onlineEvaluatorId rows, which have their own
  // `rating` field with different 0-10 semantics).
  score: number | null;
  // Set only for session-scoped online-evaluator rows (core/monitor/sessionSweep.ts) - the
  // verdict covers a whole conversation; traceId then holds the session's last root trace as an
  // anchor for trace-keyed ground truth joins. Null for every per-trace row.
  sessionId: string | null;
};

export async function recordEvent(
  db: Db,
  input: Omit<
    EventRow,
    | "id"
    | "projectId"
    | "createdAt"
    | "onlineEvaluatorId"
    | "rating"
    | "justification"
    | "customEvaluatorId"
    | "matched"
    | "score"
    | "sessionId"
  > &
    Partial<
      Pick<EventRow, "onlineEvaluatorId" | "rating" | "justification" | "customEvaluatorId" | "matched" | "score" | "sessionId">
    >
): Promise<void> {
  const row: EventRow = {
    id: nanoid(),
    projectId: db.projectId,
    createdAt: new Date(),
    onlineEvaluatorId: null,
    rating: null,
    justification: null,
    customEvaluatorId: null,
    matched: null,
    score: null,
    sessionId: null,
    ...input,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorEvents).values(row);
  } else {
    await db.db.insert(db.schema.monitorEvents).values(row);
  }
}

// Called opportunistically after each write for that agent (see detect.ts) rather than on a
// schedule - self-host has no background job runner (plan task #110's note), and event volume
// here is low enough that a delete-on-write is cheap rather than a real cron.
//
// Prunes raw telemetry older than the window: monitor_events (the per-check log behind trend/KPI
// charts), traces themselves, and monitor_classifications (Topics). monitor_signals is
// deliberately exempt - those are curated triage records with their own status/reviewStatus
// lifecycle, not raw traffic, the same distinction real observability tools draw between trace
// retention and incident retention. `retentionDays <= 0` means "Forever" (MonitoringUnitSettingsFields.tsx's
// new option) - skip pruning entirely rather than treating 0 as "a cutoff of right now."
export async function pruneRetentionData(db: Db, agentId: string | null, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) {
    return;
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const eventsCond =
    agentId === null
      ? and(
          lt(db.schema.monitorEvents.createdAt, cutoff),
          isNull(db.schema.monitorEvents.agentId),
          eq(db.schema.monitorEvents.projectId, db.projectId)
        )
      : and(
          lt(db.schema.monitorEvents.createdAt, cutoff),
          eq(db.schema.monitorEvents.agentId, agentId),
          eq(db.schema.monitorEvents.projectId, db.projectId)
        );
  const tracesCond =
    agentId === null
      ? and(
          lt(db.schema.traces.createdAt, cutoff),
          isNull(db.schema.traces.agentId),
          eq(db.schema.traces.projectId, db.projectId)
        )
      : and(
          lt(db.schema.traces.createdAt, cutoff),
          eq(db.schema.traces.agentId, agentId),
          eq(db.schema.traces.projectId, db.projectId)
        );
  const classificationsCond =
    agentId === null
      ? and(
          lt(db.schema.monitorClassifications.createdAt, cutoff),
          isNull(db.schema.monitorClassifications.agentId),
          eq(db.schema.monitorClassifications.projectId, db.projectId)
        )
      : and(
          lt(db.schema.monitorClassifications.createdAt, cutoff),
          eq(db.schema.monitorClassifications.agentId, agentId),
          eq(db.schema.monitorClassifications.projectId, db.projectId)
        );

  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.monitorEvents).where(eventsCond);
    await db.db.delete(db.schema.traces).where(tracesCond);
    await db.db.delete(db.schema.monitorClassifications).where(classificationsCond);
  } else {
    await db.db.delete(db.schema.monitorEvents).where(eventsCond);
    await db.db.delete(db.schema.traces).where(tracesCond);
    await db.db.delete(db.schema.monitorClassifications).where(classificationsCond);
  }
}

// One row per detection is already recorded here (recordEvent, called from detect.ts on every
// match) - this is the real per-occurrence history AgentX-web-front's SignalRow.tsx expects on
// `signal.occurrences[]`, which core/monitor/signals.ts's toWire() never populated (only the
// aggregate occurrenceCount). Newest-last (chronological), matching the frontend's own
// `[...recorded].reverse()` to display newest-first.
export async function listOccurrencesForSignal(db: Db, signalId: string): Promise<EventRow[]> {
  const cond = and(eq(db.schema.monitorEvents.signalId, signalId), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).orderBy(db.schema.monitorEvents.createdAt).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond).orderBy(db.schema.monitorEvents.createdAt);
  return rows as EventRow[];
}

// Every detection check recorded against one trace - the join surface
// core/monitor/outcomeCalibration.ts uses to compare AgentX's own verdict for a trace against a
// real-world outcome reported for it later. Unlike listOccurrencesForSignal above (one Signal's
// deduped occurrence history), this is trace-scoped: a Signal aggregates many traces together
// (occurrenceCount), so it can't be joined back to one specific trace the way this can.
export async function listEventsForTrace(db: Db, traceId: string): Promise<EventRow[]> {
  const cond = and(eq(db.schema.monitorEvents.traceId, traceId), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond);
  return rows as EventRow[];
}

// Exported for judgeTuning.ts, which joins an evaluator's rating events against ground truth.
export async function listEventsSince(db: Db, since: Date): Promise<EventRow[]> {
  const cond = and(gte(db.schema.monitorEvents.createdAt, since), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond);
  return rows as EventRow[];
}

async function listTraceLatenciesSince(db: Db, since: Date): Promise<number[]> {
  // Production only: a nightly eval's latencies are not the fleet's P95.
  const cond = and(gte(db.schema.traces.createdAt, since), eq(db.schema.traces.projectId, db.projectId), productionTracesOnly(db));
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

// Failure classification for the run-outcome breakdown: operational outcomes are facts the
// trace itself recorded (detect.ts's classifyOperational - trace errors, tool failures, empty
// responses; the legacy agent-response-failed / latency-regression keys are grouped here too so
// historical events classify sanely), everything else failing came from a scorer someone
// enabled (template patterns, PII, negative feedback). Shared with performance.ts.
export function isOperationalKey(patternKey: string): boolean {
  return (
    patternKey.startsWith("agent-tool-failure") ||
    patternKey === "agent-trace-error" ||
    patternKey === "empty-agent-response" ||
    patternKey === "agent-response-failed" ||
    patternKey === "latency-regression"
  );
}

type WindowedCounts = {
  total: number;
  healthy: number;
  failing: number;
  operationalFailing: number;
  scorerFailing: number;
  toolFailing: number;
};

function emptyCounts(): WindowedCounts {
  return { total: 0, healthy: 0, failing: 0, operationalFailing: 0, scorerFailing: 0, toolFailing: 0 };
}

function tallyEvent(counts: WindowedCounts, row: EventRow): void {
  if (row.onlineEvaluatorId || row.customEvaluatorId) {
    return;
  }
  counts.total++;
  if (row.patternKey === "healthy-response") {
    counts.healthy++;
    return;
  }
  if (row.polarity !== "failure") {
    return;
  }
  counts.failing++;
  if (isOperationalKey(row.patternKey)) {
    counts.operationalFailing++;
  } else {
    counts.scorerFailing++;
  }
  if (row.patternKey.startsWith("agent-tool-failure")) {
    counts.toolFailing++;
  }
}

function healthRate(counts: WindowedCounts): number | null {
  const denom = counts.healthy + counts.failing;
  return denom > 0 ? counts.healthy / denom : null;
}

// Downvote rate: the share of end-user votes (user_feedback rows, POST /feedback) that were
// "down" in the window. Vote-denominated, not run-denominated - most runs receive no vote at
// all, and "of the users who reacted, how many were unhappy" is the question the card answers.
async function feedbackDownvoteRate(db: Db, since: Date, until?: Date): Promise<number | null> {
  const conditions = [gte(db.schema.userFeedback.createdAt, since), eq(db.schema.userFeedback.projectId, db.projectId)];
  if (until) {
    conditions.push(lt(db.schema.userFeedback.createdAt, until));
  }
  const cond = and(...conditions);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ rating: db.schema.userFeedback.rating }).from(db.schema.userFeedback).where(cond).all()
      : await db.db.select({ rating: db.schema.userFeedback.rating }).from(db.schema.userFeedback).where(cond)
  ) as { rating: string }[];
  if (rows.length === 0) {
    return null;
  }
  return rows.filter(r => r.rating === "down").length / rows.length;
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
    operationalFailingRuns: number;
    scorerFailingRuns: number;
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
  // (needed for `deltas`), split in JS - same "fetch a set, compute in memory" style already used
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
  const currentDownvoteRate = await feedbackDownvoteRate(db, new Date(boundary));
  const previousDownvoteRate = await feedbackDownvoteRate(db, new Date(boundary - windowMs), new Date(boundary));

  return {
    window,
    totalRuns: current.total,
    healthRate: currentHealthRate,
    failureRate: currentFailureRate,
    downvoteRate: currentDownvoteRate,
    toolFailureRate: currentToolFailureRate,
    p95LatencyMs,
    deltas: {
      healthRate: delta(currentHealthRate, previousHealthRate),
      failureRate: delta(currentFailureRate, previousFailureRate),
      downvoteRate: delta(currentDownvoteRate, previousDownvoteRate),
      toolFailureRate: delta(currentToolFailureRate, previousToolFailureRate),
    },
    breakdown: {
      totalRuns: current.healthy + current.failing,
      healthyRuns: current.healthy,
      failingRuns: current.failing,
      operationalFailingRuns: current.operationalFailing,
      scorerFailingRuns: current.scorerFailing,
      healthRate: currentHealthRate,
    },
  };
}

// Per-scorer signal activity for the Scorers page's "Signals · window" column: how many
// signal-raising events each scorer key produced in the window, plus per-day buckets for the
// row sparkline. Grouped by FULL patternKey (evaluator keys carry their id; custom pattern keys
// carry their slug) - only events that actually raised/updated a Signal count, uniformly across
// pattern, LLM-judge, and custom-scorer kinds.
export async function getScorerActivity(
  db: Db,
  window: MonitoringWindow
): Promise<{
  window: MonitoringWindow;
  activity: Record<string, { count: number; buckets: number[]; judgeFailures?: number }>;
}> {
  const { days } = windowConfig(window);
  const bucketMs = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - days * bucketMs);
  const rows = await listEventsSince(db, since);
  const activity: Record<string, { count: number; buckets: number[]; judgeFailures?: number }> = {};
  const start = since.getTime();
  for (const row of rows) {
    // Judge failures (provider outage, unusable output) get their own counter per scorer -
    // previously a failing judge was indistinguishable from a quiet one on the Scorers list.
    if (row.type === "online_eval_judge_failure" && row.patternKey) {
      const entry = (activity[row.patternKey] ??= { count: 0, buckets: new Array(days).fill(0) });
      entry.judgeFailures = (entry.judgeFailures ?? 0) + 1;
      continue;
    }
    if (!row.signalId || row.patternKey === "healthy-response") continue;
    const entry = (activity[row.patternKey] ??= { count: 0, buckets: new Array(days).fill(0) });
    entry.count++;
    const bucket = Math.min(days - 1, Math.max(0, Math.floor((row.createdAt.getTime() - start) / bucketMs)));
    entry.buckets[bucket] = (entry.buckets[bucket] ?? 0) + 1;
  }
  return { window, activity };
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
    // "Releases" are agent-config-version deploy markers on the hosted SaaS's trend chart - no
    // equivalent on self-host, which has no native agent-config-branching system at all (same
    // boundary as Evaluate's agentConfigVersion/robotConfigBranch omission). Always empty rather
    // than faked.
    releases: [],
  };
}

export type MonitoringTopFailingResponse = {
  window: MonitoringWindow;
  agents: { agentId: string; name?: string; failingRuns: number; failureRate: number | null }[];
  tools: { name: string; failures: number; callCount: number; failureRate: number | null }[];
  patterns: { patternKey: string; name: string; count: number }[];
};

// Per-tool call volume and failure counts straight from the traces' recorded tool_calls arrays -
// ground truth rather than the signal log. Counts EVERY recorded call under its tool name (so
// MCP-registered tools are included like any other), where the signal path only flags the first
// failed call of a trace and knows no denominator for a rate.
async function listToolCallStatsSince(db: Db, since: Date): Promise<Map<string, { total: number; failures: number }>> {
  // Production only - eval datasets deliberately include failing tool calls.
  const cond = and(gte(db.schema.traces.createdAt, since), eq(db.schema.traces.projectId, db.projectId), productionTracesOnly(db));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ toolCalls: db.schema.traces.toolCalls }).from(db.schema.traces).where(cond).all()
      : await db.db.select({ toolCalls: db.schema.traces.toolCalls }).from(db.schema.traces).where(cond)
  ) as { toolCalls: unknown }[];
  const byTool = new Map<string, { total: number; failures: number }>();
  for (const row of rows) {
    if (!Array.isArray(row.toolCalls)) {
      continue;
    }
    for (const call of row.toolCalls) {
      if (!call || typeof call !== "object") {
        continue;
      }
      const { name, success } = call as { name?: unknown; success?: unknown };
      if (typeof name !== "string" || !name) {
        continue;
      }
      const entry = byTool.get(name) ?? { total: 0, failures: 0 };
      entry.total++;
      if (success === false) {
        entry.failures++;
      }
      byTool.set(name, entry);
    }
  }
  return byTool;
}

export async function getTopFailing(db: Db, window: MonitoringWindow, limit = 10): Promise<MonitoringTopFailingResponse> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await listEventsSince(db, since);

  const byAgent = new Map<string, { total: number; failing: number }>();
  const byPattern = new Map<string, { patternKey: string; name: string; count: number }>();

  for (const row of rows) {
    if (row.onlineEvaluatorId || row.customEvaluatorId) {
      continue;
    }
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
    const existing = byPattern.get(row.patternKey);
    if (existing) {
      existing.count++;
    } else {
      byPattern.set(row.patternKey, { patternKey: row.patternKey, name: row.type, count: 1 });
    }
  }

  const agentNamesById = await getAgentNamesById(db, Array.from(byAgent.keys()));

  const agents = Array.from(byAgent.entries())
    .map(([agentId, { total, failing }]) => ({
      agentId,
      name: agentNamesById.get(agentId) ?? agentId,
      failingRuns: failing,
      failureRate: total > 0 ? failing / total : null,
    }))
    .filter(a => a.failingRuns > 0)
    .sort((a, b) => b.failingRuns - a.failingRuns)
    .slice(0, limit);

  const toolStats = await listToolCallStatsSince(db, since);
  const tools = Array.from(toolStats.entries())
    .map(([name, { total, failures }]) => ({
      name,
      failures,
      callCount: total,
      failureRate: total > 0 ? failures / total : null,
    }))
    .filter(t => t.failures > 0)
    .sort((a, b) => b.failures - a.failures || (b.failureRate ?? 0) - (a.failureRate ?? 0))
    .slice(0, limit);

  const patterns = Array.from(byPattern.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { window, agents, tools, patterns };
}

export type OnlineEvaluatorRatingPoint = { label: string; ts: number; averageRating: number | null; count: number };

// Bucketed average rating over time for one online evaluator - the read side of Phase 4's
// continuous scoring, same bucketing approach as getTrend above but filtered to one evaluator's
// rows and averaging `rating` instead of computing a healthy/failing rate.
export async function getOnlineEvaluatorRatings(
  db: Db,
  evaluatorId: string,
  window: MonitoringWindow
): Promise<{ window: MonitoringWindow; points: OnlineEvaluatorRatingPoint[] }> {
  const { days, bucketHours } = windowConfig(window);
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const bucketCount = Math.ceil((days * 24 * 60 * 60 * 1000) / bucketMs);
  const bucketStartMs = Date.now() - bucketCount * bucketMs;

  const rows = (await listEventsSince(db, new Date(bucketStartMs))).filter(
    r => r.onlineEvaluatorId === evaluatorId && r.rating !== null
  );

  const buckets: { sum: number; count: number }[] = Array.from({ length: bucketCount }, () => ({ sum: 0, count: 0 }));
  for (const row of rows) {
    const index = Math.floor((row.createdAt.getTime() - bucketStartMs) / bucketMs);
    if (index >= 0 && index < bucketCount) {
      buckets[index]!.sum += row.rating as number;
      buckets[index]!.count++;
    }
  }

  const points = buckets.map(({ sum, count }, i) => {
    const ts = bucketStartMs + i * bucketMs;
    return { label: new Date(ts).toISOString(), ts, averageRating: count > 0 ? sum / count : null, count };
  });

  return { window, points };
}

export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as { query?: string; text?: string };
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.text === "string") return obj.text;
  }
  return JSON.stringify(value ?? "");
}

export type OnlineEvaluatorEvent = {
  id: string;
  traceId: string;
  rating: number;
  justification: string | null;
  createdAt: Date;
  input: string;
  output: string;
  // Non-null when this verdict covers a whole session (sessionSweep's dual-write) - the dialog
  // shows a session badge and links the session, not just the anchor trace.
  sessionId: string | null;
};

// Individual scored traces for one online evaluator within a window, worst-rated first - the
// per-trace complement to getOnlineEvaluatorRatings' bucketed aggregate above, so a low point on
// that chart can be traced back to exactly which conversation(s) pulled the average down and why.
// Same trace-join pattern as core/evaluate/prompts.ts's gatherOnlineEvaluatorExamples (that one
// feeds the prompt-registry autotune judge; this one is for direct human review in the dashboard).
export async function getOnlineEvaluatorEvents(
  db: Db,
  evaluatorId: string,
  window: MonitoringWindow,
  limit = 20
): Promise<{ events: OnlineEvaluatorEvent[]; totalCount: number }> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = (await listEventsSince(db, since)).filter(
    (r): r is EventRow & { rating: number; traceId: string } =>
      r.onlineEvaluatorId === evaluatorId && r.rating !== null && r.traceId !== null
  );
  rows.sort((a, b) => a.rating - b.rating);

  const resolved = await Promise.all(
    rows.slice(0, limit).map(async row => {
      const trace = await getTraceRow(db, row.traceId);
      if (!trace) return null;
      const event: OnlineEvaluatorEvent = {
        id: row.id,
        traceId: row.traceId,
        rating: row.rating,
        justification: row.justification,
        createdAt: row.createdAt,
        input: extractText(trace.input),
        output: extractText(trace.output),
        sessionId: row.sessionId,
      };
      return event;
    })
  );
  // totalCount is every scored row in the window, not just the ones with a still-resolvable trace
  // (a trace could in principle be pruned/missing) - deliberately the denominator a caller would
  // expect "worst 20 of totalCount" to add up against, matching what the window's real event count
  // actually is rather than silently under-counting to match resolved.length.
  return { events: resolved.filter((e): e is OnlineEvaluatorEvent => e !== null), totalCount: rows.length };
}

// Every online-evaluator verdict recorded for ONE trace, newest first - the trace dialog's
// "Judge scores" section. Evaluator names are resolved so the dialog needs no second fetch.
export type TraceEvaluationEntry = {
  id: string;
  evaluatorId: string;
  evaluatorName: string;
  rating: number;
  justification: string | null;
  createdAt: Date;
};

export async function listTraceEvaluations(db: Db, traceId: string): Promise<TraceEvaluationEntry[]> {
  const cond = and(eq(db.schema.monitorEvents.traceId, traceId), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond)
  ) as EventRow[];
  const scored = rows.filter(
    (r): r is EventRow & { onlineEvaluatorId: string; rating: number } =>
      r.onlineEvaluatorId !== null && r.rating !== null
  );
  scored.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const nameById = new Map<string, string>();
  const evaluatorRows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorOnlineEvaluators).where(eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId)).all()
      : await db.db.select().from(db.schema.monitorOnlineEvaluators).where(eq(db.schema.monitorOnlineEvaluators.projectId, db.projectId))
  ) as { id: string; name: string }[];
  for (const evaluator of evaluatorRows) {
    nameById.set(evaluator.id, evaluator.name);
  }

  return scored.map(row => ({
    id: row.id,
    evaluatorId: row.onlineEvaluatorId,
    evaluatorName: nameById.get(row.onlineEvaluatorId) ?? row.onlineEvaluatorId,
    rating: row.rating,
    justification: row.justification,
    createdAt: row.createdAt,
  }));
}

export type CustomEvaluatorEvent = {
  id: string;
  traceId: string;
  // null = the check itself failed to run (script crash, endpoint down); the error text is in
  // `justification`. These rows MUST stay visible - filtering them out made a crashing scorer
  // indistinguishable from a quiet one (deep-dive round 3, bug #4).
  matched: boolean | null;
  score: number | null;
  justification: string | null;
  createdAt: Date;
  input: string;
  output: string;
};

// Individual checked traces for one custom evaluator within a window, newest first - the
// per-trace call history a dashboard "events" view shows, same trace-join pattern as
// getOnlineEvaluatorEvents above.
export async function getCustomEvaluatorEvents(
  db: Db,
  evaluatorId: string,
  window: MonitoringWindow,
  limit = 20
): Promise<{ events: CustomEvaluatorEvent[]; totalCount: number }> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // matched === null rows are the scorer's own failures (recorded by customEvaluators.ts with
  // the error in justification) - they belong in the history, not on the cutting-room floor.
  const rows = (await listEventsSince(db, since)).filter(
    (r): r is EventRow & { traceId: string } => r.customEvaluatorId === evaluatorId && r.traceId !== null
  );
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const resolved = await Promise.all(
    rows.slice(0, limit).map(async row => {
      const trace = await getTraceRow(db, row.traceId);
      if (!trace) return null;
      const event: CustomEvaluatorEvent = {
        id: row.id,
        traceId: row.traceId,
        matched: row.matched,
        score: row.score,
        justification: row.justification,
        createdAt: row.createdAt,
        input: extractText(trace.input),
        output: extractText(trace.output),
      };
      return event;
    })
  );
  return { events: resolved.filter((e): e is CustomEvaluatorEvent => e !== null), totalCount: rows.length };
}
