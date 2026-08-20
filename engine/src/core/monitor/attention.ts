import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { getAgentNamesById } from "./agents.js";
import { listSignalRows } from "./signals.js";
import { listOnlineEvaluatorRows } from "./onlineEvaluators.js";

// Overview's "Needs attention" digest: the open failure signals with enough context to triage
// from the dashboard's front page - per-signal 14-day occurrence sparkline, week-over-week
// delta, the latest judge rating/justification (online-evaluator signals), and one optional
// LLM-written insight line naming what the top signals have in common.

const SPARK_DAYS = 14;
const MAX_ITEMS = 12;

export type AttentionItem = {
  signalId: string;
  summary: string;
  severity: string;
  patternKey: string;
  agentName: string | null;
  evaluatorName: string | null;
  // Latest judge rating for online-evaluator signals (0-10); null for rule/built-in signals.
  score: number | null;
  // Latest judge justification - the "Judge rationale" expander.
  justification: string | null;
  // Occurrences over the sparkline window, oldest day first.
  spark: number[];
  hits: number;
  // This week's occurrences minus last week's (7-day windows over the same 14 days).
  weekDelta: number;
};

export type AttentionDigest = {
  openSignalCount: number;
  totalOccurrences: number;
  insight: string | null;
  items: AttentionItem[];
};

type EventRow = {
  signalId: string | null;
  createdAt: Date;
  rating: number | null;
  justification: string | null;
  onlineEvaluatorId: string | null;
};

export async function getAttentionDigest(db: Db): Promise<AttentionDigest> {
  const signals = (await listSignalRows(db)).filter(row => row.polarity === "failure" && row.status === "open");
  const openSignalCount = signals.length;
  const totalOccurrences = signals.reduce((sum, row) => sum + (row.occurrenceCount ?? 1), 0);

  // Rank by recent volume first so the digest (capped) carries the busiest signals; the
  // dashboard re-sorts within these for its "Lowest score" view.
  const top = [...signals]
    .sort((a, b) => (b.occurrenceCount ?? 1) - (a.occurrenceCount ?? 1))
    .slice(0, MAX_ITEMS);
  if (top.length === 0) {
    return { openSignalCount, totalOccurrences, insight: null, items: [] };
  }

  const since = new Date(Date.now() - SPARK_DAYS * 24 * 60 * 60 * 1000);
  const cond = and(
    inArray(db.schema.monitorEvents.signalId, top.map(row => row.id)),
    gte(db.schema.monitorEvents.createdAt, since),
    eq(db.schema.monitorEvents.projectId, db.projectId)
  );
  const events = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond)
  ) as EventRow[];

  const [agentNames, evaluators] = await Promise.all([
    getAgentNamesById(db, top.map(row => row.agentId)),
    listOnlineEvaluatorRows(db),
  ]);
  const evaluatorNames = new Map(evaluators.map(row => [row.id, row.name]));

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const items: AttentionItem[] = top.map(row => {
    const own = events
      .filter(event => event.signalId === row.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const spark = new Array<number>(SPARK_DAYS).fill(0);
    for (const event of own) {
      const dayIndex = SPARK_DAYS - 1 - Math.floor((todayStart - new Date(event.createdAt).setHours(0, 0, 0, 0)) / dayMs);
      if (dayIndex >= 0 && dayIndex < SPARK_DAYS) spark[dayIndex] = (spark[dayIndex] ?? 0) + 1;
    }
    const lastWeek = spark.slice(0, 7).reduce((a, b) => a + b, 0);
    const thisWeek = spark.slice(7).reduce((a, b) => a + b, 0);

    const latestJudged = [...own].reverse().find(event => event.rating != null || event.justification);

    return {
      signalId: row.id,
      summary: row.summary,
      severity: row.severity,
      patternKey: row.patternKey,
      agentName: row.agentId ? agentNames.get(row.agentId) ?? null : null,
      evaluatorName: latestJudged?.onlineEvaluatorId
        ? evaluatorNames.get(latestJudged.onlineEvaluatorId) ?? null
        : null,
      score: latestJudged?.rating ?? null,
      justification: latestJudged?.justification ?? null,
      spark,
      hits: row.occurrenceCount ?? own.length,
      weekDelta: thisWeek - lastWeek,
    };
  });

  return { openSignalCount, totalOccurrences, insight: await getCachedInsight(db, items), items };
}

// ---------------------------------------------------------------------------
// Insight line: one sentence naming what the top signals have in common, so the module reads
// as a diagnosis instead of a list. One judge call per distinct signal-set state, cached
// in-process (self-host runs a single engine process); a cache miss returns null immediately
// and computes in the background - the dashboard's next poll picks it up. No judge key
// configured -> stays null forever, the dashboard just hides the line.
// ---------------------------------------------------------------------------

const insightCache = new Map<string, { key: string; value: string | null }>();
const insightInFlight = new Set<string>();

function insightKey(items: AttentionItem[]): string {
  return items
    .slice(0, 3)
    .map(item => `${item.signalId}:${item.hits}`)
    .join("|");
}

async function getCachedInsight(db: Db, items: AttentionItem[]): Promise<string | null> {
  if (items.length < 2) return null;
  const key = insightKey(items);
  const cached = insightCache.get(db.projectId);
  if (cached && cached.key === key) {
    return cached.value;
  }
  const flightId = `${db.projectId}:${key}`;
  if (!insightInFlight.has(flightId)) {
    insightInFlight.add(flightId);
    void computeInsight(db, items, key)
      .catch(err => {
        // Cache the miss so a missing judge key doesn't retry a doomed LLM call on every
        // Overview poll; a changed signal set (new key) tries again naturally.
        insightCache.set(db.projectId, { key, value: null });
        console.error("Attention insight generation failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => insightInFlight.delete(flightId));
  }
  return null;
}

const insightSchema = {
  type: "object",
  properties: { insight: { type: "string" } },
  required: ["insight"],
  additionalProperties: false,
} as const;

async function computeInsight(db: Db, items: AttentionItem[], key: string): Promise<void> {
  const lines = items
    .slice(0, 3)
    .map(
      (item, i) =>
        `${i + 1}. "${item.summary}" (${item.hits} occurrences${
          item.justification ? `; judge: ${item.justification.slice(0, 300)}` : ""
        })`
    )
    .join("\n");
  const result = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    jsonSchema: insightSchema,
    userMessage: `These are the top open quality signals for an AI agent. In ONE short sentence (max 25 words, plain language, no preamble), say what they have in common or which is the most actionable root cause. If they are unrelated, say which one to fix first and why.\n\n${lines}`,
  });
  const payload = result.payload as { insight?: string } | null;
  const insight = typeof payload?.insight === "string" && payload.insight.trim() ? payload.insight.trim() : null;
  insightCache.set(db.projectId, { key, value: insight });
}
