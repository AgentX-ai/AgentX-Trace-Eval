import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listClassificationsSince, windowConfig, type ClassificationRow } from "../monitor/topics.js";
import type { MonitoringWindow } from "../monitor/events.js";
import { SIMILARITY_BANDS } from "../evaluate/curation.js";
import { centroid, contentWords, cosine, jaccard, normalizeText } from "../shared/vector.js";
import { listDatasetCases, attachCaseEmbeddings, type DatasetCase } from "./cases.js";

// The join between what production does (monitor_classifications) and what the datasets test.
// Derived on read: there is no insight_topics table, and topics are the classifier's own `intent`
// strings, normalized and merged by centroid proximity.
//
// Two similarity regimes, one code path: cosine with the bands curation.ts calibrated, or - with
// no embeddings - Jaccard over content words, which is weaker and on a different scale, so it
// carries its own thresholds and every response says `degraded: true`.

export type CoverageState = "covered" | "underrepresented" | "missing";

export type TopicCoverage = {
  topic: string;
  /** Which measure produced `coverage` - the global `degraded` flag can't answer this per topic. */
  coverageBasis: "depth" | "count";
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
  /**
   * What closing this gap is worth. Sorting the map by traffic alone makes a reader do the
   * traffic-vs-risk arithmetic themselves, which is the arithmetic the whole feature exists to
   * do for them - so risk is weighted heavily enough here that a dangerous, rarely-asked topic
   * can outrank a common, harmless one.
   */
  priority: number;
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
  /** Null when no topic carries any observed risk - 0% would read as "nothing is tested". */
  riskWeightedCoverage: number | null;
  /** The same traffic-weighted number computed on case presence alone - see honestyDelta. */
  presenceCoverage: number;
  /**
   * presenceCoverage - trafficWeightedCoverage. A large gap means the dataset has rows where it
   * does not have depth, which is the difference between "write new cases" and "deepen the ones
   * you have" - two different afternoons of work that no single percentage distinguishes.
   */
  honestyDelta: number;
  /**
   * The datasets this number was computed over. Without it a project-wide figure silently mixes
   * every dataset in the project - on a real install, 54 of them - and nobody can tell whether a
   * gap belongs to the suite they care about. Also drives the dashboard's dataset filter.
   */
  datasets: { id: string; name: string; caseCount: number }[];
  topics: TopicCoverage[];
  /** Cases matching no topic: either dead test weight, or a topic the classifier hasn't seen. */
  offMapCases: { datasetId: string; index: number; query: string; bestSimilarity: number }[];
  caseEmbeddingsPending: number;
};

// Below this, one stray classification becomes a "missing topic" with a target and an action -
// noise dressed as a work item. Same guard as getTopicsMap's MIN_POINTS_FOR_MAP.
export const MIN_TRACES_PER_TOPIC = 2;

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

// 500 requests from 3 sessions is one customer in a retry loop; 500 from 400 is real demand, and
// sizing a target off raw request count would over-invest in the first. A trace with no sessionId
// counts as its own session - it is still a distinct interaction.
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

// Deliberately not curation.ts's 0.75: that compares two query strings, this compares centroids of
// averaged input+output embeddings, which run higher. Measured on a real install - synonyms at
// 0.909/0.902 ("refund request"/"request a refund", "reset password"/"reset forgotten password")
// against distinct neighbours at 0.822/0.813 ("order tracking"/"missing package", "refund policy
// inquiry"/"request a refund"). 0.87 splits them with ~0.05 either side; 0.75 would have merged
// questions with different correct answers. Recalibrate if the embedding model changes.
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

// On real traffic an install carrying both "refund request" and "request a refund" reported one
// covered and the other MISSING - one topic counted twice, half of it a phantom gap. Merging by
// centroid stops coverage being an artifact of how the labeller phrased itself that day.
//
// Greedy from the largest group; candidates compare against the SEED's centroid, not the growing
// one, so a chain (a~b, b~c) cannot collect into one blob when a and c are unrelated.
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
        for (const row of candidate.rows) {
          seed.rows.push(row);
        }
        for (const embedding of candidate.embeddings) {
          seed.embeddings.push(embedding);
        }
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
    // embeddingFull, not embedding: topic centroids and trace vectors are built from input+output,
    // so the query-only vector would be a cross-space comparison and score systematically low.
    toTopic: (item, group) => (item.embeddingFull && group.centroid ? cosine(item.embeddingFull, group.centroid) : -1),
    toTrace: (item, row) =>
      item.embeddingFull && Array.isArray(row.embedding) && row.embedding.length > 0
        ? cosine(item.embeddingFull, row.embedding)
        : -1,
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

// Facility-location: the average, over a topic's traces, of the best similarity any assigned case
// reaches. A duplicate adds nothing because the max is already satisfied, so the metric cannot be
// inflated by generating near-copies - which matters, since generating cases is the point.
// Rescaled across the related..covered band so a case on top of a trace reads 1, an unrelated 0.
function facilityLocation(assigned: DatasetCase[], group: TopicGroup, sim: Similarity): number | null {
  const usable = group.rows.filter(row => Array.isArray(row.embedding) && row.embedding.length > 0);
  // Regime checked BEFORE the empty-case shortcut: an uncovered topic scores 0 either way, but
  // returning a number here would label it "depth" on a run that measured no depth at all.
  if (sim.kind !== "embedding" || usable.length === 0) {
    return null;
  }
  if (assigned.length === 0) {
    return 0;
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

function suggestedActionFor(state: CoverageState, topic: string, gap: number, pending: number): string {
  if (state === "missing") {
    // Unembedded cases count toward no topic, so a topic can read "missing" while cases for it sit
    // in the queue. Telling someone to write a case that already exists is worse than saying
    // nothing, so the advice waits until there is nothing left to index.
    return pending > 0
      ? `No case is assigned to "${topic}" yet, but ${pending} case${pending === 1 ? " is" : "s are"} still being indexed - this may resolve on its own.`
      : `No case covers "${topic}". Curate the production traces in this topic, or generate candidate cases grounded in them.`;
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

  const datasetCounts = new Map<string, { id: string; name: string; caseCount: number }>();
  for (const item of cases) {
    const entry = datasetCounts.get(item.datasetId) ?? { id: item.datasetId, name: item.datasetName, caseCount: 0 };
    entry.caseCount++;
    datasetCounts.set(item.datasetId, entry);
  }
  const datasets = Array.from(datasetCounts.values()).sort((a, b) => b.caseCount - a.caseCount);

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
      riskWeightedCoverage: null,
      presenceCoverage: 0,
      honestyDelta: 0,
      datasets,
      topics: [],
      offMapCases: [],
      caseEmbeddingsPending: pending,
    };
  }

  // Argmax, not softmax: with intent-string topics there are no real centroid boundaries for a
  // soft assignment to smooth over yet.
  const assignments = new Map<string, DatasetCase[]>();
  const offMapCases: CoverageResult["offMapCases"] = [];
  for (const item of cases) {
    // An unembedded case (cap not yet reached, or a failed call) scores -1 against everything.
    // Calling that "off map" would flag a good test as dead weight on first load; it is pending,
    // and `caseEmbeddingsPending` already reports it.
    if (sim.kind === "embedding" && !item.embeddingFull) {
      continue;
    }
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
      // Off-map is only a real finding under embeddings. Lexical matching compares a case's words
      // against a topic LABEL, which most legitimate cases do not overlap - on real data that
      // produced 84 "dead test weight" entries that were nothing of the sort.
      if (sim.kind !== "embedding") {
        continue;
      }
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

  type RawTopic = { trafficShare: number; coverage: number; risk: number; caseCount: number };
  const raw: RawTopic[] = [];

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
    // Facility-location ALONE where geometry exists - never blended with the count, which would
    // reintroduce the duplicate-inflation this metric exists to prevent. targetCases stays
    // guidance, and becomes the measure only where there is no geometry.
    // facilityLocation returns null for a topic whose traces carry no embeddings, even when the
    // run as a whole is using them - so the basis is recorded per topic rather than inferred from
    // the global flag, which would claim depth over a count.
    const depth = facilityLocation(assigned, group, sim);
    const coverage = depth === null ? Math.min(1, assigned.length / targetCases) : depth;

    // Risk AMPLIFIES exposure rather than substituting for it. Adding the two instead would give
    // a 0.1%-of-traffic topic with high risk a bigger number than a 20%-of-traffic one, which is
    // not a queue anybody should work: a topic nobody asks is worth nothing to test however
    // dangerous it sounds. Multiplying keeps that at zero, while the 3x lets a failing topic
    // outrank a healthy one carrying up to four times its traffic. (1 - coverage) so a covered
    // topic is worth nothing to work on, however busy.
    const priority = (1 - coverage) * trafficShare * (1 + 3 * risk);

    const state: CoverageState =
      assigned.length === 0 ? "missing" : coverage >= COVERED_THRESHOLD ? "covered" : "underrepresented";

    raw.push({ trafficShare, coverage, risk, caseCount: assigned.length });

    const sessions = new Set(
      group.rows.map(r => (r.traceId ? (sessionByTrace.get(r.traceId) ?? `trace:${r.traceId}`) : null)).filter((id): id is string => !!id)
    );

    return {
      topic: group.topic,
      coverageBasis: depth === null ? "count" : "depth",
      aliases: group.aliases,
      state,
      trafficShare: Math.round(trafficShare * 1000) / 1000,
      traceCount: group.rows.length,
      uniqueSessions: sessions.size,
      caseCount: assigned.length,
      targetCases,
      coverage: Math.round(coverage * 1000) / 1000,
      risk: Math.round(risk * 1000) / 1000,
      priority: Math.round(priority * 10000) / 10000,
      riskComponents: {
        issueRate: Math.round(issueRate * 1000) / 1000,
        negativeSentimentRate: Math.round(negativeSentimentRate * 1000) / 1000,
      },
      suggestedAction: suggestedActionFor(state, group.topic, Math.max(1, targetCases - assigned.length), pending),
    };
  });

  topics.sort((a, b) => b.trafficShare - a.trafficShare);

  // Weights and values come from `raw`, not the rounded fields on TopicCoverage. Rounding to 3dp
  // is for display; feeding it back into the maths drops any topic under 0.0005 of traffic to a
  // weight of exactly zero, so on a busy install the long tail silently stops counting.
  const weighted = (weightOf: (t: RawTopic) => number, valueOf: (t: RawTopic) => number): number => {
    const totalWeight = raw.reduce((sum, t) => sum + weightOf(t), 0);
    if (totalWeight === 0) {
      return 0;
    }
    return Math.round((raw.reduce((sum, t) => sum + weightOf(t) * valueOf(t), 0) / totalWeight) * 1000) / 1000;
  };

  const trafficWeightedCoverage = weighted(t => t.trafficShare, t => t.coverage);
  // A healthy install has zero risk everywhere, and `weighted` returns 0 for a zero denominator -
  // which would render as 0% risk-weighted coverage, indistinguishable from testing nothing.
  const totalRisk = raw.reduce((sum, t) => sum + t.risk, 0);
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
    topicBreadth: { covered: raw.filter(t => t.coverage >= COVERED_THRESHOLD).length, total: raw.length },
    riskWeightedCoverage: totalRisk === 0 ? null : weighted(t => t.risk, t => t.coverage),
    presenceCoverage,
    honestyDelta: Math.round((presenceCoverage - trafficWeightedCoverage) * 1000) / 1000,
    datasets,
    topics,
    offMapCases,
    caseEmbeddingsPending: pending,
  };
}
