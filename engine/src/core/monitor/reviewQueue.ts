import { and, desc, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
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

async function listRows(db: Db): Promise<ReviewRow[]> {
  const cond = or(eq(db.schema.reviewQueueItems.projectId, db.projectId), isNull(db.schema.reviewQueueItems.projectId));
  if (db.kind === "sqlite") {
    return db.db
      .select()
      .from(db.schema.reviewQueueItems)
      .where(cond)
      .orderBy(desc(db.schema.reviewQueueItems.createdAt))
      .all() as ReviewRow[];
  }
  return (await db.db
    .select()
    .from(db.schema.reviewQueueItems)
    .where(cond)
    .orderBy(desc(db.schema.reviewQueueItems.createdAt))) as ReviewRow[];
}

async function getRow(db: Db, id: string): Promise<ReviewRow | undefined> {
  const cond = and(
    eq(db.schema.reviewQueueItems.id, id),
    or(eq(db.schema.reviewQueueItems.projectId, db.projectId), isNull(db.schema.reviewQueueItems.projectId))
  );
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.reviewQueueItems).where(cond).all()[0] as ReviewRow | undefined;
  }
  return (await db.db.select().from(db.schema.reviewQueueItems).where(cond))[0] as ReviewRow | undefined;
}

async function traceSummaries(db: Db, traceIds: string[]): Promise<Map<string, TraceSummary>> {
  const out = new Map<string, TraceSummary>();
  if (traceIds.length === 0) return out;
  const wanted = new Set(traceIds);
  // One scan, filtered in memory: the queue is capped at a couple hundred rows, so this stays
  // cheaper than an IN-list built per dialect.
  const cond = eq(db.schema.traces.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond)
  ) as (TraceSummary & { id: string })[];
  for (const row of rows) {
    if (wanted.has(row.id)) {
      out.set(row.id, row);
    }
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

export async function queueTraceForReview(db: Db, input: QueueForReviewInput): Promise<QueueForReviewResult> {
  const traceCond = and(eq(db.schema.traces.id, input.traceId), eq(db.schema.traces.projectId, db.projectId));
  const trace = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(traceCond).all()[0]
      : (await db.db.select().from(db.schema.traces).where(traceCond))[0]
  ) as (TraceSummary & { id: string; sessionId: string | null }) | undefined;
  if (!trace) return { ok: false, reason: "trace_not_found" };

  const existing = await listRows(db);
  // Re-queueing a trace already waiting for a verdict is a no-op, so a rule that re-fires on a
  // replayed trace (or an impatient double click) can't create duplicate work.
  if (existing.some(r => r.traceId === input.traceId && r.status === "pending")) {
    return { ok: false, reason: "already_queued" };
  }
  const pending = existing.filter(r => r.status === "pending").length;
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

export async function listReviewQueue(
  db: Db,
  filter: { status?: string; source?: string } = {},
  limit = 100
) {
  let rows = await listRows(db);
  if (filter.status && filter.status !== "all") rows = rows.filter(r => r.status === filter.status);
  if (filter.source && filter.source !== "all") rows = rows.filter(r => r.source === filter.source);
  const page = rows.slice(0, limit);
  const traces = await traceSummaries(db, page.map(r => r.traceId));
  return {
    items: page.map(row => toWire(row, traces.get(row.traceId))),
    pending: rows.filter(r => r.status === "pending").length,
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
  const existing = await getRow(db, id);
  if (!existing) return null;
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
  const cond = eq(db.schema.reviewQueueItems.id, id);
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
  const cond = eq(db.schema.reviewQueueItems.id, id);
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
export type ReviewCalibrationPair = {
  traceId: string;
  judgeScore: number;
  label: ReviewLabel;
  correctedScore: number | null;
  agreed: boolean;
};

export async function reviewCalibrationPairs(db: Db): Promise<ReviewCalibrationPair[]> {
  const rows = await listRows(db);
  return rows
    .filter(r => r.status === "labeled" && r.label && r.judgeScoreAtQueue != null)
    .map(r => {
      const judgeScore = r.judgeScoreAtQueue!;
      const label = r.label as ReviewLabel;
      const judgeSaysGood = judgeScore >= 5;
      return {
        traceId: r.traceId,
        judgeScore,
        label,
        correctedScore: r.correctedScore,
        agreed: label === "good" ? judgeSaysGood : !judgeSaysGood,
      };
    });
}
