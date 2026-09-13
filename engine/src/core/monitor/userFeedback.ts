import { nanoid } from "nanoid";
import { count, desc, and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getTraceRow } from "../trace/ingest.js";
import { upsertSignal } from "./signals.js";
import { createOutcomeReport } from "../outcomes/outcomeReports.js";

// End-user feedback on a traced response - human ground truth, the third stream next to
// operational facts and scorer verdicts (see detect.ts's BUILT_IN_MONITOR_PATTERNS comment).
// The customer's app forwards its own users' votes here; a "down" raises the "negative-feedback"
// signal directly, since the user IS the detector - no sampling, no judge call, nothing to
// configure, and deliberately no catalog entry: it is not a scorer anyone opts into.
//
// Every report also dual-writes an outcome report (outcome "user_thumbs_up"/"user_thumbs_down"),
// so Judge Calibration measures AgentX's own verdicts against real human reactions with zero
// extra wiring. What this deliberately does NOT do is record a monitor event: calibration counts
// events as "AgentX flagged it in advance", and feedback is the after-the-fact report side of
// that comparison - recording an event here would make calibration agree with itself.

export type UserFeedbackRow = {
  id: string;
  traceId: string;
  rating: string;
  comment: string | null;
  endUserId: string | null;
  createdAt: Date;
  projectId: string | null;
};

function toWire(row: UserFeedbackRow) {
  return {
    _id: row.id,
    traceId: row.traceId,
    rating: row.rating as "up" | "down",
    comment: row.comment ?? undefined,
    endUserId: row.endUserId ?? undefined,
    createdAt: row.createdAt,
  };
}

export type RecordFeedbackInput = {
  traceId: string;
  rating: "up" | "down";
  comment?: string;
  endUserId?: string;
};

const MAX_ANONYMOUS_FEEDBACK_PER_TRACE = 200;
const MAX_FEEDBACK_COMMENT_CHARS = 4_000;

export async function recordUserFeedback(db: Db, input: RecordFeedbackInput) {
  const trace = await getTraceRow(db, input.traceId);
  if (!trace) return null;

  // Idempotent per (trace, end user): a retrying HTTP client re-sending the same thumbs-down
  // must not inflate the signal's occurrence count (which ranks the Attention digest) or pile
  // up duplicate outcome reports. Same rating + same voter = update-in-place; a CHANGED rating
  // replaces the old vote rather than coexisting with it.
  const voter = input.endUserId?.trim() || null;
  if (voter) {
    const dupCond = and(
      eq(db.schema.userFeedback.projectId, db.projectId),
      eq(db.schema.userFeedback.traceId, input.traceId),
      eq(db.schema.userFeedback.endUserId, voter)
    );
    const existing = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.userFeedback).where(dupCond).limit(1).all()
        : await db.db.select().from(db.schema.userFeedback).where(dupCond).limit(1)
    ) as UserFeedbackRow[];
    const prior = existing[0];
    if (prior) {
      const patch = {
        rating: input.rating,
        comment: input.comment?.trim().slice(0, MAX_FEEDBACK_COMMENT_CHARS) || null,
        createdAt: new Date(),
      };
      const idCond = and(eq(db.schema.userFeedback.id, prior.id), eq(db.schema.userFeedback.projectId, db.projectId));
      if (db.kind === "sqlite") {
        db.db.update(db.schema.userFeedback).set(patch).where(idCond).run();
      } else {
        await db.db.update(db.schema.userFeedback).set(patch).where(idCond);
      }
      return toWire({ ...prior, ...patch });
    }
  }

  // Anonymous feedback (no endUserId) has no voter to dedupe on - legitimate distinct users
  // stay distinct rows, but a misbehaving retry loop must not grow the table, the outcome
  // reports, and the signal's occurrence rank without bound. 200 anonymous votes on ONE trace
  // says everything 10,000 would; past the cap the write is acknowledged but not stored.
  if (!voter) {
    const countCond = and(
      eq(db.schema.userFeedback.projectId, db.projectId),
      eq(db.schema.userFeedback.traceId, input.traceId)
    );
    const existingCount = (
      db.kind === "sqlite"
        ? db.db.select({ n: count() }).from(db.schema.userFeedback).where(countCond).all()
        : await db.db.select({ n: count() }).from(db.schema.userFeedback).where(countCond)
    ) as Array<{ n: number }>;
    if ((existingCount[0]?.n ?? 0) >= MAX_ANONYMOUS_FEEDBACK_PER_TRACE) {
      return toWire({
        id: "capped",
        traceId: input.traceId,
        rating: input.rating,
        comment: null,
        endUserId: null,
        createdAt: new Date(),
        projectId: db.projectId,
      } as UserFeedbackRow);
    }
  }

  const row: UserFeedbackRow = {
    id: nanoid(),
    traceId: input.traceId,
    rating: input.rating,
    comment: input.comment?.trim().slice(0, MAX_FEEDBACK_COMMENT_CHARS) || null,
    endUserId: voter,
    createdAt: new Date(),
    projectId: db.projectId,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.userFeedback).values(row);
  } else {
    await db.db.insert(db.schema.userFeedback).values(row);
  }

  if (input.rating === "down") {
    await upsertSignal(
      db,
      {
        type: "negative_feedback",
        severity: "medium",
        polarity: "failure",
        summary: row.comment ? `User downvoted this response: "${row.comment}"` : "User downvoted this response",
        patternKey: "negative-feedback",
      },
      { agentId: trace.agentId, traceId: input.traceId }
    );
  }

  await createOutcomeReport(db, {
    traceId: input.traceId,
    outcome: input.rating === "down" ? "user_thumbs_down" : "user_thumbs_up",
    isNegative: input.rating === "down",
    reason: row.comment ?? undefined,
    reportedBy: row.endUserId ? `end-user:${row.endUserId}` : "end-user",
  });

  return toWire(row);
}

export async function listFeedbackForTrace(db: Db, traceId: string) {
  const cond = and(eq(db.schema.userFeedback.traceId, traceId), eq(db.schema.userFeedback.projectId, db.projectId));
  // Newest 200 - the dialog shows a handful; an abuse-inflated trace must not pull every row
  // into the heap on each open.
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.userFeedback).where(cond).orderBy(desc(db.schema.userFeedback.createdAt)).limit(200).all()
      : await db.db.select().from(db.schema.userFeedback).where(cond).orderBy(desc(db.schema.userFeedback.createdAt)).limit(200)
  ) as UserFeedbackRow[];
  return rows.map(toWire);
}
