import type { Db } from "../../storage/db.js";
import { listClassificationsSince, windowConfig } from "../monitor/topics.js";
import type { MonitoringWindow } from "../monitor/events.js";
import { SIMILARITY_BANDS } from "../evaluate/curation.js";
import { computeEmbedding } from "../evaluate/judge.js";
import { contentWords, cosine, jaccard, overlap } from "../shared/vector.js";
import { listDatasetCases, attachCaseEmbeddings, type DatasetCase } from "./cases.js";
import { groupByIntent, MIN_TRACES_PER_TOPIC } from "./coverage.js";

// "Does my dataset cover THIS?" - the inverse of coverage.ts's sweep, and the cheap half: one
// embedding for the query, cosine against the cached case embeddings, no LLM in the verdict path.
//
// Answers TWO questions, not one. "Is it tested?" is useless without "does anyone ask it?": a
// query with no coverage AND no traffic is not a hole in the suite, and reporting it as one would
// send a team writing tests for things nobody asks. That case gets its own verdict, which is why
// this is a file rather than a single cosine.

export type ProbeVerdict = "covered" | "adjacent" | "gap" | "untested-and-unasked";

export type ProbeNearestCase = {
  datasetId: string;
  datasetName: string;
  index: number;
  query: string;
  // Always returned with the score: similarity says the questions look alike, not that the case
  // asserts the same behaviour. Nobody can judge that without seeing what it expects.
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
// A paste target (PRD stories, a macro export, a compliance checklist) - generous but finite,
// since each line costs an embedding.
const MAX_BATCH = 50;

type Scorer = {
  degraded: boolean;
  bands: { covered: number; related: number };
  score(item: DatasetCase): number;
  topicScore(words: Set<string>, centroidVec: number[] | null): number;
};

function explain(
  verdict: ProbeVerdict,
  nearest: ProbeNearestCase | null,
  topic: ProbeResult["topic"],
  degraded: boolean
): string {
  switch (verdict) {
    case "covered":
      // The duplicate claim is only true under embeddings: it IS addCaseToDataset's threshold.
      // The lexical fallback is a different measure that the dedupe path does not implement, so
      // saying it there would assert something the rest of the system would not honour.
      return degraded
        ? `Wording closely matches an existing case${nearest ? ` ("${nearest.query}")` : ""}, judged by shared words ` +
          `rather than meaning. Check its expected result asserts what you meant.`
        : `Effectively the same question as an existing case${nearest ? ` ("${nearest.query}")` : ""} - close enough ` +
          `that adding it would be rejected as a duplicate. Check its expected result asserts what you meant.`;
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

async function loadContext(db: Db, window: MonitoringWindow, datasetIds?: string[]): Promise<ProbeContext> {
  const { days } = windowConfig(window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [rows, cases] = await Promise.all([listClassificationsSince(db, since), listDatasetCases(db, datasetIds)]);
  const { embedded } = await attachCaseEmbeddings(db, cases);
  // Same floor the coverage sweep applies. Without it a single stray classification is enough to
  // turn "nobody asks this" into a fabricated real gap - the one verdict the probe exists to avoid
  // handing out.
  const groups = groupByIntent(rows).filter(g => g.rows.length >= MIN_TRACES_PER_TOPIC);
  // Denominator over the SAME filtered groups the sweep uses, not every classified row - otherwise
  // one topic reports two different traffic shares depending on which screen you read it from.
  const totalTraces = groups.reduce((sum, g) => sum + g.rows.length, 0);
  return { cases, groups, totalTraces, embeddedCases: embedded };
}

async function scorerFor(query: string, ctx: ProbeContext): Promise<Scorer> {
  const queryEmbedding = ctx.embeddedCases ? await computeEmbedding(query) : null;
  const queryWords = contentWords(query);
  if (queryEmbedding) {
    return {
      degraded: false,
      bands: SIMILARITY_BANDS,
      // embedding (query only), not embeddingFull: this compares a typed query against a case's
      // question, which is the pairing SIMILARITY_BANDS was calibrated on.
      score: item => (item.embedding ? cosine(queryEmbedding, item.embedding) : -1),
      // A topic whose traces predate the embedding column has no centroid; scoring it -1 turned a
      // real gap into "nobody asks this", which is the one verdict the probe must not hand out by
      // accident. Falls back to the label test, normalized onto the same 0-1 decision.
      topicScore: (words, centroidVec) =>
        centroidVec ? cosine(queryEmbedding, centroidVec) : overlap(queryWords, words) >= 0.5 ? SIMILARITY_BANDS.related : 0,
    };
  }
  return {
    degraded: true,
    bands: LEXICAL_BANDS,
    // Query against a case query: both are full sentences, so Jaccard is symmetric and fine here.
    score: item => jaccard(queryWords, contentWords(item.query)),
    // Query against a short topic LABEL: length-biased under Jaccard, so overlap instead.
    topicScore: topicWords => overlap(queryWords, topicWords),
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
    explanation: explain(verdict, nearestCases[0] ?? null, topic, scorer.degraded),
  };
}

export async function probe(
  db: Db,
  input: { query: string; window: MonitoringWindow; datasetIds?: string[] }
): Promise<ProbeResult> {
  const ctx = await loadContext(db, input.window, input.datasetIds);
  const scorer = await scorerFor(input.query, ctx);
  return probeWith(input.query, ctx, scorer);
}

export type ProbeBatchResult = {
  results: ProbeResult[];
  rollup: { total: number; covered: number; adjacent: number; gap: number; untestedAndUnasked: number };
  degraded: boolean;
};

// The pre-launch gate: coverage against traffic that does not exist yet, which is the only answer
// here to the cold start - the sweep cannot see a surface that has not shipped. Context loads once
// for the whole batch; only the embedding is per-query.
export async function probeBatch(
  db: Db,
  input: { queries: string[]; window: MonitoringWindow; datasetIds?: string[] }
): Promise<ProbeBatchResult> {
  const queries = input.queries.map(q => q.trim()).filter(Boolean).slice(0, MAX_BATCH);
  const ctx = await loadContext(db, input.window, input.datasetIds);

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
