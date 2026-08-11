import { and, eq, gte, isNotNull, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { MonitoringWindow } from "./events.js";
import { getAgentNamesById } from "./agents.js";

// The Sessions surface under Observe: one row per conversation (traces sharing a session_id),
// the level Live Traces deliberately doesn't show (one row = one interaction there). Turn count
// counts ROOT spans only: an OTel interaction's child spans are steps inside one turn, not turns.
// Coherence comes from session_scores (core/monitor/sessionScores.ts), latest snapshot per
// session, so session QUALITY is monitorable from the table itself rather than only on demand
// inside a detail view. Same "fetch a windowed set, aggregate in JS" idiom as
// events.ts/cost.ts/modelComparison.ts rather than dialect-specific SQL aggregation.
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

type SessionTraceRow = {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  parentSpanId: string | null;
  latencyMs: number | null;
  error: string | null;
  startedAt: Date | null;
  createdAt: Date;
};

type SessionScoreRow = {
  sessionId: string;
  kind: string;
  rating: number | null;
  createdAt: Date;
};

export type SessionSummary = {
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
  turnCount: number;
  spanCount: number;
  errorCount: number;
  firstAt: string;
  lastAt: string;
  // Latest coherence snapshot, null until someone (or a future background sweep) has run one.
  coherenceRating: number | null;
  coherenceCheckedAt: string | null;
};

export type SessionsResponse = {
  window: MonitoringWindow;
  sessions: SessionSummary[];
};

export async function listSessions(db: Db, window: MonitoringWindow): Promise<SessionsResponse> {
  const since = new Date(Date.now() - windowDays(window) * 24 * 60 * 60 * 1000);
  const cond = and(
    gte(db.schema.traces.createdAt, since),
    isNotNull(db.schema.traces.sessionId),
    eq(db.schema.traces.projectId, db.projectId)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond)
  ) as SessionTraceRow[];

  type Bucket = {
    agentId: string | null;
    turnCount: number;
    spanCount: number;
    errorCount: number;
    firstAt: Date;
    lastAt: Date;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const at = row.startedAt ?? row.createdAt;
    let bucket = buckets.get(row.sessionId);
    if (!bucket) {
      bucket = { agentId: row.agentId, turnCount: 0, spanCount: 0, errorCount: 0, firstAt: at, lastAt: at };
      buckets.set(row.sessionId, bucket);
    }
    bucket.spanCount++;
    if (!row.parentSpanId) {
      bucket.turnCount++;
    }
    if (row.error) {
      bucket.errorCount++;
    }
    bucket.agentId = bucket.agentId ?? row.agentId;
    if (at < bucket.firstAt) bucket.firstAt = at;
    if (at > bucket.lastAt) bucket.lastAt = at;
  }

  // Latest coherence snapshot per session, one batched fetch for exactly the sessions on screen.
  const sessionIds = [...buckets.keys()];
  const latestCoherence = new Map<string, SessionScoreRow>();
  if (sessionIds.length > 0) {
    const scoreCond = and(
      inArray(db.schema.sessionScores.sessionId, sessionIds),
      eq(db.schema.sessionScores.kind, "coherence"),
      eq(db.schema.sessionScores.projectId, db.projectId)
    );
    const scores = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.sessionScores).where(scoreCond).all()
        : await db.db.select().from(db.schema.sessionScores).where(scoreCond)
    ) as SessionScoreRow[];
    for (const score of scores) {
      const existing = latestCoherence.get(score.sessionId);
      if (!existing || score.createdAt > existing.createdAt) {
        latestCoherence.set(score.sessionId, score);
      }
    }
  }

  const agentNames = await getAgentNamesById(db, [...buckets.values()].map(b => b.agentId));

  const sessions: SessionSummary[] = [...buckets.entries()].map(([sessionId, bucket]) => {
    const coherence = latestCoherence.get(sessionId) ?? null;
    return {
      sessionId,
      agentId: bucket.agentId,
      agentName: bucket.agentId ? (agentNames.get(bucket.agentId) ?? null) : null,
      turnCount: bucket.turnCount,
      spanCount: bucket.spanCount,
      errorCount: bucket.errorCount,
      firstAt: bucket.firstAt.toISOString(),
      lastAt: bucket.lastAt.toISOString(),
      coherenceRating: coherence?.rating ?? null,
      coherenceCheckedAt: coherence?.createdAt.toISOString() ?? null,
    };
  });

  // Most recently active first, matching Live Traces' own newest-first ordering.
  sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { window, sessions };
}
