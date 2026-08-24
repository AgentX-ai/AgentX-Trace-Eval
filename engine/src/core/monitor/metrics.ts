import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listPortabilityModels, normalizeModelId, type PortabilityModel } from "../evaluate/models.js";

// The Monitor metrics grid (claude.design Monitor.dc.html): one bucketed pass over the window's
// trace rows powering every card - spans by kind, latency percentiles, tokens, priced cost,
// tool executions and failures - with agent/model/tool/status filters. Same window/bucket idiom
// as cost.ts and topics.ts, extended with a "1h" live view.

const HOUR = 60 * 60 * 1000;
const PRESETS: Record<string, number> = {
  "1h": HOUR,
  "6h": 6 * HOUR,
  "12h": 12 * HOUR,
  "1d": 24 * HOUR,
  "24h": 24 * HOUR, // legacy alias
  "3d": 3 * 24 * HOUR,
  "7d": 7 * 24 * HOUR,
  "14d": 14 * 24 * HOUR,
  "30d": 30 * 24 * HOUR,
  "90d": 90 * 24 * HOUR,
};

export type MetricsRange = { from: number; to: number; window: string };

// Presets ("1h".."90d") or an explicit custom range via from/to (epoch ms). Custom ranges are
// clamped to [1 minute, 366 days]; nonsense falls back to the 7-day preset.
export function parseMetricsRange(query: Record<string, unknown>): MetricsRange {
  const from = Number(query.from);
  const to = Number(query.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    const clampedFrom = Math.max(from, to - 366 * 24 * HOUR);
    return { from: clampedFrom, to: Math.max(to, clampedFrom + 60_000), window: "custom" };
  }
  const preset = typeof query.window === "string" && PRESETS[query.window] ? query.window : "7d";
  const now = Date.now();
  return { from: now - PRESETS[preset]!, to: now, window: preset };
}

// Adaptive bucket sizing: the smallest rung that keeps the chart to at most ~40 buckets.
const BUCKET_LADDER = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 3 * 24 * HOUR];
function bucketSizeFor(rangeMs: number): number {
  for (const size of BUCKET_LADDER) {
    if (rangeMs / size <= 40) return size;
  }
  return 7 * 24 * HOUR;
}

export type MonitorMetricsFilters = {
  /** Root-trace (agent) name. */
  agent?: string;
  /** LLM model id as recorded on spans. */
  model?: string;
  /** Tool name as recorded in toolCalls. */
  tool?: string;
  /** "error" = only traffic whose root trace errored. */
  status?: string;
};

export type MonitorMetricsBucket = {
  ts: number;
  spansLlm: number;
  spansTool: number;
  spansOther: number;
  traces: number;
  errors: number;
  latencyP50: number | null;
  latencyP95: number | null;
  tokensPrompt: number;
  tokensCompletion: number;
  /** Uncached input spend: regular input tokens plus the cache-write premium. */
  costPrompt: number;
  /** Cache-read spend - the discounted reuse of cached prefix tokens. */
  costCached: number;
  costCompletion: number;
  toolCalls: number;
  toolFailures: number;
  /** Executions per tool this bucket, limited to the window's top tools (rest under "other"). */
  byTool: Record<string, number>;
  /** Priced spend per model this bucket, limited to the window's top models (rest under "other"). */
  byModelCost: Record<string, number>;
};

export type MonitorMetricsResponse = {
  window: string;
  bucketMs: number;
  start: number;
  end: number;
  buckets: MonitorMetricsBucket[];
  totals: {
    spansLlm: number;
    spansTool: number;
    spansOther: number;
    traces: number;
    errors: number;
    latencyP50: number | null;
    latencyP95: number | null;
    tokensPrompt: number;
    tokensCompletion: number;
    costPrompt: number;
    costCached: number;
    costCompletion: number;
    toolCalls: number;
    toolFailures: number;
  };
  /** Window totals per tool, executions descending - legend + stack order. */
  tools: { name: string; count: number; failed: number }[];
  /** Window spend per model, cost descending. cost 0 with tokens > 0 means the model has no
   *  Model Portability pricing - spend exists but is unknown, not free. */
  models: { name: string; cost: number; tokens: number }[];
  /** Filter suggestions: what actually appeared in the window. */
  facets: { agents: string[]; models: string[]; tools: string[] };
};

type Row = {
  id: string;
  name: string;
  model: string | null;
  latencyMs: number | null;
  parentSpanId: string | null;
  sessionId: string | null;
  toolCalls: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  error: string | null;
  createdAt: Date;
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
};

const toolCallList = (raw: unknown): { name: string; failed: boolean }[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tc): tc is Record<string, unknown> => !!tc && typeof tc === "object")
    .map(tc => ({
      name: typeof tc.name === "string" ? tc.name : "tool",
      failed: tc.success === false,
    }));
};

const TOP_TOOLS = 4;
const TOP_MODELS = 3;

export async function getMonitorMetrics(
  db: Db,
  range: MetricsRange,
  filters: MonitorMetricsFilters = {}
): Promise<MonitorMetricsResponse> {
  const ms = range.to - range.from;
  const bucketMs = bucketSizeFor(ms);
  const start = range.from;
  const since = new Date(start);
  let rows: Row[];
  if (db.kind === "sqlite") {
    const t = db.schema.traces;
    const cond = and(gte(t.createdAt, since), eq(t.projectId, db.projectId));
    rows = db.db
      .select({
        id: t.id,
        name: t.name,
        model: t.model,
        latencyMs: t.latencyMs,
        parentSpanId: t.parentSpanId,
        sessionId: t.sessionId,
        toolCalls: t.toolCalls,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        error: t.error,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(cond)
      .all() as Row[];
  } else {
    const t = db.schema.traces;
    const cond = and(gte(t.createdAt, since), eq(t.projectId, db.projectId));
    rows = (await db.db
      .select({
        id: t.id,
        name: t.name,
        model: t.model,
        latencyMs: t.latencyMs,
        parentSpanId: t.parentSpanId,
        sessionId: t.sessionId,
        toolCalls: t.toolCalls,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        error: t.error,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(cond)) as Row[];
  }

  // ---- filters, resolved per SESSION so a matching root brings its child spans along ---------
  // (a root and its children share sessionId - every SDK trace auto-creates one; rows without a
  // sessionId fall back to their own id as the grouping key).
  const keyOf = (row: Row) => row.sessionId ?? row.id;
  // Custom ranges can end in the past - drop rows past the upper bound before anything counts them.
  rows = rows.filter(row => row.createdAt.getTime() <= range.to);
  const wantsFilter = !!(filters.agent || filters.model || filters.tool || filters.status === "error");
  let filtered = rows;
  if (wantsFilter) {
    const agents = new Map<string, Set<string>>();
    const models = new Map<string, Set<string>>();
    const tools = new Map<string, Set<string>>();
    const errored = new Set<string>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!row.parentSpanId) {
        (agents.get(key) ?? agents.set(key, new Set()).get(key)!).add(row.name);
        if (row.error) errored.add(key);
      }
      if (row.model) (models.get(key) ?? models.set(key, new Set()).get(key)!).add(row.model);
      for (const tc of toolCallList(row.toolCalls)) {
        (tools.get(key) ?? tools.set(key, new Set()).get(key)!).add(tc.name);
      }
    }
    filtered = rows.filter(row => {
      const key = keyOf(row);
      if (filters.agent && !agents.get(key)?.has(filters.agent)) return false;
      if (filters.model && !models.get(key)?.has(filters.model)) return false;
      if (filters.tool && !tools.get(key)?.has(filters.tool)) return false;
      if (filters.status === "error" && !errored.has(key)) return false;
      return true;
    });
  }

  // Tool child spans are named after their tool - build the name set so the Spans card can tell
  // a tool span from a chain/step span.
  const toolNames = new Set<string>();
  for (const row of filtered) for (const tc of toolCallList(row.toolCalls)) toolNames.add(tc.name);

  const pricingModels = await listPortabilityModels(db);
  const pricingById = new Map<string, PortabilityModel>();
  for (const model of pricingModels) pricingById.set(model.id, model);
  const priceOf = (model: string | null): PortabilityModel | null =>
    model ? (pricingById.get(model) ?? pricingById.get(normalizeModelId(model)) ?? null) : null;

  const bucketCount = Math.max(1, Math.ceil(ms / bucketMs));
  const buckets: MonitorMetricsBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    ts: start + i * bucketMs,
    spansLlm: 0,
    spansTool: 0,
    spansOther: 0,
    traces: 0,
    errors: 0,
    latencyP50: null,
    latencyP95: null,
    tokensPrompt: 0,
    tokensCompletion: 0,
    costPrompt: 0,
    costCached: 0,
    costCompletion: 0,
    toolCalls: 0,
    toolFailures: 0,
    byTool: {},
    byModelCost: {},
  }));
  const latencies: number[][] = Array.from({ length: bucketCount }, () => []);
  const allLatencies: number[] = [];
  const toolTotals = new Map<string, { count: number; failed: number }>();
  const byToolPerBucket: Map<string, number[]> = new Map();
  const modelTotals = new Map<string, { cost: number; tokens: number }>();
  const byModelCostPerBucket: Map<string, number[]> = new Map();
  const facetAgents = new Set<string>();
  const facetModels = new Set<string>();

  for (const row of filtered) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((row.createdAt.getTime() - start) / bucketMs)));
    const bucket = buckets[idx]!;
    if (row.model) {
      bucket.spansLlm++;
      facetModels.add(row.model);
    } else if (row.parentSpanId && toolNames.has(row.name)) {
      bucket.spansTool++;
    } else {
      bucket.spansOther++;
    }
    if (!row.parentSpanId) {
      bucket.traces++;
      facetAgents.add(row.name);
      if (row.error) bucket.errors++;
      if (row.latencyMs != null && row.latencyMs > 0) {
        latencies[idx]!.push(row.latencyMs);
        allLatencies.push(row.latencyMs);
      }
    }
    bucket.tokensPrompt += row.inputTokens ?? 0;
    bucket.tokensCompletion += row.outputTokens ?? 0;
    const pricing = priceOf(row.model);
    if (row.model && (row.inputTokens != null || row.outputTokens != null)) {
      const rowTokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      let rowCost = 0;
      if (pricing) {
        const cacheRead = row.cacheReadTokens ?? 0;
        const cacheWrite = row.cacheWriteTokens ?? 0;
        const regularInput = Math.max(0, (row.inputTokens ?? 0) - cacheRead - cacheWrite);
        const cacheReadRate = pricing.pricePerMCacheReadTokens ?? pricing.pricePerMInputTokens;
        const cacheWriteRate = pricing.pricePerMCacheWriteTokens ?? pricing.pricePerMInputTokens;
        const cachedCost = (cacheRead / 1e6) * cacheReadRate;
        const uncachedCost =
          (regularInput / 1e6) * pricing.pricePerMInputTokens + (cacheWrite / 1e6) * cacheWriteRate;
        const outputCost = ((row.outputTokens ?? 0) / 1e6) * pricing.pricePerMOutputTokens;
        bucket.costPrompt += uncachedCost;
        bucket.costCached += cachedCost;
        bucket.costCompletion += outputCost;
        rowCost = uncachedCost + cachedCost + outputCost;
        const series = byModelCostPerBucket.get(row.model) ?? Array.from({ length: bucketCount }, () => 0);
        series[idx]! += rowCost;
        byModelCostPerBucket.set(row.model, series);
      }
      const model = modelTotals.get(row.model) ?? { cost: 0, tokens: 0 };
      model.cost += rowCost;
      model.tokens += rowTokens;
      modelTotals.set(row.model, model);
    }
    for (const tc of toolCallList(row.toolCalls)) {
      if (filters.tool && tc.name !== filters.tool) continue;
      bucket.toolCalls++;
      if (tc.failed) bucket.toolFailures++;
      const totals = toolTotals.get(tc.name) ?? { count: 0, failed: 0 };
      totals.count++;
      if (tc.failed) totals.failed++;
      toolTotals.set(tc.name, totals);
      const series = byToolPerBucket.get(tc.name) ?? Array.from({ length: bucketCount }, () => 0);
      series[idx]!++;
      byToolPerBucket.set(tc.name, series);
    }
  }

  for (let i = 0; i < bucketCount; i++) {
    const sorted = latencies[i]!.sort((a, b) => a - b);
    buckets[i]!.latencyP50 = percentile(sorted, 50);
    buckets[i]!.latencyP95 = percentile(sorted, 95);
  }

  const tools = [...toolTotals.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.count - a.count);
  const topTools = tools.slice(0, TOP_TOOLS).map(tool => tool.name);
  for (let i = 0; i < bucketCount; i++) {
    const byTool: Record<string, number> = {};
    let other = 0;
    for (const [name, series] of byToolPerBucket) {
      if (topTools.includes(name)) byTool[name] = series[i]!;
      else other += series[i]!;
    }
    if (other > 0) byTool.other = other;
    buckets[i]!.byTool = byTool;
  }

  const models = [...modelTotals.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const topModels = models.slice(0, TOP_MODELS).map(model => model.name);
  for (let i = 0; i < bucketCount; i++) {
    const byModelCost: Record<string, number> = {};
    let otherCost = 0;
    for (const [name, series] of byModelCostPerBucket) {
      if (topModels.includes(name)) byModelCost[name] = series[i]!;
      else otherCost += series[i]!;
    }
    if (otherCost > 0) byModelCost.other = otherCost;
    buckets[i]!.byModelCost = byModelCost;
  }

  const sortedAll = allLatencies.sort((a, b) => a - b);
  const totals = {
    spansLlm: buckets.reduce((n, b) => n + b.spansLlm, 0),
    spansTool: buckets.reduce((n, b) => n + b.spansTool, 0),
    spansOther: buckets.reduce((n, b) => n + b.spansOther, 0),
    traces: buckets.reduce((n, b) => n + b.traces, 0),
    errors: buckets.reduce((n, b) => n + b.errors, 0),
    latencyP50: percentile(sortedAll, 50),
    latencyP95: percentile(sortedAll, 95),
    tokensPrompt: buckets.reduce((n, b) => n + b.tokensPrompt, 0),
    tokensCompletion: buckets.reduce((n, b) => n + b.tokensCompletion, 0),
    costPrompt: buckets.reduce((n, b) => n + b.costPrompt, 0),
    costCached: buckets.reduce((n, b) => n + b.costCached, 0),
    costCompletion: buckets.reduce((n, b) => n + b.costCompletion, 0),
    toolCalls: buckets.reduce((n, b) => n + b.toolCalls, 0),
    toolFailures: buckets.reduce((n, b) => n + b.toolFailures, 0),
  };

  return {
    window: range.window,
    bucketMs,
    start,
    end: range.to,
    buckets,
    totals,
    tools,
    models,
    facets: {
      agents: [...facetAgents].sort(),
      models: [...facetModels].sort(),
      tools: tools.map(tool => tool.name),
    },
  };
}
