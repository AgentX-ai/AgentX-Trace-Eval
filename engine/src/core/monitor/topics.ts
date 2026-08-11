import { nanoid } from "nanoid";
import { UMAP } from "umap-js";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, computeEmbedding, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { passesSampleRate } from "./routing.js";
import { getMonitoringDefaults } from "../project/projects.js";
import type { MonitoringWindow } from "./events.js";

// Third per-trace background pass, alongside detect.ts's runMonitorCheck (pattern matching) and
// onlineEvaluators.ts's runOnlineEvaluators (sampled judge scoring) - same fire-and-forget shape,
// wired into the same two call sites (routes/ingest.ts, routes/otlp.ts). Unlike those two, this
// never raises a Signal: it's pure observability, classifying what a trace was *about* rather than
// whether it was good or bad. Opt-in via monitor_profiles.topicsEnabled (default false, since this
// is real LLM spend per sampled trace) - sampled against the project-level default sample rate
// (core/project/projects.ts's MonitoringDefaults), same as detect.ts's runMonitorCheck; no separate
// knob, and not the per-agent profile.sampleRate column, which self-host no longer reads for any
// behavior (see profiles.ts's own comment on that migration - this file used to be the one place
// still reading it).
//
// Deliberately a fixed taxonomy (intent as free text, sentiment/issueType as small enums), not true
// unsupervised clustering - that would need persisted embeddings and a clustering step, a
// materially bigger piece left for a future pass. See the "AI Observability" comparison plan.

export type ClassificationRow = {
  id: string;
  projectId: string | null;
  traceId: string | null;
  agentId: string | null;
  intent: string;
  sentiment: "positive" | "neutral" | "negative";
  issueType: "none" | "refusal" | "hallucination" | "off_topic" | "incomplete" | "other";
  createdAt: Date;
  // Powers the Topics "Map" view's UMAP projection (getTopicsMap below) - null when no
  // OPENAI_API_KEY was set or the embeddings call failed (see computeEmbedding), or for rows
  // classified before this column existed.
  embedding: number[] | null;
};

const ISSUE_TYPES = ["none", "refusal", "hallucination", "off_topic", "incomplete", "other"] as const;

const classificationSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      description:
        "A short (2-5 word) label for what the user was trying to do. If the prompt lists existing labels and one " +
        "already fits this interaction, return that label verbatim (same wording, same casing) instead of coining a " +
        "new one - only write a new label when none of the existing ones fit.",
    },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"], description: "The user's apparent sentiment." },
    issueType: {
      type: "string",
      enum: ISSUE_TYPES,
      description: "\"none\" if the response looks fine; otherwise the closest match.",
    },
  },
  required: ["intent", "sentiment", "issueType"],
};

// How many of the most common recent intents to show the judge as reuse candidates, and how far
// back to look for them. Capped rather than "all distinct intents ever" so the prompt stays small
// and the candidates stay relevant - an intent that hasn't recurred in 30 days isn't worth biasing
// toward. Deliberately global (not scoped to ctx.agentId), matching getTopIntents' existing
// cross-agent aggregation used by the Topics view itself.
const INTENT_CANDIDATE_WINDOW: MonitoringWindow = "30d";
const INTENT_CANDIDATE_LIMIT = 30;

async function recordClassification(
  db: Db,
  input: {
    traceId: string | null;
    agentId: string | null;
    intent: string;
    sentiment: string;
    issueType: string;
    embedding: number[] | null;
  }
): Promise<void> {
  const row: ClassificationRow = {
    id: nanoid(),
    projectId: db.projectId,
    traceId: input.traceId,
    agentId: input.agentId,
    intent: input.intent,
    sentiment: input.sentiment as ClassificationRow["sentiment"],
    issueType: input.issueType as ClassificationRow["issueType"],
    createdAt: new Date(),
    embedding: input.embedding,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorClassifications).values(row);
  } else {
    await db.db.insert(db.schema.monitorClassifications).values(row);
  }
}

// The single-trace counterpart to recordClassification's write - for the trace detail view (see
// core/trace/ingest.ts's toTraceDetailWireWithCost), not the aggregate Topics tab (that's
// getTopicsTrend/getTopIntents/getIssueBreakdown below). Null whenever nothing was ever
// classified for this trace - the common case, since Topics is opt-in per agent and even when on,
// still sampled - so callers treat this as "maybe show a pill," never a required field.
// order by createdAt desc + limit 1 rather than assuming uniqueness: nothing enforces exactly one
// classification per traceId (a re-ingested/duplicate trace id could in principle produce more
// than one), so this deliberately picks the most recent rather than an arbitrary row.
export async function getClassificationForTrace(db: Db, traceId: string): Promise<ClassificationRow | null> {
  const cond = and(eq(db.schema.monitorClassifications.traceId, traceId), eq(db.schema.monitorClassifications.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorClassifications).where(cond).orderBy(desc(db.schema.monitorClassifications.createdAt)).limit(1).all()
      : await db.db.select().from(db.schema.monitorClassifications).where(cond).orderBy(desc(db.schema.monitorClassifications.createdAt)).limit(1)
  ) as ClassificationRow[];
  return rows[0] ?? null;
}

type ScorableTrace = { input?: unknown; output?: unknown };

export async function runClassification(
  db: Db,
  trace: ScorableTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  // Project-level opt-in (Platform Settings > Monitoring Defaults) - moved off
  // monitor_profiles.topicsEnabled, the last per-agent monitoring setting, see
  // schema.sqlite.ts's projects.topicsEnabled comment for the migration story. Per-trace by
  // design: one interaction has one primary intent, while a session routinely mixes several, so
  // classifying at session level would blur exactly the analytics Topics exists for (the session
  // view rolls per-trace labels up instead).
  const defaults = await getMonitoringDefaults(db);
  if (!defaults.topicsEnabled) {
    return;
  }
  if (!passesSampleRate(defaults.sampleRate)) {
    return;
  }

  const inputText = typeof trace.input === "string" ? trace.input : JSON.stringify(trace.input ?? "");
  const outputText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");

  // Steer the judge toward reusing an existing label instead of coining a near-duplicate (e.g.
  // "requested refund" vs "refund request") - see this file's top comment on why real clustering
  // isn't done instead. Candidates come from the same aggregation the Topics view itself reads.
  const candidates = await getTopIntents(db, INTENT_CANDIDATE_WINDOW, INTENT_CANDIDATE_LIMIT);
  const existingIntentsBlock = candidates.length
    ? `\n\nExisting intent labels already in use - if one of these fits this interaction, return it verbatim ` +
      `instead of writing a new one:\n${candidates.map(c => `- ${c.intent}`).join("\n")}`
    : "";

  try {
    // Embedding runs alongside the judge call, not after it - same trace text, independent
    // failure modes (a missing/bad OPENAI_API_KEY shouldn't block the classification itself, and
    // vice versa; see computeEmbedding's own null-on-failure posture), no reason to serialize them.
    const [result, embedding] = await Promise.all([
      callJudgeJson({
        model: DEFAULT_JUDGE_MODEL,
        jsonSchema: classificationSchema,
        userMessage: `Classify this AI agent interaction.\n\nUser input:\n${inputText}\n\nAgent response:\n${outputText}${existingIntentsBlock}\n\nRespond with JSON matching the schema.`,
      }),
      computeEmbedding(`${inputText}\n\n${outputText}`),
    ]);
    const payload = result.payload as { intent?: string; sentiment?: string; issueType?: string } | null;
    if (!payload?.intent || !payload.sentiment || !payload.issueType) {
      return;
    }
    await recordClassification(db, {
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      intent: payload.intent,
      sentiment: payload.sentiment,
      issueType: payload.issueType,
      embedding,
    });
  } catch (err) {
    console.error("Trace classification failed:", err instanceof Error ? err.message : err);
  }
}

// Same window/bucket idiom as events.ts's getOnlineEvaluatorRatings (windowConfig/listEventsSince
// there are module-private, shaped for a different accumulator - copied here rather than shared,
// matching how getOnlineEvaluatorRatings itself doesn't reuse events.ts's own bucketize()).
function windowConfig(window: MonitoringWindow): { days: number; bucketHours: number } {
  switch (window) {
    case "24h":
      return { days: 1, bucketHours: 1 };
    case "30d":
      return { days: 30, bucketHours: 24 };
    case "7d":
    default:
      return { days: 7, bucketHours: 24 };
  }
}

async function listClassificationsSince(db: Db, since: Date): Promise<ClassificationRow[]> {
  const cond = and(gte(db.schema.monitorClassifications.createdAt, since), eq(db.schema.monitorClassifications.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorClassifications).where(cond).all()
      : await db.db.select().from(db.schema.monitorClassifications).where(cond);
  return rows as ClassificationRow[];
}

export type TopicsTrendPoint = {
  label: string;
  ts: number;
  positive: number;
  neutral: number;
  negative: number;
};

export async function getTopicsTrend(db: Db, window: MonitoringWindow): Promise<{ window: MonitoringWindow; points: TopicsTrendPoint[] }> {
  const { days, bucketHours } = windowConfig(window);
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const bucketCount = Math.ceil((days * 24 * 60 * 60 * 1000) / bucketMs);
  const bucketStartMs = Date.now() - bucketCount * bucketMs;

  const rows = await listClassificationsSince(db, new Date(bucketStartMs));

  const buckets: { positive: number; neutral: number; negative: number }[] = Array.from({ length: bucketCount }, () => ({
    positive: 0,
    neutral: 0,
    negative: 0,
  }));
  for (const row of rows) {
    const index = Math.floor((row.createdAt.getTime() - bucketStartMs) / bucketMs);
    if (index >= 0 && index < bucketCount) {
      buckets[index]![row.sentiment]++;
    }
  }

  const points = buckets.map((counts, i) => {
    const ts = bucketStartMs + i * bucketMs;
    return { label: new Date(ts).toISOString(), ts, ...counts };
  });

  return { window, points };
}

export type TopIntent = { intent: string; count: number };

export async function getTopIntents(db: Db, window: MonitoringWindow, limit = 10): Promise<TopIntent[]> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await listClassificationsSince(db, since);

  const byIntent = new Map<string, number>();
  for (const row of rows) {
    byIntent.set(row.intent, (byIntent.get(row.intent) ?? 0) + 1);
  }

  return Array.from(byIntent.entries())
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export type IssueBreakdownEntry = { issueType: string; count: number };

export async function getIssueBreakdown(db: Db, window: MonitoringWindow): Promise<IssueBreakdownEntry[]> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await listClassificationsSince(db, since);

  const byIssue = new Map<string, number>();
  for (const row of rows) {
    if (row.issueType === "none") {
      continue;
    }
    byIssue.set(row.issueType, (byIssue.get(row.issueType) ?? 0) + 1);
  }

  return Array.from(byIssue.entries())
    .map(([issueType, count]) => ({ issueType, count }))
    .sort((a, b) => b.count - a.count);
}

// "Map" view: each classified trace as one point, positioned by real semantic similarity (UMAP
// over its stored embedding, see runClassification/computeEmbedding above) rather than any
// literal metric - x/y carry no independent meaning, only relative distance does. Colored by the
// same intent classification the trend/top-intents views already use; this only adds *where* a
// point sits, not a new way of deciding what a trace is about.
export type TopicMapPoint = {
  x: number;
  y: number;
  traceId: string | null;
  intent: string;
  sentiment: ClassificationRow["sentiment"];
  issueType: ClassificationRow["issueType"];
};
export type TopicMapTopic = { intent: string; count: number; percentage: number };
export type TopicsMapResult = { insufficientData: boolean; points: TopicMapPoint[]; topics: TopicMapTopic[] };

// Below this many embedded points, UMAP's neighborhood-based projection isn't meaningful - its
// own default nNeighbors is 15, and fitting fewer points than that just draws an arbitrary shape,
// not a real semantic layout. Below this floor, tell the caller there isn't enough data yet
// instead of returning noise dressed up as a chart.
const MIN_POINTS_FOR_MAP = 10;
// Recomputing UMAP from scratch on every request (no incremental point-by-point .transform(), see
// the plan's "explicitly out of scope") is fine at self-host's realistic scale; capped here so a
// long-running install with thousands of classified traces doesn't turn this into a slow request.
const MAX_MAP_POINTS = 300;

export async function getTopicsMap(db: Db, window: MonitoringWindow): Promise<TopicsMapResult> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = (await listClassificationsSince(db, since))
    .filter((r): r is ClassificationRow & { embedding: number[] } => Array.isArray(r.embedding) && r.embedding.length > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_MAP_POINTS);

  if (rows.length < MIN_POINTS_FOR_MAP) {
    return { insufficientData: true, points: [], topics: [] };
  }

  const vectors = rows.map(r => r.embedding);
  const nNeighbors = Math.min(15, rows.length - 1);
  const projected = new UMAP({ nComponents: 2, nNeighbors }).fit(vectors);

  const points: TopicMapPoint[] = rows.map((row, i) => ({
    x: projected[i]![0]!,
    y: projected[i]![1]!,
    traceId: row.traceId,
    intent: row.intent,
    sentiment: row.sentiment,
    issueType: row.issueType,
  }));

  // Same denominator as the points shown (the capped, embedded set), not every classified row in
  // the window - so the legend's percentages always agree with what's actually on the scatter.
  const byIntent = new Map<string, number>();
  for (const row of rows) {
    byIntent.set(row.intent, (byIntent.get(row.intent) ?? 0) + 1);
  }
  const topics: TopicMapTopic[] = Array.from(byIntent.entries())
    .map(([intent, count]) => ({ intent, count, percentage: Math.round((count / rows.length) * 100) }))
    .sort((a, b) => b.count - a.count);

  return { insufficientData: false, points, topics };
}
