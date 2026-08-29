import type { Db } from "../../storage/db.js";
import { listClassificationsSince, windowConfig } from "../monitor/topics.js";
import type { MonitoringWindow } from "../monitor/events.js";
import { SIMILARITY_BANDS } from "../evaluate/curation.js";
import { computeEmbedding } from "../evaluate/judge.js";
import { contentWords, cosine, jaccard } from "../shared/vector.js";
import { listDatasetCases, attachCaseEmbeddings, type DatasetCase } from "./cases.js";
import { groupByIntent } from "./coverage.js";

// The probe: "does my dataset cover THIS?", asked in the words someone actually has the question
// in. Coverage (coverage.ts) is a sweep over topics production already produced; this is the
// inverse lookup, and it is the cheap half - one embedding for the query, cosine against the
// cached case embeddings, no LLM in the verdict path.
//
// It deliberately answers TWO questions, not one, because the answer to "is it tested?" is
// useless without "does anyone ask it?". A query with no coverage AND no traffic is not a hole in
// the suite - reporting it as one would send a team writing tests for things nobody asks. That
// case gets its own verdict, and it is the reason this file exists rather than a single cosine.

export type ProbeVerdict = "covered" | "adjacent" | "gap" | "untested-and-unasked";

export type ProbeNearestCase = {
  datasetId: string;
  datasetName: string;
  index: number;
  query: string;
  // Always returned alongside the score: query-to-query similarity measures topical resemblance,
  // NOT that the case asserts the same behavior. The human makes the final call, and cannot make
  // it without seeing what the nearest case actually expects.
  expectedResults: string | null;
  similarity: number;
};

export type ProbeResult = {
  query: string;
  verdict: ProbeVerdict;
  /** Best case similarity, on whichever scale `degraded` implies. */
  similarity: number;
  bands: { covered: number; related: number };
  degraded: boolean;
  nearestCases: ProbeNearestCase[];
  /** The production topic this query lands in, when one is close enough. */
  topic: { topic: string; trafficShare: number; traceCount: number } | null;
  /** Human-readable, and the thing the dashboard renders verbatim. */
  explanation: string;
};

const NEAREST_CASES = 3;
const LEXICAL_BANDS = { covered: 0.5, related: 0.25 } as const;
// Batch mode is a paste target (a PRD's user stories, a support macro export, a compliance
// checklist), so the cap is generous but finite - one probe per line, each needing an embedding.
const MAX_BATCH = 50;

type Scorer = {
  degraded: boolean;
  bands: { covered: number; related: number };
  score(item: DatasetCase): number;
  topicScore(words: Set<string>, centroidVec: number[] | null): number;
};

function explain(verdict: ProbeVerdict, nearest: ProbeNearestCase | null, topic: ProbeResult["topic"]): string {
  switch (verdict) {
    case "covered":
      return (
        `Effectively the same question as an existing case${nearest ? ` ("${nearest.query}")` : ""} - close enough that ` +
        `adding it would be rejected as a duplicate. Check its expected result asserts what you meant.`
      );
    case "adjacent":
      return (
        `The nearest case asks something related but not this${nearest ? ` ("${nearest.query}")` : ""}. It sits in the ` +
        `band measured for related-but-distinct questions, so it will not catch a regression specific to your query.`
      );
    case "gap":
      return (
        `Nothing in the dataset is close, and production does ask this` +
        `${topic ? ` (topic "${topic.topic}", ${Math.round(topic.trafficShare * 100)}% of classified traffic)` : ""}. ` +
        `This is a real gap.`
      );
    default:
      return (
        "Nothing in the dataset is close - but nothing in production resembles this either. It may be worth testing " +
        "anyway, but this is not a gap in your coverage of real traffic."
      );
  }
}

type ProbeContext = {
  cases: DatasetCase[];
  groups: ReturnType<typeof groupByIntent>;
  totalTraces: number;
  embeddedCases: boolean;
};

async function loadContext(db: Db, window: MonitoringWindow, datasetId?: string): Promise<ProbeContext> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [rows, cases] = await Promise.all([listClassificationsSince(db, since), listDatasetCases(db, datasetId)]);
  const { embedded } = await attachCaseEmbeddings(db, cases);
  const groups = groupByIntent(rows);
  return { cases, groups, totalTraces: rows.length, embeddedCases: embedded };
}

async function scorerFor(query: string, ctx: ProbeContext): Promise<Scorer> {
  const queryEmbedding = ctx.embeddedCases ? await computeEmbedding(query) : null;
  if (queryEmbedding) {
    return {
      degraded: false,
      bands: SIMILARITY_BANDS,
      score: item => (item.embedding ? cosine(queryEmbedding, item.embedding) : -1),
      topicScore: (_words, centroidVec) => (centroidVec ? cosine(queryEmbedding, centroidVec) : -1),
    };
  }
  const words = contentWords(query);
  return {
    degraded: true,
    bands: LEXICAL_BANDS,
    score: item => jaccard(words, contentWords(item.query)),
    topicScore: topicWords => jaccard(words, topicWords),
  };
}

function probeWith(query: string, ctx: ProbeContext, scorer: Scorer): ProbeResult {
  const scored = ctx.cases
    .map(item => ({ item, similarity: scorer.score(item) }))
    .filter(entry => entry.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, NEAREST_CASES);

  const nearestCases: ProbeNearestCase[] = scored.map(entry => ({
    datasetId: entry.item.datasetId,
    datasetName: entry.item.datasetName,
    index: entry.item.index,
    query: entry.item.query,
    expectedResults: entry.item.expectedResults,
    similarity: Math.round(entry.similarity * 1000) / 1000,
  }));

  const best = nearestCases[0]?.similarity ?? 0;

  let topic: ProbeResult["topic"] = null;
  let bestTopicScore = -1;
  for (const group of ctx.groups) {
    const score = scorer.topicScore(group.words, group.centroid);
    if (score > bestTopicScore) {
      bestTopicScore = score;
      topic = {
        topic: group.topic,
        trafficShare: ctx.totalTraces === 0 ? 0 : Math.round((group.rows.length / ctx.totalTraces) * 1000) / 1000,
        traceCount: group.rows.length,
      };
    }
  }
  // A topic the query doesn't actually belong to is worse than no topic: it would turn "nobody
  // asks this" into a fabricated gap against an unrelated topic's traffic.
  if (bestTopicScore < scorer.bands.related) {
    topic = null;
  }

  const verdict: ProbeVerdict =
    best >= scorer.bands.covered
      ? "covered"
      : best >= scorer.bands.related
        ? "adjacent"
        : topic
          ? "gap"
          : "untested-and-unasked";

  return {
    query,
    verdict,
    similarity: Math.round(best * 1000) / 1000,
    bands: scorer.bands,
    degraded: scorer.degraded,
    nearestCases,
    topic,
    explanation: explain(verdict, nearestCases[0] ?? null, topic),
  };
}

export async function probe(
  db: Db,
  input: { query: string; window: MonitoringWindow; datasetId?: string }
): Promise<ProbeResult> {
  const ctx = await loadContext(db, input.window, input.datasetId);
  const scorer = await scorerFor(input.query, ctx);
  return probeWith(input.query, ctx, scorer);
}

export type ProbeBatchResult = {
  results: ProbeResult[];
  rollup: { total: number; covered: number; adjacent: number; gap: number; untestedAndUnasked: number };
  degraded: boolean;
};

// Batch mode is the pre-launch gate: paste what users will ask about a surface that hasn't
// shipped, and get coverage against traffic that doesn't exist yet. It is the only answer here to
// the cold-start problem - the topic map only knows the past, so a brand-new surface is invisible
// to the sweep until it has already shipped and started failing. Context is loaded ONCE for the
// whole batch; only the per-query embedding is per-query.
export async function probeBatch(
  db: Db,
  input: { queries: string[]; window: MonitoringWindow; datasetId?: string }
): Promise<ProbeBatchResult> {
  const queries = input.queries.map(q => q.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const ctx = await loadContext(db, input.window, input.datasetId);

  const results: ProbeResult[] = [];
  for (const query of queries) {
    const scorer = await scorerFor(query, ctx);
    results.push(probeWith(query, ctx, scorer));
  }

  return {
    results,
    rollup: {
      total: results.length,
      covered: results.filter(r => r.verdict === "covered").length,
      adjacent: results.filter(r => r.verdict === "adjacent").length,
      gap: results.filter(r => r.verdict === "gap").length,
      untestedAndUnasked: results.filter(r => r.verdict === "untested-and-unasked").length,
    },
    degraded: results.some(r => r.degraded),
  };
}
