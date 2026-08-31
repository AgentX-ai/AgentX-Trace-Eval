import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "../trace/store/index.js";
import { listPortabilityModels, estimateCostUSD, normalizeModelId } from "../evaluate/models.js";
import type { MonitoringWindow } from "./events.js";
import { EVAL_RUN_SOURCE } from "../trace/evalTraffic.js";

// Overview's "Total LLM cost" chart (Braintrust-style stacked bar, but stacked by model rather
// than token type - self-host doesn't track cache-read/cache-write tokens per trace today, and
// for a multi-agent workspace "which model is costing me money" is the more useful breakdown
// anyway). Reuses Model Portability's own $/M-token pricing table (core/evaluate/models.ts) as
// the pricing source - traces whose model isn't in that table contribute $0 (no pricing to go on,
// same "approximate, user-maintained" positioning models.ts already documents).
//
// Same window/bucket idiom as topics.ts's getTopicsTrend - copied rather than shared, same reason
// topics.ts gives for not reusing events.ts's own bucketize().
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

type CostTraceRow = { model: string | null; inputTokens: number | null; outputTokens: number | null; createdAt: Date; source: string | null };

async function listCostTracesSince(db: Db, since: Date): Promise<CostTraceRow[]> {
  // Every row in the window, not just root spans: an OTel multi-span session's individual
  // LLM-call spans each carry their own tokens; filtering to roots would undercount real spend.
  return (await traceStoreFor(db).queryWindow({ since })) as CostTraceRow[];
}

// The reserved stack key for spend from eval-run traffic. Eval spend is real money, so the
// chart INCLUDES it - split into its own segment - where the monitor KPIs exclude it entirely.
export const EVAL_COST_KEY = "eval runs";

export type CostTrendPoint = {
  label: string;
  ts: number;
  byModel: Record<string, number>;
};

export type CostTrendResponse = {
  window: MonitoringWindow;
  points: CostTrendPoint[];
  // Models actually seen with priced spend in the window, sorted by total cost descending - the
  // frontend uses this order both for stack-segment order and the legend rows below the chart.
  models: string[];
  totalsByModel: Record<string, number>;
  totalCost: number;
};

// Models seen on token-bearing traces (last 30 days) with no catalog pricing, exact or
// date-suffix-normalized - the Platform Settings pricing panel lists these with a one-click
// "add pricing" prefill, so unpriced spend is visible instead of silently contributing $0 to the
// cost chart. Grouped under the normalized id (one row covers all snapshots of a model).
export type UnpricedModel = {
  model: string;
  traces: number;
  inputTokens: number;
  outputTokens: number;
};

export async function listUnpricedModels(db: Db): Promise<UnpricedModel[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [rows, pricingModels] = await Promise.all([listCostTracesSince(db, since), listPortabilityModels(db)]);
  const pricedIds = new Set(pricingModels.map(model => model.id));

  const byModel = new Map<string, UnpricedModel>();
  for (const row of rows) {
    if (!row.model) {
      continue;
    }
    if ((row.inputTokens ?? 0) + (row.outputTokens ?? 0) === 0) {
      continue;
    }
    if (pricedIds.has(row.model) || pricedIds.has(normalizeModelId(row.model))) {
      continue;
    }
    const key = normalizeModelId(row.model);
    const entry = byModel.get(key) ?? { model: key, traces: 0, inputTokens: 0, outputTokens: 0 };
    entry.traces++;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    byModel.set(key, entry);
  }
  return Array.from(byModel.values()).sort((a, b) => b.traces - a.traces);
}

export async function getCostTrend(db: Db, window: MonitoringWindow): Promise<CostTrendResponse> {
  const { days, bucketHours } = windowConfig(window);
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const bucketCount = Math.ceil((days * 24 * 60 * 60 * 1000) / bucketMs);
  const bucketStartMs = Date.now() - bucketCount * bucketMs;

  const [rows, pricingModels] = await Promise.all([
    listCostTracesSince(db, new Date(bucketStartMs)),
    listPortabilityModels(db),
  ]);
  const pricingByModel = new Map(pricingModels.map(model => [model.id, model]));

  const buckets: Record<string, number>[] = Array.from({ length: bucketCount }, () => ({}));
  const totalsByModel: Record<string, number> = {};
  let totalCost = 0;

  for (const row of rows) {
    if (!row.model) {
      continue;
    }
    // Exact catalog id first, then the date-suffix-normalized id - and the MATCHED id becomes the
    // chart key, so "gpt-4o-mini" and "gpt-4o-mini-2024-07-18" merge into one stack segment.
    const matchedId = pricingByModel.has(row.model) ? row.model : normalizeModelId(row.model);
    const pricing = pricingByModel.get(matchedId);
    if (!pricing) {
      continue;
    }
    const cost = estimateCostUSD(pricing, row.inputTokens, row.outputTokens);
    if (!cost) {
      continue;
    }
    const index = Math.floor((row.createdAt.getTime() - bucketStartMs) / bucketMs);
    if (index < 0 || index >= bucketCount) {
      continue;
    }
    const bucket = buckets[index]!;
    // Eval-run spend goes into its own segment rather than the model's: the question this chart
    // answers is "what is production costing me, and what is evaluation costing me" - folding
    // eval spend into gpt-4o-mini's bar would hide the second answer inside the first.
    const key = row.source === EVAL_RUN_SOURCE ? EVAL_COST_KEY : matchedId;
    bucket[key] = (bucket[key] ?? 0) + cost;
    totalsByModel[key] = (totalsByModel[key] ?? 0) + cost;
    totalCost += cost;
  }

  const models = Object.entries(totalsByModel)
    .sort(([, a], [, b]) => b - a)
    .map(([model]) => model);

  const points = buckets.map((byModel, i) => {
    const ts = bucketStartMs + i * bucketMs;
    return { label: new Date(ts).toISOString(), ts, byModel };
  });

  return { window, points, models, totalsByModel, totalCost };
}
