import { and, eq, gte, isNotNull, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { MonitoringWindow } from "./events.js";
import { getAgentNamesById } from "./agents.js";
import { listOnlineEvaluatorRows } from "./onlineEvaluators.js";
import { SESSION_BASELINE_KEY } from "./builtinEvaluators.js";
import { productionTracesOnly } from "../trace/evalTraffic.js";

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
  // Active time: the sum of ROOT spans' recorded latencies. The wall-clock span (lastAt-firstAt)
  // is NOT a duration - a conversation resumed days later would read as days long.
  totalLatencyMs: number;
  firstAt: string;
  lastAt: string;
  // The Judge Score column: the LOWEST latest-per-evaluator verdict among session evaluators
  // that are currently ENABLED and actually scored this session (baseline included; legacy
  // "coherence" rows count as the baseline's). Worst-wins because a session that any enabled
  // quality bar rates poorly deserves attention regardless of how the others rate it. Null until
  // any enabled judge has run; judgeName says which judge gave the low score.
  judgeRating: number | null;
  judgeName: string | null;
  judgeCheckedAt: string | null;
  // Every enabled judge's latest verdict for this session, worst-first - the table's per-judge
  // score bars. judgeRating/judgeName above are always this list's first entry (or null).
  judges: { name: string; rating: number }[];
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
    // Production only: an eval run's per-case sessions are not conversations anyone held.
    productionTracesOnly(db),
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
    totalLatencyMs: number;
    firstAt: Date;
    lastAt: Date;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const at = row.startedAt ?? row.createdAt;
    let bucket = buckets.get(row.sessionId);
    if (!bucket) {
      bucket = { agentId: null, turnCount: 0, spanCount: 0, errorCount: 0, totalLatencyMs: 0, firstAt: at, lastAt: at };
      buckets.set(row.sessionId, bucket);
    }
    bucket.spanCount++;
    if (!row.parentSpanId) {
      bucket.turnCount++;
      bucket.totalLatencyMs += row.latencyMs ?? 0;
      // The session's agent comes from ROOT spans only - same rule Live Traces applies, so the two
      // tables' AGENT columns always agree. A child span's name is a step label ("LLM Call 1"),
      // and rows arrive in arbitrary select order, so first-row-wins over all spans showed step
      // labels as the session's agent whenever a child happened to iterate first.
      bucket.agentId = bucket.agentId ?? row.agentId;
    }
    if (row.error) {
      bucket.errorCount++;
    }
    if (at < bucket.firstAt) bucket.firstAt = at;
    if (at > bucket.lastAt) bucket.lastAt = at;
  }

  // Judge Score per session: latest verdict PER evaluator, then the lowest among the ones whose
  // evaluator is currently enabled - one batched fetch for exactly the sessions on screen.
  const sessionIds = [...buckets.keys()];
  // session -> evaluatorId -> its latest score row
  const latestPerJudge = new Map<string, Map<string, SessionScoreRow>>();
  const evaluatorsById = new Map<string, { name: string; enabled: boolean }>();
  let baselineId: string | null = null;
  if (sessionIds.length > 0) {
    for (const evaluator of await listOnlineEvaluatorRows(db)) {
      evaluatorsById.set(evaluator.id, { name: evaluator.name, enabled: evaluator.enabled });
      if (evaluator.builtinKey === SESSION_BASELINE_KEY) baselineId = evaluator.id;
    }
    const scoreCond = and(
      inArray(db.schema.sessionScores.sessionId, sessionIds),
      eq(db.schema.sessionScores.projectId, db.projectId)
    );
    const scores = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.sessionScores).where(scoreCond).all()
        : await db.db.select().from(db.schema.sessionScores).where(scoreCond)
    ) as SessionScoreRow[];
    for (const score of scores) {
      // Legacy "coherence" rows (pre-baseline-judge) count as the baseline's own.
      const evaluatorId =
        score.kind === "coherence" ? baselineId : score.kind.startsWith("online-eval:") ? score.kind.slice("online-eval:".length) : null;
      if (!evaluatorId) continue;
      let perJudge = latestPerJudge.get(score.sessionId);
      if (!perJudge) {
        perJudge = new Map();
        latestPerJudge.set(score.sessionId, perJudge);
      }
      const existing = perJudge.get(evaluatorId);
      if (!existing || score.createdAt > existing.createdAt) {
        perJudge.set(evaluatorId, score);
      }
    }
  }

  const agentNames = await getAgentNamesById(db, [...buckets.values()].map(b => b.agentId));

  const sessions: SessionSummary[] = [...buckets.entries()].map(([sessionId, bucket]) => {
    const judges: { name: string; rating: number; at: Date }[] = [];
    for (const [evaluatorId, score] of latestPerJudge.get(sessionId) ?? []) {
      const evaluator = evaluatorsById.get(evaluatorId);
      // Disabled or deleted judges don't gate anything - their old verdicts shouldn't rank a
      // session either.
      if (!evaluator?.enabled || score.rating == null) continue;
      judges.push({ name: evaluator.name, rating: score.rating, at: score.createdAt });
    }
    judges.sort((a, b) => a.rating - b.rating);
    const worst = judges[0] ?? null;
    return {
      sessionId,
      agentId: bucket.agentId,
      agentName: bucket.agentId ? (agentNames.get(bucket.agentId) ?? null) : null,
      turnCount: bucket.turnCount,
      spanCount: bucket.spanCount,
      errorCount: bucket.errorCount,
      totalLatencyMs: bucket.totalLatencyMs,
      firstAt: bucket.firstAt.toISOString(),
      lastAt: bucket.lastAt.toISOString(),
      judgeRating: worst?.rating ?? null,
      judgeName: worst?.name ?? null,
      judgeCheckedAt: worst?.at.toISOString() ?? null,
      judges: judges.map(j => ({ name: j.name, rating: j.rating })),
    };
  });

  // Most recently active first, matching Live Traces' own newest-first ordering.
  sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { window, sessions };
}
