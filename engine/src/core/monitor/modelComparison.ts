import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listPortabilityModels, estimateCostUSD, normalizeModelId } from "../evaluate/models.js";
import type { MonitoringWindow } from "./events.js";
import { productionTracesOnly } from "../trace/evalTraffic.js";

// Overview's "Model comparison" table - how each LLM actually performing in production stacks up
// on quality, latency, cost, and volume, side by side. The production complement to the
// pre-deployment comparisons that already exist (Playground's grid, Model Portability, dataset
// version comparison): those answer "which model *would* do better on my test set," this answers
// "which model *is* doing better on real traffic." Reports on however traffic already splits
// across models (e.g. the user routing 50% to a candidate model themselves) - deliberately no
// routing/canary infrastructure here, AgentX automates the comparison, not the split.
//
// Same window idiom as cost.ts/topics.ts - copied rather than shared, same reason those two give.
function windowDays(window: MonitoringWindow): number {
  switch (window) {
    case "24h":
      return 1;
    case "30d":
      return 30;
    case "7d":
    default:
      return 7;
  }
}

type ComparisonTraceRow = {
  id: string;
  model: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

type ComparisonEventRow = {
  traceId: string | null;
  patternKey: string;
  polarity: string;
  onlineEvaluatorId: string | null;
  customEvaluatorId: string | null;
};

// Full-row selects (not per-column projections) in both functions below - a shared projection
// object trips drizzle's dual-dialect union types (SelectedFields rejects the sqlite|pg column
// union), and the codebase's existing idiom for cross-dialect fetches is full rows + a cast (see
// events.ts's listEventsSince). Volume is the same windowed set getKpis already pulls.
async function listComparisonTracesSince(db: Db, since: Date): Promise<ComparisonTraceRow[]> {
  const cond = and(gte(db.schema.traces.createdAt, since), eq(db.schema.traces.projectId, db.projectId), productionTracesOnly(db));
  // Every row, not just root spans - same reasoning as cost.ts's listCostTracesSince: an OTel
  // session's individual LLM-call spans each carry their own model/tokens, and filtering to roots
  // would undercount both spend and volume.
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond);
  return rows as ComparisonTraceRow[];
}

async function listComparisonEventsSince(db: Db, since: Date): Promise<ComparisonEventRow[]> {
  const cond = and(gte(db.schema.monitorEvents.createdAt, since), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond);
  return rows as ComparisonEventRow[];
}

export type ModelComparisonEntry = {
  model: string;
  traceCount: number;
  // Null when no Monitor verdict exists for any of this model's traces (e.g. monitoring disabled
  // for the agents using it) - shown as "-", never a fabricated 100%.
  healthRate: number | null;
  failureRate: number | null;
  p95LatencyMs: number | null;
  // Null (not $0) when the model has no pricing configured in the portability catalog - cost.ts
  // silently contributes $0 for unpriced models inside an aggregate sum, but in a side-by-side
  // table a fake $0.00 would read as "this model is free," which is worse than admitting we
  // can't price it.
  totalCostUSD: number | null;
};

export type ModelComparisonResponse = {
  window: MonitoringWindow;
  models: ModelComparisonEntry[];
};

export async function getModelComparison(db: Db, window: MonitoringWindow): Promise<ModelComparisonResponse> {
  const since = new Date(Date.now() - windowDays(window) * 24 * 60 * 60 * 1000);
  const [traces, events, pricingModels] = await Promise.all([
    listComparisonTracesSince(db, since),
    listComparisonEventsSince(db, since),
    listPortabilityModels(db),
  ]);
  const pricingByModel = new Map(pricingModels.map(m => [m.id, m]));

  // Per-trace verdict from Monitor's own event log - same classification rules events.ts's
  // tallyEvent uses (skip online/custom evaluator score rows, "healthy-response" counts healthy,
  // failure-polarity counts failing), just resolved per traceId instead of tallied into one
  // window-wide bucket.
  const verdictByTrace = new Map<string, "healthy" | "failing">();
  for (const event of events) {
    if (!event.traceId || event.onlineEvaluatorId || event.customEvaluatorId) {
      continue;
    }
    if (event.patternKey === "healthy-response") {
      // A failure verdict for the same trace wins over healthy (one bad pattern hit among
      // otherwise-clean checks still makes the trace a failure, matching how a Signal would have
      // been raised for it).
      if (!verdictByTrace.has(event.traceId)) {
        verdictByTrace.set(event.traceId, "healthy");
      }
    } else if (event.polarity === "failure") {
      verdictByTrace.set(event.traceId, "failing");
    }
  }

  type Bucket = {
    traceCount: number;
    healthy: number;
    failing: number;
    latencies: number[];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const trace of traces) {
    if (!trace.model) {
      continue;
    }
    let bucket = buckets.get(trace.model);
    if (!bucket) {
      bucket = { traceCount: 0, healthy: 0, failing: 0, latencies: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      buckets.set(trace.model, bucket);
    }
    bucket.traceCount++;
    if (trace.latencyMs != null) {
      bucket.latencies.push(trace.latencyMs);
    }
    bucket.inputTokens += trace.inputTokens ?? 0;
    bucket.outputTokens += trace.outputTokens ?? 0;
    bucket.cacheReadTokens += trace.cacheReadTokens ?? 0;
    bucket.cacheWriteTokens += trace.cacheWriteTokens ?? 0;
    const verdict = verdictByTrace.get(trace.id);
    if (verdict === "healthy") {
      bucket.healthy++;
    } else if (verdict === "failing") {
      bucket.failing++;
    }
  }

  const models: ModelComparisonEntry[] = [...buckets.entries()].map(([model, bucket]) => {
    const classified = bucket.healthy + bucket.failing;
    const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);
    const p95Index = Math.min(sortedLatencies.length - 1, Math.floor(0.95 * sortedLatencies.length));
    // Exact catalog id, else the date-suffix-normalized id (snapshot ids price as their base).
    const pricing = pricingByModel.get(model) ?? pricingByModel.get(normalizeModelId(model)) ?? null;
    return {
      model,
      traceCount: bucket.traceCount,
      healthRate: classified > 0 ? bucket.healthy / classified : null,
      failureRate: classified > 0 ? bucket.failing / classified : null,
      p95LatencyMs: sortedLatencies.length > 0 ? sortedLatencies[p95Index]! : null,
      totalCostUSD: pricing
        ? estimateCostUSD(pricing, bucket.inputTokens, bucket.outputTokens, bucket.cacheReadTokens, bucket.cacheWriteTokens)
        : null,
    };
  });

  // Busiest models first - the top row should be the model most of the traffic actually runs on.
  models.sort((a, b) => b.traceCount - a.traceCount);
  return { window, models };
}
