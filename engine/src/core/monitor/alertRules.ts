import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { logger } from "../../log.js";
import { traceStoreFor } from "../trace/store/index.js";
import { estimateCostUSD, listPortabilityModels, normalizeModelId } from "../evaluate/models.js";
import { isMaskedSecret, maskSecret } from "../shared/maskSecret.js";
import { getAgentRow } from "./agents.js";
import { deliverAlert, type AlertChannel, type AlertDelivery, type AlertNotification } from "./alertChannels.js";

// KPI alert rules: "notify me when <metric> over the last <window> is <above|below> <threshold>".
//
// Three things in the engine already notify, and this is deliberately none of them:
//   - a SCORER's alert threshold fires per verdict (one bad trace);
//   - an AUTOMATION RULE routes per trace (one matching trace);
//   - an ALERT RULE watches an AGGREGATE - failure rate, p95 latency, spend, judge failures,
//     traffic volume - the numbers an ops team otherwise re-derived from raw webhook payloads.
//
// Lifecycle is Alertmanager-shaped, because that is what pagers and on-call rotations expect:
// notify once on ok->firing, repeat every `cooldownMinutes` while it keeps breaching, notify
// again on firing->ok (a PagerDuty incident is resolved with the same dedup key it opened
// with). A metric with no data (a rate with a zero denominator) never breaches - "no traffic"
// is `traceCount` below a floor, an explicit rule, not every rate alert firing at once.

export type AlertMetric =
  | "failureRate"
  | "toolFailureRate"
  | "p95LatencyMs"
  | "estimatedCostUsd"
  | "judgeFailures"
  | "traceCount";

export const ALERT_METRICS: readonly AlertMetric[] = [
  "failureRate",
  "toolFailureRate",
  "p95LatencyMs",
  "estimatedCostUsd",
  "judgeFailures",
  "traceCount",
];

export type AlertOperator = "gt" | "lt";
export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertState = "ok" | "firing";

export const MAX_ALERT_RULES_PER_PROJECT = 50;
export const MAX_ALERT_CHANNELS = 5;
export const MAX_ALERT_WINDOW_MINUTES = 7 * 24 * 60;
// History kept per rule; older rows are pruned on insert so a flapping rule can't grow unbounded.
const MAX_EVENTS_PER_RULE = 200;

type AlertRuleRow = {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  agentId: string | null;
  severity: string;
  channels: unknown;
  cooldownMinutes: number;
  state: string;
  lastValue: number | null;
  lastEvaluatedAt: Date | null;
  lastFiredAt: Date | null;
  lastNotifiedAt: Date | null;
  firedCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type AlertEventRow = {
  id: string;
  projectId: string | null;
  ruleId: string;
  kind: string;
  value: number | null;
  threshold: number;
  deliveries: unknown;
  createdAt: Date;
};

export type AlertEventKind = "triggered" | "repeat" | "resolved" | "test";

// Metric presentation shared by the notification text and the dashboard: a threshold of 0.1
// on failureRate is "10%", on estimatedCostUsd it is "$0.10".
export const METRIC_LABELS: Record<AlertMetric, string> = {
  failureRate: "Failure rate",
  toolFailureRate: "Tool failure rate",
  p95LatencyMs: "p95 latency",
  estimatedCostUsd: "Estimated LLM cost",
  judgeFailures: "Judge failures",
  traceCount: "Trace count",
};

export function formatMetricValue(metric: AlertMetric, value: number | null): string {
  if (value === null) return "no data";
  switch (metric) {
    case "failureRate":
    case "toolFailureRate":
      return `${(value * 100).toFixed(1)}%`;
    case "p95LatencyMs":
      return `${Math.round(value)} ms`;
    case "estimatedCostUsd":
      return `$${value.toFixed(value < 1 ? 4 : 2)}`;
    case "judgeFailures":
    case "traceCount":
      return `${Math.round(value)}`;
  }
}

export function formatWindow(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// PagerDuty routing keys are the one channel target that is a pure secret (a Slack/Teams hook
// URL is a credential too, but the operator needs to see which hook a rule points at - the
// same posture automation rules take for their webhook URL). Masked on every read; a PUT that
// sends the mask back means "keep the stored key".
function channelsForWire(channels: AlertChannel[]): AlertChannel[] {
  return channels.map(ch => (ch.kind === "pagerduty" ? { ...ch, target: maskSecret(ch.target) } : ch));
}

function parseChannels(raw: unknown): AlertChannel[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (ch): ch is AlertChannel =>
      !!ch && typeof ch === "object" && typeof (ch as AlertChannel).kind === "string" && typeof (ch as AlertChannel).target === "string"
  );
}

function toWire(row: AlertRuleRow) {
  return {
    _id: row.id,
    name: row.name,
    enabled: row.enabled,
    metric: row.metric as AlertMetric,
    operator: row.operator as AlertOperator,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    agentId: row.agentId,
    severity: row.severity as AlertSeverity,
    channels: channelsForWire(parseChannels(row.channels)),
    cooldownMinutes: row.cooldownMinutes,
    state: row.state as AlertState,
    lastValue: row.lastValue,
    lastValueLabel: formatMetricValue(row.metric as AlertMetric, row.lastValue),
    lastEvaluatedAt: row.lastEvaluatedAt ? row.lastEvaluatedAt.toISOString() : null,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    lastNotifiedAt: row.lastNotifiedAt ? row.lastNotifiedAt.toISOString() : null,
    firedCount: row.firedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type AlertRuleWire = ReturnType<typeof toWire>;

function eventToWire(row: AlertEventRow) {
  return {
    _id: row.id,
    ruleId: row.ruleId,
    kind: row.kind as AlertEventKind,
    value: row.value,
    threshold: row.threshold,
    deliveries: (row.deliveries as AlertDelivery[] | null) ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export type AlertEventWire = ReturnType<typeof eventToWire>;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function projectCond(db: Db) {
  return or(eq(db.schema.alertRules.projectId, db.projectId), isNull(db.schema.alertRules.projectId));
}

// Two-branch selects throughout (not one shared query object): drizzle's sqlite|pg union types
// reject a builder shared across dialects, so this is the codebase's cross-dialect idiom.
async function listRows(db: Db): Promise<AlertRuleRow[]> {
  const cond = projectCond(db);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.alertRules).where(cond).orderBy(desc(db.schema.alertRules.createdAt)).all()
      : await db.db.select().from(db.schema.alertRules).where(cond).orderBy(desc(db.schema.alertRules.createdAt));
  return rows as AlertRuleRow[];
}

async function getRow(db: Db, id: string): Promise<AlertRuleRow | undefined> {
  const cond = and(eq(db.schema.alertRules.id, id), projectCond(db));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.alertRules).where(cond).all()
      : await db.db.select().from(db.schema.alertRules).where(cond);
  return (rows as AlertRuleRow[])[0];
}

async function countRows(db: Db): Promise<number> {
  return (await listRows(db)).length;
}

export async function listAlertRules(db: Db): Promise<AlertRuleWire[]> {
  return (await listRows(db)).map(toWire);
}

export async function getAlertRule(db: Db, id: string): Promise<AlertRuleWire | null> {
  const row = await getRow(db, id);
  return row ? toWire(row) : null;
}

export type CreateAlertRuleInput = {
  name: string;
  enabled?: boolean;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  agentId?: string | null;
  severity?: AlertSeverity;
  channels: AlertChannel[];
  cooldownMinutes?: number;
};

export class AlertRuleLimitError extends Error {}
// A rule definition the engine cannot honor (a masked PagerDuty key with nothing stored behind
// it) - a 400 at the door, never a stored mask that fails on the first incident.
export class AlertRuleValidationError extends Error {}

export async function createAlertRule(db: Db, input: CreateAlertRuleInput): Promise<AlertRuleWire> {
  if ((await countRows(db)) >= MAX_ALERT_RULES_PER_PROJECT) {
    throw new AlertRuleLimitError(`A project can have at most ${MAX_ALERT_RULES_PER_PROJECT} alert rules`);
  }
  const now = new Date();
  const row: AlertRuleRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    metric: input.metric,
    operator: input.operator,
    threshold: input.threshold,
    windowMinutes: input.windowMinutes,
    agentId: input.agentId ?? null,
    severity: input.severity ?? "high",
    channels: input.channels,
    cooldownMinutes: input.cooldownMinutes ?? 60,
    state: "ok",
    lastValue: null,
    lastEvaluatedAt: null,
    lastFiredAt: null,
    lastNotifiedAt: null,
    firedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.alertRules).values(row);
  } else {
    await db.db.insert(db.schema.alertRules).values(row);
  }
  return toWire(row);
}

export type UpdateAlertRuleInput = Partial<CreateAlertRuleInput>;

// A PUT that echoes a masked PagerDuty key back is "keep the stored one" - the mask must never
// be stored as the key (isMaskedSecret is the shared contract with the LLM-key settings).
function mergeChannels(incoming: AlertChannel[], stored: AlertChannel[]): AlertChannel[] {
  return incoming.map((ch, index) => {
    if (ch.kind !== "pagerduty" || !isMaskedSecret(ch.target)) return ch;
    const previous = stored[index]?.kind === "pagerduty" ? stored[index] : stored.find(s => s.kind === "pagerduty");
    return previous ? { ...ch, target: previous.target } : ch;
  });
}

export async function updateAlertRule(db: Db, id: string, patch: UpdateAlertRuleInput): Promise<AlertRuleWire | null> {
  const existing = await getRow(db, id);
  if (!existing) return null;
  const storedChannels = parseChannels(existing.channels);
  // A rule whose definition changed is a different alert - its firing state, value and
  // notification clock restart, or a re-thresholded rule could sit "firing" on a value it
  // would no longer breach, and the resolved page would never go out.
  const definitionChanged =
    (patch.metric !== undefined && patch.metric !== existing.metric) ||
    (patch.operator !== undefined && patch.operator !== existing.operator) ||
    (patch.threshold !== undefined && patch.threshold !== existing.threshold) ||
    (patch.windowMinutes !== undefined && patch.windowMinutes !== existing.windowMinutes) ||
    (patch.agentId !== undefined && (patch.agentId ?? null) !== existing.agentId);
  const mergedChannels = patch.channels ? mergeChannels(patch.channels, storedChannels) : null;
  if (mergedChannels?.some(ch => ch.kind === "pagerduty" && isMaskedSecret(ch.target))) {
    throw new AlertRuleValidationError("A masked PagerDuty key was sent but this rule has no stored key to keep - send the real routing key");
  }
  // Pausing resets the lifecycle: a paused rule must not sit "firing" and skip the triggered
  // page when it is enabled again mid-incident (the resolve is owed by the operator, as on
  // delete - documented on the route).
  const paused = patch.enabled === false && existing.enabled;
  const updated: AlertRuleRow = {
    ...existing,
    name: patch.name?.trim() ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    metric: patch.metric ?? existing.metric,
    operator: patch.operator ?? existing.operator,
    threshold: patch.threshold ?? existing.threshold,
    windowMinutes: patch.windowMinutes ?? existing.windowMinutes,
    agentId: patch.agentId === undefined ? existing.agentId : patch.agentId,
    severity: patch.severity ?? existing.severity,
    channels: mergedChannels ?? existing.channels,
    cooldownMinutes: patch.cooldownMinutes ?? existing.cooldownMinutes,
    ...(definitionChanged || paused ? { state: "ok", lastValue: null, lastNotifiedAt: null } : {}),
    updatedAt: new Date(),
  };
  const cond = eq(db.schema.alertRules.id, id);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.alertRules).set(updated).where(cond);
  } else {
    await db.db.update(db.schema.alertRules).set(updated).where(cond);
  }
  return toWire(updated);
}

export async function deleteAlertRule(db: Db, id: string): Promise<boolean> {
  const existing = await getRow(db, id);
  if (!existing) return false;
  const eventsCond = eq(db.schema.alertEvents.ruleId, id);
  const ruleCond = eq(db.schema.alertRules.id, id);
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.alertEvents).where(eventsCond);
    await db.db.delete(db.schema.alertRules).where(ruleCond);
  } else {
    await db.db.delete(db.schema.alertEvents).where(eventsCond);
    await db.db.delete(db.schema.alertRules).where(ruleCond);
  }
  return true;
}

export async function listAlertEvents(db: Db, ruleId: string, limit = 50): Promise<AlertEventWire[]> {
  const cond = and(eq(db.schema.alertEvents.ruleId, ruleId), eq(db.schema.alertEvents.projectId, db.projectId));
  const take = Math.max(1, Math.min(limit, MAX_EVENTS_PER_RULE));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.alertEvents).where(cond).orderBy(desc(db.schema.alertEvents.createdAt)).limit(take).all()
      : await db.db.select().from(db.schema.alertEvents).where(cond).orderBy(desc(db.schema.alertEvents.createdAt)).limit(take);
  return (rows as AlertEventRow[]).map(eventToWire);
}

async function recordAlertEvent(
  db: Db,
  rule: AlertRuleRow,
  kind: AlertEventKind,
  value: number | null,
  deliveries: AlertDelivery[]
): Promise<AlertEventWire> {
  const row: AlertEventRow = {
    id: nanoid(),
    projectId: db.projectId,
    ruleId: rule.id,
    kind,
    value,
    threshold: rule.threshold,
    deliveries,
    createdAt: new Date(),
  };
  // Bounded history: drop everything past the newest MAX_EVENTS_PER_RULE rows. Read a bounded
  // window (SQLite has no OFFSET without LIMIT) and delete what falls past the cap - pruning
  // runs on every insert, so the overflow is normally a single row.
  const byRule = eq(db.schema.alertEvents.ruleId, rule.id);
  const take = MAX_EVENTS_PER_RULE + 50;
  let newest: { id: string }[];
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.alertEvents).values(row);
    newest = db.db
      .select({ id: db.schema.alertEvents.id })
      .from(db.schema.alertEvents)
      .where(byRule)
      .orderBy(desc(db.schema.alertEvents.createdAt))
      .limit(take)
      .all();
  } else {
    await db.db.insert(db.schema.alertEvents).values(row);
    newest = await db.db
      .select({ id: db.schema.alertEvents.id })
      .from(db.schema.alertEvents)
      .where(byRule)
      .orderBy(desc(db.schema.alertEvents.createdAt))
      .limit(take);
  }
  const overflow = newest.slice(MAX_EVENTS_PER_RULE).map(r => r.id);
  if (overflow.length > 0) {
    const cond = inArray(db.schema.alertEvents.id, overflow);
    if (db.kind === "sqlite") {
      await db.db.delete(db.schema.alertEvents).where(cond);
    } else {
      await db.db.delete(db.schema.alertEvents).where(cond);
    }
  }
  return eventToWire(row);
}

// ---------------------------------------------------------------------------
// Metric evaluation
// ---------------------------------------------------------------------------

export type MetricQuery = { metric: AlertMetric; windowMinutes: number; agentId: string | null };

type MetricEventRow = {
  type: string;
  patternKey: string;
  polarity: string;
  onlineEvaluatorId: string | null;
  customEvaluatorId: string | null;
  agentId: string | null;
};

type MetricTraceRow = {
  agentId: string | null;
  model: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

// The per-window inputs every metric is computed from - fetched once per distinct
// (window, agent) inside a sweep tick, then shared by however many rules watch that window,
// so ten rules on "last 15 min" cost one trace query and one event query, not ten.
type MetricInputs = { events: MetricEventRow[]; traces: MetricTraceRow[] };

async function loadMetricInputs(db: Db, windowMinutes: number, agentId: string | null): Promise<MetricInputs> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const eventConds = [gte(db.schema.monitorEvents.createdAt, since), eq(db.schema.monitorEvents.projectId, db.projectId)];
  if (agentId) eventConds.push(eq(db.schema.monitorEvents.agentId, agentId));
  const eventCond = and(...eventConds);
  // Full rows + a cast, the codebase's cross-dialect idiom (a shared projection object trips
  // drizzle's dual-dialect union types). Same materialization bound as the KPI cards: past
  // 100k events the rates no longer move.
  const events = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(eventCond).limit(100_000).all()
      : await db.db.select().from(db.schema.monitorEvents).where(eventCond).limit(100_000)
  ) as MetricEventRow[];
  // Root spans only, production only: a nightly eval run's latencies and spend are not the
  // fleet's, and a child LLM span's latency is already inside its root's. Read through the
  // trace store so the ClickHouse tier is covered identically to SQLite/Postgres.
  const traceRows = await traceStoreFor(db).queryWindow({ since, productionOnly: true, rootsOnly: true });
  const traces = (traceRows as unknown as MetricTraceRow[]).filter(t => !agentId || t.agentId === agentId);
  return { events, traces };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

// Same run-outcome classification the KPI cards use (events.ts's tallyEvent): score-kind rows
// are ratings, not outcomes; "healthy-response" is a healthy run; failure polarity is a failing
// run. Kept in lockstep so the alert and the dashboard card never disagree on the same window.
function outcomeCounts(events: MetricEventRow[]): { total: number; failing: number; toolFailing: number } {
  let total = 0;
  let failing = 0;
  let toolFailing = 0;
  for (const row of events) {
    if (row.onlineEvaluatorId || row.customEvaluatorId || row.polarity === "score") continue;
    if (row.type === "online_eval_judge_failure") continue;
    total++;
    if (row.patternKey === "healthy-response" || row.polarity !== "failure") continue;
    failing++;
    if (row.patternKey.startsWith("agent-tool-failure")) toolFailing++;
  }
  return { total, failing, toolFailing };
}

async function computeMetric(db: Db, metric: AlertMetric, inputs: MetricInputs): Promise<number | null> {
  switch (metric) {
    case "failureRate": {
      const { total, failing } = outcomeCounts(inputs.events);
      return total > 0 ? failing / total : null;
    }
    case "toolFailureRate": {
      const { total, toolFailing } = outcomeCounts(inputs.events);
      return total > 0 ? toolFailing / total : null;
    }
    case "p95LatencyMs":
      return percentile(
        inputs.traces.map(t => t.latencyMs).filter((v): v is number => typeof v === "number"),
        0.95
      );
    case "judgeFailures":
      return inputs.events.filter(e => e.type === "online_eval_judge_failure").length;
    case "traceCount":
      return inputs.traces.length;
    case "estimatedCostUsd": {
      // Unpriced models contribute $0, the same posture as the Overview's cost total - an alert
      // on spend can only see what the pricing catalog can price.
      const pricing = await listPortabilityModels(db);
      const byModel = new Map(pricing.map(m => [m.id, m]));
      let total = 0;
      for (const t of inputs.traces) {
        if (!t.model) continue;
        const model = byModel.get(t.model) ?? byModel.get(normalizeModelId(t.model)) ?? null;
        if (!model) continue;
        // Null when the trace carries no token counts - nothing to price, not $0 of spend.
        total += estimateCostUSD(model, t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens) ?? 0;
      }
      return total;
    }
  }
}

// Exported for the dashboard's "current value" preview and for the SDK: one function computes
// a metric for a live rule and for a draft, so what the editor shows is what the sweep will see.
export async function evaluateMetric(db: Db, query: MetricQuery): Promise<number | null> {
  const inputs = await loadMetricInputs(db, query.windowMinutes, query.agentId);
  return computeMetric(db, query.metric, inputs);
}

export function breaches(operator: AlertOperator, value: number | null, threshold: number): boolean {
  if (value === null) return false;
  return operator === "gt" ? value > threshold : value < threshold;
}

// ---------------------------------------------------------------------------
// Sweep: evaluate every enabled rule and drive the firing/resolved lifecycle
// ---------------------------------------------------------------------------

function notificationFor(rule: AlertRuleRow, kind: AlertEventKind, value: number | null, agentName: string | null): AlertNotification {
  const metric = rule.metric as AlertMetric;
  const comparison = rule.operator === "gt" ? "above" : "below";
  // The page names the agent the way the dashboard does; the id still rides in `agentId`.
  const scope = rule.agentId ? ` for agent ${agentName ?? rule.agentId}` : "";
  const condition = `${METRIC_LABELS[metric]} ${comparison} ${formatMetricValue(metric, rule.threshold)} over the last ${formatWindow(rule.windowMinutes)}${scope}`;
  const status = kind === "resolved" ? "RESOLVED" : kind === "test" ? "TEST" : "FIRING";
  return {
    kind,
    status,
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity as AlertSeverity,
    metric,
    metricLabel: METRIC_LABELS[metric],
    operator: rule.operator as AlertOperator,
    threshold: rule.threshold,
    thresholdLabel: formatMetricValue(metric, rule.threshold),
    value,
    valueLabel: formatMetricValue(metric, value),
    windowMinutes: rule.windowMinutes,
    windowLabel: formatWindow(rule.windowMinutes),
    agentId: rule.agentId,
    agentName,
    condition,
    title: `[AgentX Alert] ${status}: ${rule.name}`,
    summary:
      kind === "resolved"
        ? `${condition} - back to ${formatMetricValue(metric, value)}.`
        : `${condition} - currently ${formatMetricValue(metric, value)}.`,
    at: new Date().toISOString(),
  };
}

async function notify(db: Db, rule: AlertRuleRow, kind: AlertEventKind, value: number | null): Promise<AlertEventWire> {
  const agentName = rule.agentId ? ((await getAgentRow(db, rule.agentId))?.name ?? null) : null;
  const notification = notificationFor(rule, kind, value, agentName);
  const channels = parseChannels(rule.channels).slice(0, MAX_ALERT_CHANNELS);
  const deliveries = await Promise.all(channels.map(channel => deliverAlert(channel, notification)));
  const failed = deliveries.filter(d => !d.ok);
  if (failed.length > 0) {
    logger.warn(
      { ruleId: rule.id, kind, failed: failed.map(d => ({ kind: d.kind, target: d.target, error: d.error })) },
      "Alert rule notification partially failed"
    );
  }
  return recordAlertEvent(db, rule, kind, value, deliveries);
}

export type RuleEvaluation = { ruleId: string; value: number | null; state: AlertState; notified: AlertEventKind | null };

async function evaluateRule(db: Db, rule: AlertRuleRow, value: number | null, now: Date): Promise<RuleEvaluation> {
  const breaching = breaches(rule.operator as AlertOperator, value, rule.threshold);
  const wasFiring = rule.state === "firing";
  let notified: AlertEventKind | null = null;
  const patch: Partial<AlertRuleRow> = { lastValue: value, lastEvaluatedAt: now };

  if (breaching && !wasFiring) {
    notified = "triggered";
    Object.assign(patch, { state: "firing", lastFiredAt: now, lastNotifiedAt: now, firedCount: rule.firedCount + 1 });
  } else if (breaching && wasFiring) {
    const lastNotified = rule.lastNotifiedAt?.getTime() ?? 0;
    if (now.getTime() - lastNotified >= rule.cooldownMinutes * 60_000) {
      notified = "repeat";
      patch.lastNotifiedAt = now;
    }
  } else if (!breaching && wasFiring) {
    notified = "resolved";
    Object.assign(patch, { state: "ok", lastNotifiedAt: now });
  }

  // State is committed BEFORE the page goes out: a delivery that hangs to its timeout, or a
  // crash mid-notify, must not leave the rule "ok" and re-trigger on the next tick. The write is
  // a compare-and-set on the state this evaluation read: the manual sweep route bypasses the
  // cross-replica lease, so a manual sweep landing on the same tick as the timer must not let
  // both transition ok->firing and page twice - whichever commits first owns the notification.
  const cond = and(eq(db.schema.alertRules.id, rule.id), eq(db.schema.alertRules.state, rule.state));
  const won =
    db.kind === "sqlite"
      ? db.db.update(db.schema.alertRules).set(patch).where(cond).returning({ id: db.schema.alertRules.id }).all()
      : await db.db.update(db.schema.alertRules).set(patch).where(cond).returning({ id: db.schema.alertRules.id });
  if (won.length === 0) {
    return { ruleId: rule.id, value, state: rule.state as AlertState, notified: null };
  }
  if (notified) {
    await notify(db, { ...rule, ...patch }, notified, value);
  }
  return { ruleId: rule.id, value, state: (patch.state ?? rule.state) as AlertState, notified };
}

// One project's pass. Rules on the same (window, agent) share one set of metric inputs.
export async function evaluateAlertRulesOnce(db: Db): Promise<RuleEvaluation[]> {
  const rules = (await listRows(db)).filter(r => r.enabled);
  if (rules.length === 0) return [];
  const now = new Date();
  const inputsByScope = new Map<string, Promise<MetricInputs>>();
  const results: RuleEvaluation[] = [];
  for (const rule of rules) {
    const scopeKey = `${rule.windowMinutes}|${rule.agentId ?? ""}`;
    let inputs = inputsByScope.get(scopeKey);
    if (!inputs) {
      inputs = loadMetricInputs(db, rule.windowMinutes, rule.agentId);
      inputsByScope.set(scopeKey, inputs);
    }
    try {
      const value = await computeMetric(db, rule.metric as AlertMetric, await inputs);
      results.push(await evaluateRule(db, rule, value, now));
    } catch (err) {
      // One broken rule (a metric query failing on this tier, a channel throwing) must not stop
      // the rest of the project's rules from being evaluated this tick.
      logger.error({ err: err instanceof Error ? err.message : err, ruleId: rule.id }, "Alert rule evaluation failed");
    }
  }
  return results;
}

// "Send a test notification": delivers to the rule's channels with the metric's current value,
// recorded as a `test` event so the history shows whether every channel accepted it. Never
// changes the rule's firing state.
export async function sendAlertRuleTest(db: Db, id: string): Promise<AlertEventWire | null> {
  const rule = await getRow(db, id);
  if (!rule) return null;
  const value = await evaluateMetric(db, { metric: rule.metric as AlertMetric, windowMinutes: rule.windowMinutes, agentId: rule.agentId });
  return notify(db, rule, "test", value);
}

// Header numbers for the dashboard panel.
export function alertRuleStateSummary(rows: AlertRuleWire[]): { total: number; enabled: number; firing: number } {
  return {
    total: rows.length,
    enabled: rows.filter(r => r.enabled).length,
    firing: rows.filter(r => r.enabled && r.state === "firing").length,
  };
}

