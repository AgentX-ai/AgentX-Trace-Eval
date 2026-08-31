import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "./store/index.js";
import type { TraceRow } from "./store/traceStore.js";
import { logger } from "../../log.js";
import { applyRollups } from "../monitor/rollups.js";

// The ingest micro-batcher (ADR-0005): spans enter a bounded in-process queue and flush in
// batches - whichever comes first of AGENTX_INGEST_FLUSH_SIZE spans or AGENTX_INGEST_FLUSH_MS.
// Batching is the difference between hundreds and tens of thousands of spans per second on
// every backend, SQLite included. The queue is bounded and sheds load VISIBLY: a full queue
// answers 429 at the route (enqueue returns false), never a silent drop.
//
// Delivery is at-least-once. The (project_id, span_id) idempotency key dedupes replays at the
// store; a row that loses that conflict is a replay whose post-ingest pipeline (detection,
// online judges, topics) must not run again, so `onStored` fires only for rows that actually
// landed. A batch that fails to insert is retried once, then dropped with the counter and log
// line that make the loss visible - the honesty rule this module exists for.

// NaN-safe: a typo'd env value falls back to the default instead of disabling the queue bound
// or turning splice(0, NaN) into a busy loop.
function envInt(name: string, def: number): number {
  const n = Number(process.env[name] ?? def);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : def;
}
const FLUSH_SIZE = envInt("AGENTX_INGEST_FLUSH_SIZE", 500);
const FLUSH_MS = envInt("AGENTX_INGEST_FLUSH_MS", 10);
const QUEUE_MAX = envInt("AGENTX_INGEST_QUEUE_MAX", 10_000);

type Pending = {
  db: Db;
  row: TraceRow;
  // Resolved once this span's batch settles. "stored" = landed; "deduped" = lost the
  // idempotency conflict to a replay; "dropped" = the batch failed its retry and the span was
  // lost - the caller answers 503 so the client redelivers. Callers ack on this, so
  // read-your-writes holds: a client that got its 200 can immediately read the trace back.
  // The post-ingest pipeline (detection, judges) also gates on it at the route, running only
  // for "stored" - never for a replay.
  resolve: (outcome: SpanOutcome) => void;
};

export type SpanOutcome = "stored" | "deduped" | "dropped";

const queue: Pending[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

// Self-metrics (ADR-0005 / phase 6): exported for /metrics and the benchmark harness.
export const ingestQueueMetrics = {
  accepted: 0,
  rejected: 0,
  stored: 0,
  deduped: 0,
  dropped: 0,
  batches: 0,
  get depth() {
    return queue.length;
  },
  maxDepth: 0,
};

function scheduleFlush(): void {
  if (queue.length >= FLUSH_SIZE) {
    void flushNow();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushNow();
    }, FLUSH_MS);
    // Never holds the process open: an idle engine with one queued span should still exit
    // cleanly on shutdown (drainIngestQueue below is the durable path).
    flushTimer.unref?.();
  }
}

/**
 * Enqueue one prepared span. `accepted: false` = queue full, the caller answers 429 with
 * Retry-After. `done` resolves when the span's batch commits - requests arriving inside the
 * same flush window share one multi-row INSERT, which is the entire throughput win, while the
 * ack still means "durably stored".
 */
export function enqueueSpan(
  pending: Omit<Pending, "resolve">
): { accepted: boolean; done: Promise<SpanOutcome> } {
  if (queue.length >= QUEUE_MAX) {
    ingestQueueMetrics.rejected++;
    return { accepted: false, done: Promise.resolve("dropped") };
  }
  let resolve!: (outcome: SpanOutcome) => void;
  const done = new Promise<SpanOutcome>(r => (resolve = r));
  queue.push({ ...pending, resolve });
  ingestQueueMetrics.accepted++;
  if (queue.length > ingestQueueMetrics.maxDepth) ingestQueueMetrics.maxDepth = queue.length;
  scheduleFlush();
  return { accepted: true, done };
}

async function insertBatch(db: Db, rows: Pending[]): Promise<void> {
  const store = traceStoreFor(db);
  let won: Set<string>;
  try {
    won = await store.insertSpans(rows.map(p => p.row));
  } catch (err) {
    // One retry, then a visible drop: at-least-once with a bounded blast radius. The classic
    // trigger is a transient backend hiccup; a persistent one shows up in `dropped` and logs.
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      won = await store.insertSpans(rows.map(p => p.row));
    } catch (retryErr) {
      ingestQueueMetrics.dropped += rows.length;
      logger.error(
        { err: retryErr instanceof Error ? retryErr.message : retryErr, spans: rows.length },
        "Ingest batch failed after retry - spans dropped:"
      );
      for (const p of rows) p.resolve("dropped");
      return;
    }
  }
  // Rollups (ADR-0006) derive from the rows that actually landed, inside the same flush; a
  // rollup failure never fails ingestion (raw spans stay the source of truth).
  await applyRollups(db, rows.filter(p => won.has(p.row.id)).map(p => p.row));
  for (const p of rows) {
    const landed = won.has(p.row.id);
    if (landed) {
      ingestQueueMetrics.stored++;
    } else {
      ingestQueueMetrics.deduped++;
    }
    p.resolve(landed ? "stored" : "deduped");
  }
}

/**
 * Flush everything queued right now. Serialized: at most one pass runs at a time. The dedupe
 * strategy on ClickHouse and partitioned Postgres (check-then-insert) and applyRollups'
 * read-modify-write both REST on this - two concurrent passes could double-insert a replayed
 * span_id and lose rollup deltas. Hence the re-check loop: a waiter that was suspended on a
 * prior pass must not claim the slot until no pass is in flight (the claim itself is
 * synchronous after the last await, so it cannot race another waiter).
 */
export async function flushNow(): Promise<void> {
  while (flushing) {
    await flushing;
  }
  if (queue.length === 0) return;
  const pass = (async () => {
    while (queue.length > 0) {
      const batch = queue.splice(0, FLUSH_SIZE);
      ingestQueueMetrics.batches++;
      // Rows are grouped per project: one multi-row INSERT per scoped handle. Insertion order
      // within a project is preserved.
      const byProject = new Map<string, Pending[]>();
      for (const p of batch) {
        const key = p.db.projectId ?? "";
        const group = byProject.get(key);
        if (group) group.push(p);
        else byProject.set(key, [p]);
      }
      for (const group of byProject.values()) {
        await insertBatch(group[0]!.db, group);
      }
    }
  })();
  flushing = pass;
  try {
    await pass;
  } finally {
    if (flushing === pass) flushing = null;
  }
}

/** Graceful shutdown: everything accepted is stored before the process exits. */
export async function drainIngestQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushNow();
}
