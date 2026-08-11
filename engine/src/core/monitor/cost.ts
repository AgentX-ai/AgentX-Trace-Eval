import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listPortabilityModels, estimateCostUSD } from "../evaluate/models.js";
import type { MonitoringWindow } from "./events.js";

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

type CostTraceRow = { model: string | null; inputTokens: number | null; outputTokens: number | null; createdAt: Date };

async function listCostTracesSince(db: Db, since: Date): Promise<CostTraceRow[]> {
  const cond = and(gte(db.schema.traces.createdAt, since), eq(db.schema.traces.projectId, db.projectId));
  // Every row in the window, not just root spans (unlike listTracesPaginated's trace-list view):
  // an OTel multi-span session's individual LLM-call spans each carry their own tokens, and its
  // root/session span typically carries none - filtering to roots would undercount real spend.
  const rows =
    db.kind === "sqlite"
      ? db.db
          .select({
            model: db.schema.traces.model,
            inputTokens: db.schema.traces.inputTokens,
            outputTokens: db.schema.traces.outputTokens,
            createdAt: db.schema.traces.createdAt,
          })
          .from(db.schema.traces)
          .where(cond)
          .all()
      : await db.db
          .select({
            model: db.schema.traces.model,
            inputTokens: db.schema.traces.inputTokens,
            outputTokens: db.schema.traces.outputTokens,
            createdAt: db.schema.traces.createdAt,
          })
          .from(db.schema.traces)
          .where(cond);
  return rows as CostTraceRow[];
}

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
    const pricing = pricingByModel.get(row.model);
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
    bucket[row.model] = (bucket[row.model] ?? 0) + cost;
    totalsByModel[row.model] = (totalsByModel[row.model] ?? 0) + cost;
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
