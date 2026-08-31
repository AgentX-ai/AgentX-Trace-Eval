import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { TraceRow } from "../trace/store/traceStore.js";
import { resolveSpanKind, toolCallList } from "../trace/spanKind.js";
import { logger } from "../../log.js";

// Per-minute metric rollups (ADR-0006): maintained at ingest, read by the Monitor dashboard's
// unfiltered default view, so chart cost is O(minutes in window) instead of O(spans stored).
//
// Shape decisions, each mirroring what the raw read path does today:
//   - Token counts are stored PER MODEL and costs are computed at read time from current
//     pricing - a pricing edit retro-affects charts exactly as it always has.
//   - Latency is a fixed log-scale histogram (mergeable across any window) plus count/sum;
//     p50/p95 derive from bucket sums with bounded, documented error. Exact percentiles are
//     only possible from raw scans, which is the O(traffic) cost this module removes.
//   - Span kinds are classified at WRITE time by the shared classifier. The raw path's
//     weakest last-resort rule (a window-wide tool-name set) is not reproducible per batch;
//     the classifier-first rules that decide real traffic are identical.
//   - One engine process per database writes rollups (the current deployment model), so the
//     read-modify-write upsert below is single-writer. Every tier uses this module, the
//     ClickHouse tier included (rollups stay in the relational control plane); native CH
//     materialized views are a named future optimization (ADR-0006), not current behavior.

export const LATENCY_BUCKET_COUNT = 40;
const LATENCY_MAX_MS = 600_000;
// bounds[i] = upper edge of bucket i, log-spaced from 1ms to 10 minutes.
const RATIO = Math.pow(LATENCY_MAX_MS, 1 / (LATENCY_BUCKET_COUNT - 1));
export const LATENCY_BOUNDS = Array.from({ length: LATENCY_BUCKET_COUNT }, (_, i) => Math.pow(RATIO, i));

export function latencyBucketIndex(ms: number): number {
  if (ms <= 1) return 0;
  const idx = Math.ceil(Math.log(ms) / Math.log(RATIO));
  return Math.min(LATENCY_BUCKET_COUNT - 1, Math.max(0, idx));
}

/** Approximate percentile from a merged histogram: the upper edge of the bucket holding it. */
export function percentileFromHistogram(hist: number[], p: number): number | null {
  const total = hist.reduce((n, v) => n + v, 0);
  if (total === 0) return null;
  const target = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!;
    if (seen >= target) return Math.round(LATENCY_BOUNDS[i]!);
  }
  return Math.round(LATENCY_BOUNDS[hist.length - 1]!);
}

export type ModelTokens = { inTok: number; outTok: number; cacheRead: number; cacheWrite: number };

export type RollupRow = {
  projectId: string | null;
  minuteTs: number;
  roots: number;
  errors: number;
  spansLlm: number;
  spansTool: number;
  spansRetrieval: number;
  spansOther: number;
  tokensPrompt: number;
  tokensCompletion: number;
  toolCalls: number;
  toolFailures: number;
  byModel: Record<string, ModelTokens>;
  byTool: Record<string, { count: number; failed: number }>;
  byAgent: Record<string, number>;
  /** Root counts per platform/framework key ("other" = unlabeled). Added after byAgent shipped:
   *  rollup rows written before this key exists read back with it undefined, so every reader
   *  and mergeInto guard with `?? {}` - the Platforms chart under-reports pre-deploy minutes
   *  (accepted, same class as ADR-0006's histogram error) while every other number stays exact. */
  byFramework: Record<string, number>;
  latencyHist: number[];
  latencyCount: number;
  latencySum: number;
  /** Same eval-traffic split the raw path applies: production rows feed the KPIs, eval rows only cost. */
  production: boolean;
};

function emptyRollup(projectId: string | null, minuteTs: number, production: boolean): RollupRow {
  return {
    projectId,
    minuteTs,
    roots: 0,
    errors: 0,
    spansLlm: 0,
    spansTool: 0,
    spansRetrieval: 0,
    spansOther: 0,
    tokensPrompt: 0,
    tokensCompletion: 0,
    toolCalls: 0,
    toolFailures: 0,
    byModel: {},
    byTool: {},
    byAgent: {},
    byFramework: {},
    latencyHist: Array.from({ length: LATENCY_BUCKET_COUNT }, () => 0),
    latencyCount: 0,
    latencySum: 0,
    production,
  };
}

export function accumulateRollups(rows: TraceRow[]): RollupRow[] {
  const byKey = new Map<string, RollupRow>();
  for (const row of rows) {
    const minuteTs = Math.floor(row.createdAt.getTime() / 60_000) * 60_000;
    const production = row.source !== "eval-run";
    const key = `${row.projectId}|${minuteTs}|${production ? 1 : 0}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = emptyRollup(row.projectId, minuteTs, production);
      byKey.set(key, acc);
    }
    const kind = resolveSpanKind({
      spanKind: row.spanKind,
      metadata: row.metadata,
      name: row.name,
      model: row.model,
      toolCalls: row.toolCalls,
      parentSpanId: row.parentSpanId,
    });
    if (kind === "llm") acc.spansLlm++;
    else if (kind === "tool") acc.spansTool++;
    else if (kind === "retrieval") acc.spansRetrieval++;
    else acc.spansOther++;

    if (!row.parentSpanId) {
      acc.roots++;
      acc.byAgent[row.name] = (acc.byAgent[row.name] ?? 0) + 1;
      const fw = row.framework ?? "other";
      acc.byFramework[fw] = (acc.byFramework[fw] ?? 0) + 1;
      if (row.error) acc.errors++;
      if (row.latencyMs != null && row.latencyMs > 0) {
        acc.latencyHist[latencyBucketIndex(row.latencyMs)]!++;
        acc.latencyCount++;
        acc.latencySum += row.latencyMs;
      }
    }
    acc.tokensPrompt += row.inputTokens ?? 0;
    acc.tokensCompletion += row.outputTokens ?? 0;
    if (row.model && (row.inputTokens != null || row.outputTokens != null)) {
      const m = acc.byModel[row.model] ?? { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 };
      m.inTok += row.inputTokens ?? 0;
      m.outTok += row.outputTokens ?? 0;
      m.cacheRead += row.cacheReadTokens ?? 0;
      m.cacheWrite += row.cacheWriteTokens ?? 0;
      acc.byModel[row.model] = m;
    }
    for (const tc of toolCallList(row.toolCalls)) {
      acc.toolCalls++;
      const t = acc.byTool[tc.name] ?? { count: 0, failed: 0 };
      t.count++;
      if (tc.failed) {
        acc.toolFailures++;
        t.failed++;
      }
      acc.byTool[tc.name] = t;
    }
  }
  return [...byKey.values()];
}

function mergeInto(target: RollupRow, add: RollupRow): void {
  target.roots += add.roots;
  target.errors += add.errors;
  target.spansLlm += add.spansLlm;
  target.spansTool += add.spansTool;
  target.spansRetrieval += add.spansRetrieval;
  target.spansOther += add.spansOther;
  target.tokensPrompt += add.tokensPrompt;
  target.tokensCompletion += add.tokensCompletion;
  target.toolCalls += add.toolCalls;
  target.toolFailures += add.toolFailures;
  for (const [model, tokens] of Object.entries(add.byModel)) {
    const m = target.byModel[model] ?? { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 };
    m.inTok += tokens.inTok;
    m.outTok += tokens.outTok;
    m.cacheRead += tokens.cacheRead;
    m.cacheWrite += tokens.cacheWrite;
    target.byModel[model] = m;
  }
  for (const [tool, stats] of Object.entries(add.byTool)) {
    const t = target.byTool[tool] ?? { count: 0, failed: 0 };
    t.count += stats.count;
    t.failed += stats.failed;
    target.byTool[tool] = t;
  }
  for (const [agent, n] of Object.entries(add.byAgent)) {
    target.byAgent[agent] = (target.byAgent[agent] ?? 0) + n;
  }
  // `?? {}` on BOTH sides: `target` may be a legacy stored row from before byFramework existed.
  const targetByFramework = (target.byFramework ??= {});
  for (const [fw, n] of Object.entries(add.byFramework ?? {})) {
    targetByFramework[fw] = (targetByFramework[fw] ?? 0) + n;
  }
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i++) target.latencyHist[i]! += add.latencyHist[i]!;
  target.latencyCount += add.latencyCount;
  target.latencySum += add.latencySum;
}

type StoredRollup = {
  projectId: string | null;
  minuteTs: number;
  production: boolean;
  data: unknown;
};

function toStored(row: RollupRow): StoredRollup {
  const { projectId, minuteTs, production, ...data } = row;
  return { projectId, minuteTs, production, data };
}

function fromStored(row: StoredRollup): RollupRow {
  return {
    projectId: row.projectId,
    minuteTs: row.minuteTs,
    production: row.production,
    ...(row.data as Omit<RollupRow, "projectId" | "minuteTs" | "production">),
  };
}

/**
 * Read-modify-write upsert keyed (project, minute, production). Single-writer per database by
 * deployment model (see module header); runs inside the ingest flush, and a failure here never
 * fails the flush - the raw spans are the source of truth, rollups are derived.
 */
export async function applyRollups(db: Db, rows: TraceRow[]): Promise<void> {
  try {
    const accums = accumulateRollups(rows);
    for (const acc of accums) {
      const t = db.schema.monitorRollups;
      const cond = and(
        eq(t.projectId, acc.projectId ?? ""),
        eq(t.minuteTs, acc.minuteTs),
        eq(t.production, acc.production)
      );
      const existing = (
        db.kind === "sqlite"
          ? db.db.select().from(db.schema.monitorRollups).where(cond).all()
          : await db.db.select().from(db.schema.monitorRollups).where(cond)
      )[0] as { data: unknown } | undefined;
      if (existing) {
        const merged = fromStored({ projectId: acc.projectId, minuteTs: acc.minuteTs, production: acc.production, data: existing.data });
        mergeInto(merged, acc);
        const stored = toStored(merged);
        if (db.kind === "sqlite") {
          await db.db.update(db.schema.monitorRollups).set({ data: stored.data }).where(cond);
        } else {
          await db.db.update(db.schema.monitorRollups).set({ data: stored.data }).where(cond);
        }
      } else {
        const stored = toStored(acc);
        const values = {
          projectId: acc.projectId ?? "",
          minuteTs: acc.minuteTs,
          production: acc.production,
          data: stored.data,
        };
        if (db.kind === "sqlite") {
          await db.db.insert(db.schema.monitorRollups).values(values).onConflictDoNothing();
        } else {
          await db.db.insert(db.schema.monitorRollups).values(values).onConflictDoNothing();
        }
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "Rollup update failed (charts fall back to raw scans):");
  }
}

/** Every production rollup minute in the window for the scoped project, ascending. */
export async function readRollups(db: Db, since: Date, opts?: { includeEval?: boolean }): Promise<RollupRow[]> {
  const t = db.schema.monitorRollups;
  const conds = [eq(t.projectId, db.projectId), gte(t.minuteTs, Math.floor(since.getTime() / 60_000) * 60_000)];
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorRollups).where(and(...conds)).all()
      : await db.db.select().from(db.schema.monitorRollups).where(and(...conds))
  ) as StoredRollup[];
  const filtered = opts?.includeEval ? rows : rows.filter(r => r.production);
  return filtered.map(fromStored).sort((a, b) => a.minuteTs - b.minuteTs);
}
