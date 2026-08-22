import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
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

export async function recordUserFeedback(db: Db, input: RecordFeedbackInput) {
  const trace = await getTraceRow(db, input.traceId);
  if (!trace) return null;

  const row: UserFeedbackRow = {
    id: nanoid(),
    traceId: input.traceId,
    rating: input.rating,
    comment: input.comment?.trim() || null,
    endUserId: input.endUserId?.trim() || null,
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
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.userFeedback).where(cond).all()
      : await db.db.select().from(db.schema.userFeedback).where(cond)
  ) as UserFeedbackRow[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return rows.map(toWire);
}
