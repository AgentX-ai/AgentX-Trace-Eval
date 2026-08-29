import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listClassificationsSince, windowConfig, type ClassificationRow } from "../monitor/topics.js";
import type { MonitoringWindow } from "../monitor/events.js";
import { SIMILARITY_BANDS } from "../evaluate/curation.js";
import { centroid, contentWords, cosine, jaccard, normalizeText } from "../shared/vector.js";
import { listDatasetCases, attachCaseEmbeddings, type DatasetCase } from "./cases.js";

// Insights, Phase 0: the join between what production does (monitor_classifications) and what the
// datasets test. Everything here is derived on read - there is no insight_topics table yet, and
// topics are the `intent` strings the classifier already writes, grouped and normalized. Real
// centroid clustering is Phase 1; the point of this pass is that the numbers are honest about
// which of the two they were computed with, never that they are final.
//
// Two similarity regimes, one code path. With embeddings we use cosine and the bands
// core/evaluate/curation.ts already calibrated for text-embedding-3-small. Without them (no
// OPENAI_API_KEY, or a dataset whose cases haven't been embedded yet) we fall back to Jaccard
// over content words, which is a genuinely weaker signal on a different scale - so it carries its
// own thresholds and every response says `degraded: true`. A degraded number is labelled, never
// silently passed off as the real one.

export type CoverageState = "covered" | "underrepresented" | "missing";

export type TopicCoverage = {
  topic: string;
  /** Other intent labels the classifier used for this same topic, merged in. */
  aliases: string[];
  state: CoverageState;
  /** Share of classified traffic in the window, 0-1. */
  trafficShare: number;
  traceCount: number;
  uniqueSessions: number;
  /** Cases assigned to this topic. */
  caseCount: number;
  targetCases: number;
  /** 0-1. Facility-location value over the topic's traces, or the count ratio when degraded. */
  coverage: number;
  /** 0-1, observed only - see riskComponents. Phase 1.5 adds declared business risk. */
  risk: number;
  riskComponents: { issueRate: number; negativeSentimentRate: number };
  suggestedAction: string;
};

export type CoverageResult = {
  window: MonitoringWindow;
  datasetId: string | null;
  /** True when the numbers came from the lexical fallback rather than embeddings. */
  degraded: boolean;
  degradedReason: string | null;
  /** No classified traffic in the window - Topics is opt-in and sampled, so this is common. */
  insufficientData: boolean;
  trafficWeightedCoverage: number;
  topicBreadth: { covered: number; total: number };
  riskWeightedCoverage: number;
  /** The same traffic-weighted number computed on case presence alone - see honestyDelta. */
  presenceCoverage: number;
  /**
   * presenceCoverage - trafficWeightedCoverage. A large gap means the dataset has rows where it
   * does not have depth, which is the difference between "write new cases" and "deepen the ones
   * you have" - two different afternoons of work that no single percentage distinguishes.
   */
  honestyDelta: number;
  topics: TopicCoverage[];
  /** Cases matching no topic: either dead test weight, or a topic the classifier hasn't seen. */
  offMapCases: { datasetId: string; index: number; query: string; bestSimilarity: number }[];
  caseEmbeddingsPending: number;
};

// A topic needs at least this many classified traces before it gets a coverage verdict. Below it,
// one stray classification would become a "missing topic" with a target and a suggested action -
// noise dressed up as a work item, the same failure getTopicsMap's MIN_POINTS_FOR_MAP guards.
const MIN_TRACES_PER_TOPIC = 2;

// Lexical fallback bands. Deliberately NOT the cosine ones: Jaccard over content words runs on a
// different scale, and reusing 0.75 there would report almost everything as uncovered.
const LEXICAL_BANDS = { covered: 0.5, related: 0.25 } as const;

// Coverage target: a floor everything gets, plus traffic and risk. sqrt on traffic so a topic
// carrying 40% of requests doesn't demand 40% of the test budget. Phase 1 adds the spread term
// (a topic's measured intra-cluster diameter), which needs the clustering this pass doesn't do.
const TARGET_BASE = 2;
const TARGET_K_TRAFFIC = 6;
const TARGET_K_RISK = 3;

// Coverage at or above this counts the topic as covered for the breadth tile.
const COVERED_THRESHOLD = 0.7;

// monitor_classifications carries a traceId but no sessionId, so unique-session counts need the
// one join in this module. It matters: 500 requests from 3 sessions is one customer stuck in a
// retry loop, 500 from 400 sessions is real demand, and weighting a coverage target by raw
// request count would over-invest in the first. A trace with no sessionId (SDK calls that never
// set one) counts as its own session rather than being dropped - it IS a distinct interaction.
async function sessionsByTraceId(db: Db, traceIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (traceIds.length === 0) {
    return map;
  }
  // Chunked: a 30-day window can hold far more classified traces than SQLite's bound-parameter
  // limit (999 on the builds this ships against), and a single inArray of every id would throw
  // rather than degrade - on the busiest installs, which are exactly the ones this feature is for.
  const CHUNK = 400;
  for (let start = 0; start < traceIds.length; start += CHUNK) {
    const chunk = traceIds.slice(start, start + CHUNK);
    const cond = and(eq(db.schema.traces.projectId, db.projectId), inArray(db.schema.traces.id, chunk));
    const rows = (
      db.kind === "sqlite"
        ? db.db.select({ id: db.schema.traces.id, sessionId: db.schema.traces.sessionId }).from(db.schema.traces).where(cond).all()
        : await db.db.select({ id: db.schema.traces.id, sessionId: db.schema.traces.sessionId }).from(db.schema.traces).where(cond)
    ) as { id: string; sessionId: string | null }[];
    for (const row of rows) {
      if (row.sessionId) {
        map.set(row.id, row.sessionId);
      }
    }
  }
  return map;
}

export type TopicGroup = {
  topic: string;
  /** Other intent labels merged into this topic - see mergeSynonymousTopics. */
  aliases: string[];
  rows: ClassificationRow[];
  embeddings: number[][];
  centroid: number[] | null;
  words: Set<string>;
};

// Merge two intent labels into one topic when their trace centroids are this close.
//
// Calibrated against real classified traffic, and deliberately NOT curation.ts's 0.75: that one
// compares two single query strings, this compares centroids of averaged input+output embeddings,
// which run considerably higher. Measured on a real install:
//
//   0.909  "refund request"        vs "request a refund"          <- the same topic, must merge
//   0.902  "reset password"        vs "reset forgotten password"  <- the same topic, must merge
//   0.822  "order tracking"        vs "missing package"           <- DIFFERENT, must not merge
//   0.813  "refund policy inquiry" vs "request a refund"          <- DIFFERENT (rules vs money back)
//
// 0.87 splits those populations with ~0.05 of margin on both sides. Reusing 0.75 here would have
// merged order tracking with missing package, which are genuinely different questions with
// genuinely different correct answers. Recalibrate if the embedding model changes.
const TOPIC_MERGE_THRESHOLD = 0.87;

// Group by normalized intent, keep the most common original casing as the display label. The
// classifier is already steered toward reusing labels verbatim (see topics.ts's
// existingIntentsBlock), so this only has to absorb the casing/whitespace drift that steering
// doesn't cover - it is not a substitute for the Phase 1 clustering.
export function groupByIntent(rows: ClassificationRow[]): TopicGroup[] {
  type Bucket = { labels: Map<string, number>; rows: ClassificationRow[] };
  const byKey = new Map<string, Bucket>();
  for (const row of rows) {
    const key = normalizeText(row.intent);
    if (!key) {
      continue;
    }
    const entry: Bucket = byKey.get(key) ?? { labels: new Map<string, number>(), rows: [] };
    entry.labels.set(row.intent, (entry.labels.get(row.intent) ?? 0) + 1);
    entry.rows.push(row);
    byKey.set(key, entry);
  }
  const groups = Array.from(byKey.values()).map(entry => {
    const label = Array.from(entry.labels.entries()).sort((a, b) => b[1] - a[1])[0]![0];
    const embeddings = entry.rows
      .map(r => r.embedding)
      .filter((e): e is number[] => Array.isArray(e) && e.length > 0);
    return {
      topic: label,
      aliases: [] as string[],
      rows: entry.rows,
      embeddings,
      centroid: centroid(embeddings),
      words: contentWords(label),
    };
  });
  return mergeSynonymousTopics(groups);
}

// The classifier is steered toward reusing existing labels but still coins near-duplicates, and on
// real traffic that is not cosmetic: an install carrying both "refund request" and "request a
// refund" reported one as covered and the other as MISSING, inventing a gap that did not exist and
// splitting one topic's traffic share in half. Merging by centroid proximity is what stops the
// coverage number being an artifact of how the labeller happened to phrase itself that day.
//
// Seeded greedily from the largest group, and every candidate is compared against the SEED's
// centroid rather than the growing one - otherwise a chain of pairwise-similar topics (a~b, b~c)
// collects into one blob even when a and c have nothing to do with each other.
export function mergeSynonymousTopics(groups: TopicGroup[]): TopicGroup[] {
  const bySize = [...groups].sort((a, b) => b.rows.length - a.rows.length);
  const consumed = new Set<TopicGroup>();
  const merged: TopicGroup[] = [];

  for (const seed of bySize) {
    if (consumed.has(seed)) {
      continue;
    }
    consumed.add(seed);
    if (!seed.centroid) {
      merged.push(seed);
      continue;
    }
    for (const candidate of bySize) {
      if (consumed.has(candidate) || !candidate.centroid) {
        continue;
      }
      if (cosine(seed.centroid, candidate.centroid) >= TOPIC_MERGE_THRESHOLD) {
        consumed.add(candidate);
        seed.aliases.push(candidate.topic);
        seed.rows.push(...candidate.rows);
        seed.embeddings.push(...candidate.embeddings);
        for (const word of candidate.words) {
          seed.words.add(word);
        }
      }
    }
    // Recomputed only after absorbing everything, so the comparisons above all ran against the
    // seed's original position. The label stays the seed's - it is the most common one.
    if (seed.aliases.length > 0) {
      seed.centroid = centroid(seed.embeddings) ?? seed.centroid;
    }
    merged.push(seed);
  }
  return merged;
}

type Similarity = {
  kind: "embedding" | "lexical";
  bands: { covered: number; related: number };
  /** Case-to-topic score, used for assignment. */
  toTopic(item: DatasetCase, group: TopicGroup): number;
  /** Case-to-single-trace score, used for the facility-location value. */
  toTrace(item: DatasetCase, row: ClassificationRow): number;
};

function embeddingSimilarity(): Similarity {
  return {
    kind: "embedding",
    bands: SIMILARITY_BANDS,
    toTopic: (item, group) => (item.embedding && group.centroid ? cosine(item.embedding, group.centroid) : -1),
    toTrace: (item, row) =>
      item.embedding && Array.isArray(row.embedding) && row.embedding.length > 0 ? cosine(item.embedding, row.embedding) : -1,
  };
}

function lexicalSimilarity(): Similarity {
  const cache = new Map<string, Set<string>>();
  const words = (item: DatasetCase): Set<string> => {
    let w = cache.get(item.caseKey);
    if (!w) {
      w = contentWords(item.query);
      cache.set(item.caseKey, w);
    }
    return w;
  };
  return {
    kind: "lexical",
    bands: LEXICAL_BANDS,
    toTopic: (item, group) => jaccard(words(item), group.words),
    // No per-trace text is stored on a classification row, so the lexical regime has nothing
    // finer than the topic label to compare against. Coverage therefore degrades to the topic
    // score itself - which is exactly why this path is reported as degraded.
    toTrace: (item, _row) => -1,
  };
}

// Facility-location: the average, over the topic's traces, of the best similarity any assigned
// case achieves to that trace. Duplicated cases add nothing because the max is already satisfied,
// so the metric cannot be inflated by generating near-copies - which matters, because generating
// cases is the point of the feature. Rescaled from the related band up to the covered band so a
// case sitting on a trace reads as 1 and an unrelated one as 0.
function facilityLocation(assigned: DatasetCase[], group: TopicGroup, sim: Similarity): number | null {
  if (assigned.length === 0) {
    return 0;
  }
  const usable = group.rows.filter(row => Array.isArray(row.embedding) && row.embedding.length > 0);
  if (sim.kind !== "embedding" || usable.length === 0) {
    return null;
  }
  const { covered, related } = sim.bands;
  let total = 0;
  for (const row of usable) {
    let best = -1;
    for (const item of assigned) {
      const score = sim.toTrace(item, row);
      if (score > best) {
        best = score;
      }
    }
    total += Math.max(0, Math.min(1, (best - related) / (covered - related)));
  }
  return total / usable.length;
}

function suggestedActionFor(state: CoverageState, topic: string, gap: number): string {
  if (state === "missing") {
    return `No case covers "${topic}". Curate the production traces in this topic, or generate candidate cases grounded in them.`;
  }
  if (state === "underrepresented") {
    return `Add roughly ${gap} more case${gap === 1 ? "" : "s"} for "${topic}", covering phrasings the existing ones don't reach.`;
  }
  return "No new case required; refresh examples when production behavior changes.";
}

export async function getCoverage(
  db: Db,
  options: { window: MonitoringWindow; datasetId?: string }
): Promise<CoverageResult> {
  const { days } = windowConfig(options.window);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await listClassificationsSince(db, since);
  const datasetId = options.datasetId ?? null;

  const allGroups = groupByIntent(rows);
  const groups = allGroups.filter(g => g.rows.length >= MIN_TRACES_PER_TOPIC);
  const cases = await listDatasetCases(db, options.datasetId);
  const { embedded, pending } = await attachCaseEmbeddings(db, cases);

  const anyTraceEmbeddings = groups.some(g => g.embeddings.length > 0);
  const sim = embedded && anyTraceEmbeddings ? embeddingSimilarity() : lexicalSimilarity();
  const degradedReason =
    sim.kind === "embedding"
      ? null
      : !embedded
        ? "No dataset case embeddings are available yet - set OPENAI_API_KEY, or wait for the cache to warm."
        : "No classified trace carries an embedding, so coverage falls back to label matching.";

  if (groups.length === 0) {
    return {
      window: options.window,
      datasetId,
      degraded: sim.kind !== "embedding",
      degradedReason,
      insufficientData: true,
      trafficWeightedCoverage: 0,
      topicBreadth: { covered: 0, total: 0 },
      riskWeightedCoverage: 0,
      presenceCoverage: 0,
      honestyDelta: 0,
      topics: [],
      offMapCases: [],
      caseEmbeddingsPending: pending,
    };
  }

  // Assign each case to its best-matching topic, or to none when nothing clears the related
  // band. Argmax, not the softmax the plan specifies for Phase 1: with intent-string topics
  // there are no real centroid boundaries for a soft assignment to be smoothing over yet.
  const assignments = new Map<string, DatasetCase[]>();
  const offMapCases: CoverageResult["offMapCases"] = [];
  for (const item of cases) {
    let bestGroup: TopicGroup | null = null;
    let bestScore = -1;
    for (const group of groups) {
      const score = sim.toTopic(item, group);
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }
    if (!bestGroup || bestScore < sim.bands.related) {
      // "Off map" has to mean no topic at all, not "no topic big enough to report". A case whose
      // topic exists but sits under MIN_TRACES_PER_TOPIC is covering real (if rare) traffic, and
      // listing it as dead test weight would be telling the user to delete a good test.
      const matchesRareTopic = allGroups.some(group => sim.toTopic(item, group) >= sim.bands.related);
      if (matchesRareTopic) {
        continue;
      }
      offMapCases.push({
        datasetId: item.datasetId,
        index: item.index,
        query: item.query,
        bestSimilarity: Math.round(Math.max(0, bestScore) * 1000) / 1000,
      });
      continue;
    }
    const list = assignments.get(bestGroup.topic) ?? [];
    list.push(item);
    assignments.set(bestGroup.topic, list);
  }

  const totalTraces = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const sessionByTrace = await sessionsByTraceId(
    db,
    rows.map(r => r.traceId).filter((id): id is string => !!id)
  );

  const topics: TopicCoverage[] = groups.map(group => {
    const assigned = assignments.get(group.topic) ?? [];
    const trafficShare = group.rows.length / totalTraces;

    const issues = group.rows.filter(r => r.issueType !== "none").length;
    const negative = group.rows.filter(r => r.sentiment === "negative").length;
    const issueRate = issues / group.rows.length;
    const negativeSentimentRate = negative / group.rows.length;
    // Issues weigh more than sentiment: an issueType is a statement about the response, a
    // negative sentiment is a statement about the user's mood, and only one of those is
    // reliably the agent's fault.
    const risk = Math.min(1, issueRate * 0.7 + negativeSentimentRate * 0.3);

    const targetCases = Math.ceil(TARGET_BASE + TARGET_K_TRAFFIC * Math.sqrt(trafficShare) + TARGET_K_RISK * risk);
    // Coverage is the facility-location value ALONE whenever embeddings allow it - never blended
    // with the case count. Mixing the two would reintroduce exactly what this metric exists to
    // prevent: six near-identical cases raise the count ratio while the max-similarity term is
    // already satisfied, so any formula reading the count would report them as better coverage
    // than one well-placed case. `targetCases` stays a guidance number (how many more to write,
    // and the sizing shown in the panel), and becomes the measure only in the degraded path,
    // where there is no geometry to measure depth with.
    const depth = facilityLocation(assigned, group, sim);
    const coverage = depth === null ? Math.min(1, assigned.length / targetCases) : depth;

    const state: CoverageState =
      assigned.length === 0 ? "missing" : coverage >= COVERED_THRESHOLD ? "covered" : "underrepresented";

    const sessions = new Set(
      group.rows.map(r => (r.traceId ? (sessionByTrace.get(r.traceId) ?? `trace:${r.traceId}`) : null)).filter((id): id is string => !!id)
    );

    return {
      topic: group.topic,
      aliases: group.aliases,
      state,
      trafficShare: Math.round(trafficShare * 1000) / 1000,
      traceCount: group.rows.length,
      uniqueSessions: sessions.size,
      caseCount: assigned.length,
      targetCases,
      coverage: Math.round(coverage * 1000) / 1000,
      risk: Math.round(risk * 1000) / 1000,
      riskComponents: {
        issueRate: Math.round(issueRate * 1000) / 1000,
        negativeSentimentRate: Math.round(negativeSentimentRate * 1000) / 1000,
      },
      suggestedAction: suggestedActionFor(state, group.topic, Math.max(1, targetCases - assigned.length)),
    };
  });

  topics.sort((a, b) => b.trafficShare - a.trafficShare);

  const weighted = (weightOf: (t: TopicCoverage) => number, valueOf: (t: TopicCoverage) => number): number => {
    const totalWeight = topics.reduce((sum, t) => sum + weightOf(t), 0);
    if (totalWeight === 0) {
      return 0;
    }
    return Math.round((topics.reduce((sum, t) => sum + weightOf(t) * valueOf(t), 0) / totalWeight) * 1000) / 1000;
  };

  const trafficWeightedCoverage = weighted(t => t.trafficShare, t => t.coverage);
  // Presence: does the topic have any case at all. The crude number the honesty delta measures
  // the real one against.
  const presenceCoverage = weighted(t => t.trafficShare, t => (t.caseCount > 0 ? 1 : 0));

  return {
    window: options.window,
    datasetId,
    degraded: sim.kind !== "embedding",
    degradedReason,
    insufficientData: false,
    trafficWeightedCoverage,
    topicBreadth: { covered: topics.filter(t => t.coverage >= COVERED_THRESHOLD).length, total: topics.length },
    riskWeightedCoverage: weighted(t => t.risk, t => t.coverage),
    presenceCoverage,
    honestyDelta: Math.round((presenceCoverage - trafficWeightedCoverage) * 1000) / 1000,
    topics,
    offMapCases,
    caseEmbeddingsPending: pending,
  };
}
