import { and, count, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "../trace/store/index.js";
import { logger } from "../../log.js";

// The human-review queue for traces that raised NO signal - the annotation-queue half of Review.
// Signals already reach a reviewer on their own; this is how ORDINARY traffic gets in front of a
// person: someone sends a trace over ("manual"), or an automation rule samples it ("rule").
//
// Why it matters beyond labeling: a label recorded here is ground truth on a trace the judge may
// also have scored, so core/monitor/outcomeCalibration.ts can compare the two. That makes
// sampled human labels a calibration source even when nothing was ever flagged - the failure
// mode a signal-only queue can't see is the judge quietly scoring bad answers as good.

export type ReviewQueueSource = "manual" | "rule" | "signal";
export type ReviewLabel = "good" | "bad";

// A full queue is a real condition, not something to paper over: a rule sampling 5% of heavy
// traffic would otherwise bury the reviewer and keep writing rows nobody reads. Queueing past the
// cap is refused and logged, and the wire says so, rather than silently succeeding.
export const REVIEW_QUEUE_PENDING_CAP = 200;

type ReviewRow = {
  id: string;
  projectId: string | null;
  traceId: string;
  sessionId: string | null;
  source: string;
  status: string;
  label: string | null;
  correctedScore: number | null;
  judgeScoreAtQueue: number | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

type TraceSummary = {
  name: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  model: string | null;
  latencyMs: number | null;
  createdAt: Date | null;
};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

const PREVIEW = 400;

function toWire(row: ReviewRow, trace: TraceSummary | undefined) {
  return {
    _id: row.id,
    traceId: row.traceId,
    sessionId: row.sessionId ?? undefined,
    source: row.source,
    status: row.status,
    label: row.label ?? undefined,
    correctedScore: row.correctedScore,
    judgeScoreAtQueue: row.judgeScoreAtQueue,
    note: row.note ?? undefined,
    reviewedBy: row.reviewedBy ?? undefined,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // The evidence a reviewer needs, inlined so the queue renders without an N+1 fetch per row.
    trace: trace
      ? {
          agentName: trace.name ?? undefined,
          query: asText(trace.input).slice(0, PREVIEW),
          responsePreview: asText(trace.output).slice(0, PREVIEW),
          error: trace.error ?? undefined,
          model: trace.model ?? undefined,
          latencyMs: trace.latencyMs,
          seenAt: trace.createdAt ? trace.createdAt.toISOString() : null,
        }
      : null,
  };
}

// Project scoping is a plain eq, matching how calibration/tuning already read these rows: every
// writer stamps db.projectId (queueTraceForReviewSerialized), so the old or(eq, isNull)
// legacy-NULL tolerance matched rows no writer ever produces.
async function getRow(db: Db, id: string): Promise<ReviewRow | undefined> {
  const cond = and(eq(db.schema.reviewQueueItems.id, id), eq(db.schema.reviewQueueItems.projectId, db.projectId));
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.reviewQueueItems).where(cond).all()[0] as ReviewRow | undefined;
  }
  return (await db.db.select().from(db.schema.reviewQueueItems).where(cond))[0] as ReviewRow | undefined;
}

async function countPending(db: Db): Promise<number> {
  const cond = and(eq(db.schema.reviewQueueItems.projectId, db.projectId), eq(db.schema.reviewQueueItems.status, "pending"));
  const rows =
    db.kind === "sqlite"
      ? db.db.select({ pending: count() }).from(db.schema.reviewQueueItems).where(cond).all()
      : await db.db.select({ pending: count() }).from(db.schema.reviewQueueItems).where(cond);
  return Number(rows[0]?.pending ?? 0);
}

async function traceSummaries(db: Db, traceIds: string[]): Promise<Map<string, TraceSummary>> {
  const out = new Map<string, TraceSummary>();
  if (traceIds.length === 0) return out;
  // Point lookups through the port (was a full-table scan filtered in memory).
  const rows = await traceStoreFor(db).getByIds(traceIds);
  for (const [id, row] of rows) {
    out.set(id, row as unknown as TraceSummary & { id: string });
  }
  return out;
}

// The judge's own rating for this trace, if any scorer sampled it - one half of the calibration
// pair a human label completes. Latest online-eval event wins when several scored the same trace.
async function latestJudgeScore(db: Db, traceId: string): Promise<number | null> {
  const cond = and(eq(db.schema.monitorEvents.traceId, traceId), eq(db.schema.monitorEvents.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond)
  ) as { rating: number | null; onlineEvaluatorId: string | null; createdAt: Date }[];
  const scored = rows
    .filter(r => r.rating != null && r.onlineEvaluatorId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return scored[0]?.rating ?? null;
}

export type QueueForReviewInput = { traceId: string; source: ReviewQueueSource; note?: string };
export type QueueForReviewResult =
  | { ok: true; item: ReturnType<typeof toWire> }
  | { ok: false; reason: "trace_not_found" | "already_queued" | "queue_full"; pending?: number };

// Serialized per project: queueing is check-then-act (duplicate check + cap check before the
// insert) and it is driven concurrently by fire-and-forget rules per trace - two traces
// arriving together used to both pass the checks and both insert, exceeding the cap and
// double-queueing one trace. Same promise-chain shape as curation's dataset writes.
const queueChains = new Map<string, Promise<unknown>>();

export async function queueTraceForReview(db: Db, input: QueueForReviewInput): Promise<QueueForReviewResult> {
  const chainKey = db.projectId ?? "";
  const previous = queueChains.get(chainKey) ?? Promise.resolve();
  const run = previous.then(
    () => queueTraceForReviewSerialized(db, input),
    () => queueTraceForReviewSerialized(db, input)
  );
  queueChains.set(chainKey, run);
  void run.finally(() => {
    if (queueChains.get(chainKey) === run) queueChains.delete(chainKey);
  });
  return run;
}

async function queueTraceForReviewSerialized(db: Db, input: QueueForReviewInput): Promise<QueueForReviewResult> {
  const trace = (await traceStoreFor(db).getById(input.traceId)) as unknown as
    | (TraceSummary & { id: string; sessionId: string | null })
    | undefined;
  if (!trace) return { ok: false, reason: "trace_not_found" };

  // Re-queueing a trace already waiting for a verdict is a no-op, so a rule that re-fires on a
  // replayed trace (or an impatient double click) can't create duplicate work. Both checks are
  // scoped SQL queries, not a full-table scan.
  const dupCond = and(
    eq(db.schema.reviewQueueItems.projectId, db.projectId),
    eq(db.schema.reviewQueueItems.traceId, input.traceId),
    eq(db.schema.reviewQueueItems.status, "pending")
  );
  const duplicate =
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.reviewQueueItems.id }).from(db.schema.reviewQueueItems).where(dupCond).limit(1).all()
      : await db.db.select({ id: db.schema.reviewQueueItems.id }).from(db.schema.reviewQueueItems).where(dupCond).limit(1);
  if (duplicate.length > 0) {
    return { ok: false, reason: "already_queued" };
  }
  const pending = await countPending(db);
  if (pending >= REVIEW_QUEUE_PENDING_CAP) {
    logger.warn(
      { pending, cap: REVIEW_QUEUE_PENDING_CAP, source: input.source },
      "Review queue is full - not queueing this trace"
    );
    return { ok: false, reason: "queue_full", pending };
  }

  const row: ReviewRow = {
    id: nanoid(),
    projectId: db.projectId,
    traceId: input.traceId,
    sessionId: trace.sessionId ?? null,
    source: input.source,
    status: "pending",
    label: null,
    correctedScore: null,
    judgeScoreAtQueue: await latestJudgeScore(db, input.traceId),
    note: input.note?.trim() || null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.reviewQueueItems).values(row);
  } else {
    await db.db.insert(db.schema.reviewQueueItems).values(row);
  }
  return { ok: true, item: toWire(row, trace) };
}

// The queue-time snapshot races the online judges: rules and judging launch concurrently at
// ingest, so a rule-queued trace is almost always snapshotted BEFORE its judge finishes -
// null judge score on exactly the sampled traffic the queue exists to calibrate. Lazily
// re-resolve (and persist) when the score is still missing on a pending row; by list/label
// time the judge has long finished, so this converges after one read.
async function backfillJudgeScore(db: Db, row: ReviewRow): Promise<ReviewRow> {
  if (row.judgeScoreAtQueue !== null || row.status !== "pending") return row;
  const score = await latestJudgeScore(db, row.traceId);
  if (score === null) return row;
  const updated = { ...row, judgeScoreAtQueue: score };
  const cond = eq(db.schema.reviewQueueItems.id, row.id);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.reviewQueueItems).set({ judgeScoreAtQueue: score }).where(cond);
  } else {
    await db.db.update(db.schema.reviewQueueItems).set({ judgeScoreAtQueue: score }).where(cond);
  }
  return updated;
}

export async function listReviewQueue(
  db: Db,
  filter: { status?: string; source?: string } = {},
  limit = 100
) {
  // Filters and the page limit run in SQL; `pending` stays a queue-wide count (its own query)
  // regardless of the filter, since it feeds the cap gauge, not the current page.
  const conditions = [eq(db.schema.reviewQueueItems.projectId, db.projectId)];
  if (filter.status && filter.status !== "all") conditions.push(eq(db.schema.reviewQueueItems.status, filter.status));
  if (filter.source && filter.source !== "all") conditions.push(eq(db.schema.reviewQueueItems.source, filter.source));
  const cond = and(...conditions);
  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select()
          .from(db.schema.reviewQueueItems)
          .where(cond)
          .orderBy(desc(db.schema.reviewQueueItems.createdAt))
          .limit(limit)
          .all()
      : await db.db
          .select()
          .from(db.schema.reviewQueueItems)
          .where(cond)
          .orderBy(desc(db.schema.reviewQueueItems.createdAt))
          .limit(limit)
  ) as ReviewRow[];
  const page = await Promise.all(rows.map(row => backfillJudgeScore(db, row)));
  const traces = await traceSummaries(db, page.map(r => r.traceId));
  return {
    items: page.map(row => toWire(row, traces.get(row.traceId))),
    pending: await countPending(db),
    cap: REVIEW_QUEUE_PENDING_CAP,
  };
}

export type LabelReviewInput = {
  label?: ReviewLabel;
  correctedScore?: number | null;
  note?: string;
  reviewedBy?: string | null;
  status?: "pending" | "labeled" | "skipped";
};

export async function labelReviewItem(db: Db, id: string, input: LabelReviewInput) {
  let existing = await getRow(db, id);
  if (!existing) return null;
  // The label is the moment the calibration pair is sealed - last chance to recover a judge
  // score the queue-time snapshot raced past.
  existing = await backfillJudgeScore(db, existing);
  const status = input.status ?? (input.label ? "labeled" : existing.status);
  const updated: ReviewRow = {
    ...existing,
    label: input.label ?? existing.label,
    // Explicit null clears a correction; undefined leaves it alone.
    correctedScore: input.correctedScore === undefined ? existing.correctedScore : input.correctedScore,
    note: input.note === undefined ? existing.note : input.note.trim() || null,
    reviewedBy: input.reviewedBy === undefined ? existing.reviewedBy : input.reviewedBy,
    status,
    reviewedAt: status === "pending" ? null : new Date(),
  };
  const cond = and(eq(db.schema.reviewQueueItems.id, id), eq(db.schema.reviewQueueItems.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.reviewQueueItems).set(updated).where(cond);
  } else {
    await db.db.update(db.schema.reviewQueueItems).set(updated).where(cond);
  }
  const traces = await traceSummaries(db, [updated.traceId]);
  return toWire(updated, traces.get(updated.traceId));
}

export async function deleteReviewItem(db: Db, id: string): Promise<boolean> {
  const existing = await getRow(db, id);
  if (!existing) return false;
  const cond = and(eq(db.schema.reviewQueueItems.id, id), eq(db.schema.reviewQueueItems.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.reviewQueueItems).where(cond);
  } else {
    await db.db.delete(db.schema.reviewQueueItems).where(cond);
  }
  return true;
}

// Calibration input: labeled rows where a judge had also scored the trace. "agreed" means the
// judge's verdict matched the human's - with a corrected score when the reviewer gave one,
// otherwise the label read against the scorer's own alert threshold midpoint (5/10).
// Review labels feed calibration in two places, neither of which lives here anymore:
// - per-scorer: core/monitor/judgeTuning.ts joins labeled rows (by trace, windowed on
//   reviewedAt) into getEvaluatorCalibration's ground truth, which is also exactly what makes
//   a review label become judge-tuning evidence;
// - global: core/monitor/outcomeCalibration.ts counts labeled rows against recorded verdicts.
// (An earlier standalone reviewCalibrationPairs() helper computed pairs nothing consumed - it
// was removed when the real joins above landed.)
