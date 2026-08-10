import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Matches AgentX-web-front's AgentSignalFeedback (src/types/agentMonitoring.ts). One row per
// POST /agent-monitoring/signals/:id/feedback call, not deduped/upserted like signals themselves
// — SignalFeedbackDialog renders every submission in a "Previous feedback" list.
export type FeedbackRow = {
  id: string;
  projectId: string | null;
  signalId: string;
  // Which occurrence (monitor_events.id) this note is about — null for signal-level feedback (no
  // occurrence picked, or an older row from before this existed). See resolveOccurrenceContext in
  // suggestions.ts for the read side.
  eventId: string | null;
  metric: string;
  originalScore: number | null;
  correctedScore: number | null;
  rationale: string;
  queuedForAutotune: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toWire(row: FeedbackRow) {
  return {
    _id: row.id,
    workspaceId: "local",
    signalId: row.signalId,
    occurrenceId: row.eventId ?? undefined,
    metric: row.metric,
    originalScore: row.originalScore ?? undefined,
    correctedScore: row.correctedScore ?? undefined,
    rationale: row.rationale,
    // reviewerId is populated to a {_id, name, avatar} User on the hosted SaaS; self-host has no
    // user/auth model at all to attribute feedback to, so it's just omitted rather than faked.
    queuedForAutotune: row.queuedForAutotune,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type CreateFeedbackInput = {
  metric: string;
  rationale: string;
  occurrenceId?: string;
  originalScore?: number;
  correctedScore?: number;
  queuedForAutotune?: boolean;
};

export async function createFeedback(db: Db, signalId: string, input: CreateFeedbackInput) {
  const now = new Date();
  const row: FeedbackRow = {
    id: nanoid(),
    projectId: db.projectId,
    signalId,
    eventId: input.occurrenceId ?? null,
    metric: input.metric,
    originalScore: input.originalScore ?? null,
    correctedScore: input.correctedScore ?? null,
    rationale: input.rationale,
    queuedForAutotune: input.queuedForAutotune ?? false,
    createdAt: now,
    updatedAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorSignalFeedback).values(row);
  } else {
    await db.db.insert(db.schema.monitorSignalFeedback).values(row);
  }
  return toWire(row);
}

export async function listFeedbackForSignal(db: Db, signalId: string) {
  const cond = and(eq(db.schema.monitorSignalFeedback.signalId, signalId), eq(db.schema.monitorSignalFeedback.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorSignalFeedback).where(cond).all()
      : await db.db.select().from(db.schema.monitorSignalFeedback).where(cond);
  return (rows as FeedbackRow[]).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toWire);
}
