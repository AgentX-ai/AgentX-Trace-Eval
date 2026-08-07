import { nanoid } from "nanoid";
import { gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { getProfileRow } from "./profiles.js";
import { passesSampleRate } from "./routing.js";
import type { MonitoringWindow } from "./events.js";

// Third per-trace background pass, alongside detect.ts's runMonitorCheck (pattern matching) and
// onlineEvaluators.ts's runOnlineEvaluators (sampled judge scoring) — same fire-and-forget shape,
// wired into the same two call sites (routes/ingest.ts, routes/otlp.ts). Unlike those two, this
// never raises a Signal: it's pure observability, classifying what a trace was *about* rather than
// whether it was good or bad. Opt-in via monitor_profiles.topicsEnabled (default false, since this
// is real LLM spend per sampled trace) — reuses the profile's own sampleRate, no separate knob.
//
// Deliberately a fixed taxonomy (intent as free text, sentiment/issueType as small enums), not true
// unsupervised clustering — that would need persisted embeddings and a clustering step, a
// materially bigger piece left for a future pass. See the "AI Observability" comparison plan.

export type ClassificationRow = {
  id: string;
  traceId: string | null;
  agentId: string | null;
  intent: string;
  sentiment: "positive" | "neutral" | "negative";
  issueType: "none" | "refusal" | "hallucination" | "off_topic" | "incomplete" | "other";
  createdAt: Date;
};

const ISSUE_TYPES = ["none", "refusal", "hallucination", "off_topic", "incomplete", "other"] as const;

const classificationSchema = {
  type: "object",
  properties: {
    intent: { type: "string", description: "A short (2-5 word) label for what the user was trying to do." },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"], description: "The user's apparent sentiment." },
    issueType: {
      type: "string",
      enum: ISSUE_TYPES,
      description: "\"none\" if the response looks fine; otherwise the closest match.",
    },
  },
  required: ["intent", "sentiment", "issueType"],
};

async function recordClassification(
  db: Db,
  input: { traceId: string | null; agentId: string | null; intent: string; sentiment: string; issueType: string }
): Promise<void> {
  const row: ClassificationRow = {
    id: nanoid(),
    traceId: input.traceId,
    agentId: input.agentId,
    intent: input.intent,
    sentiment: input.sentiment as ClassificationRow["sentiment"],
    issueType: input.issueType as ClassificationRow["issueType"],
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorClassifications).values(row);
  } else {
    await db.db.insert(db.schema.monitorClassifications).values(row);
  }
}

type ScorableTrace = { input?: unknown; output?: unknown };

export async function runClassification(
  db: Db,
  trace: ScorableTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  const profile = ctx.agentId ? await getProfileRow(db, ctx.agentId) : null;
  if (!profile || !profile.topicsEnabled || !passesSampleRate(profile.sampleRate)) {
    return;
  }

  const inputText = typeof trace.input === "string" ? trace.input : JSON.stringify(trace.input ?? "");
  const outputText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");

  try {
    const result = await callJudgeJson({
      model: DEFAULT_JUDGE_MODEL,
      jsonSchema: classificationSchema,
      userMessage: `Classify this AI agent interaction.\n\nUser input:\n${inputText}\n\nAgent response:\n${outputText}\n\nRespond with JSON matching the schema.`,
    });
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
    });
  } catch (err) {
    console.error("Trace classification failed:", err instanceof Error ? err.message : err);
  }
}

// Same window/bucket idiom as events.ts's getOnlineEvaluatorRatings (windowConfig/listEventsSince
// there are module-private, shaped for a different accumulator — copied here rather than shared,
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
  const cond = gte(db.schema.monitorClassifications.createdAt, since);
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
