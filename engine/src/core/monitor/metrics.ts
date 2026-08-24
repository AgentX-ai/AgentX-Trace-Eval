import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listPortabilityModels, normalizeModelId, type PortabilityModel } from "../evaluate/models.js";

// The Monitor metrics grid (claude.design Monitor.dc.html): one bucketed pass over the window's
// trace rows powering every card - spans by kind, latency percentiles, tokens, priced cost,
// tool executions and failures - with agent/model/tool/status filters. Same window/bucket idiom
// as cost.ts and topics.ts, extended with a "1h" live view.

export type MetricsWindow = "1h" | "24h" | "7d" | "30d";

export function parseMetricsWindow(raw: unknown): MetricsWindow {
  return raw === "1h" || raw === "24h" || raw === "30d" ? raw : "7d";
}

function windowConfig(window: MetricsWindow): { ms: number; bucketMs: number } {
  switch (window) {
    case "1h":
      return { ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };
    case "24h":
      return { ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 };
    case "30d":
      return { ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    default:
      return { ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
  }
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
  costPrompt: number;
  costCompletion: number;
  toolCalls: number;
  toolFailures: number;
  /** Executions per tool this bucket, limited to the window's top tools (rest under "other"). */
  byTool: Record<string, number>;
};

export type MonitorMetricsResponse = {
  window: MetricsWindow;
  bucketMs: number;
  start: number;
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
    costCompletion: number;
    toolCalls: number;
    toolFailures: number;
  };
  /** Window totals per tool, executions descending - legend + stack order. */
  tools: { name: string; count: number; failed: number }[];
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

export async function getMonitorMetrics(
  db: Db,
  window: MetricsWindow,
  filters: MonitorMetricsFilters = {}
): Promise<MonitorMetricsResponse> {
  const { ms, bucketMs } = windowConfig(window);
  const start = Date.now() - ms;
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

  const bucketCount = Math.round(ms / bucketMs);
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
    costCompletion: 0,
    toolCalls: 0,
    toolFailures: 0,
    byTool: {},
  }));
  const latencies: number[][] = Array.from({ length: bucketCount }, () => []);
  const allLatencies: number[] = [];
  const toolTotals = new Map<string, { count: number; failed: number }>();
  const byToolPerBucket: Map<string, number[]> = new Map();
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
    if (pricing && (row.inputTokens != null || row.outputTokens != null)) {
      const cacheRead = row.cacheReadTokens ?? 0;
      const cacheWrite = row.cacheWriteTokens ?? 0;
      const regularInput = Math.max(0, (row.inputTokens ?? 0) - cacheRead - cacheWrite);
      const cacheReadRate = pricing.pricePerMCacheReadTokens ?? pricing.pricePerMInputTokens;
      const cacheWriteRate = pricing.pricePerMCacheWriteTokens ?? pricing.pricePerMInputTokens;
      bucket.costPrompt +=
        (regularInput / 1e6) * pricing.pricePerMInputTokens +
        (cacheRead / 1e6) * cacheReadRate +
        (cacheWrite / 1e6) * cacheWriteRate;
      bucket.costCompletion += ((row.outputTokens ?? 0) / 1e6) * pricing.pricePerMOutputTokens;
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
    costCompletion: buckets.reduce((n, b) => n + b.costCompletion, 0),
    toolCalls: buckets.reduce((n, b) => n + b.toolCalls, 0),
    toolFailures: buckets.reduce((n, b) => n + b.toolFailures, 0),
  };

  return {
    window,
    bucketMs,
    start,
    buckets,
    totals,
    tools,
    facets: {
      agents: [...facetAgents].sort(),
      models: [...facetModels].sort(),
      tools: tools.map(tool => tool.name),
    },
  };
}
