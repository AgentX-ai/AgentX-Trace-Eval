import { UMAP } from "umap-js";
import type { Db } from "../../storage/db.js";
import { resolveRange, type MonitoringRange, type MonitoringWindow } from "../monitor/events.js";
import { listClassificationsSince, type ClassificationRow } from "../monitor/topics.js";
import { listDatasetRows, listDatasetCases, attachCaseEmbeddings, type DatasetCase } from "./cases.js";
import { traceStoreFor } from "../trace/store/index.js";
import { computeEmbeddings } from "../evaluate/judge.js";
import { and, eq } from "drizzle-orm";
import { groupByIntent, embeddingSimilarity, MIN_TRACES_PER_TOPIC, type TopicGroup } from "./coverage.js";

// The coverage MAP: production traces and dataset cases projected into ONE picture, so "does my
// suite cover what production actually asks" is visible as overlapping clouds rather than only a
// table of numbers.
//
// The projection runs in QUESTION space: a trace's input-only embedding against a case's
// query-only embedding, so an identical question from both sources lands in the same spot. The
// interaction space coverage matches topics in (input+output vs query+expected) is the wrong
// geometry for this picture - it separates identical questions whenever the actual answer
// differs from the expected one, which is exactly when a reader would call the map broken.
// Historical classification rows predate the input-only column, so a bounded batch is embedded
// lazily per request and persisted; the remainder is reported as traceEmbeddingsPending.
//
// One JOINT UMAP fit, one endpoint: coordinates from two separate fits are not comparable, so
// the production-only topics map cannot simply be overlaid with a second one.

// Same caps/floors as the topics map (topics.ts): below the floor UMAP draws an arbitrary shape,
// and the per-source cap keeps a long-running install's request bounded.
const MAX_POINTS_PER_SOURCE = 300;
const MIN_POINTS_FOR_MAP = 10;
// Historical rows lacking input_embedding, embedded per map request - bounded like the case
// cache's own warming so one request never turns into hundreds of embedding calls.
const MAX_TRACE_BACKFILL_PER_REQUEST = 100;

export type CoverageMapPoint = {
  x: number;
  y: number;
  source: "production" | "dataset";
  // The classification intent (production) or the coverage-matched topic (dataset);
  // "unmatched" for a case no topic claimed.
  topic: string;
  query: string;
  traceId?: string | null;
  datasetId?: string;
  caseIndex?: number;
};

export type CoverageMapTopic = { topic: string; productionCount: number; datasetCount: number };

export type CoverageMapResult = {
  window: MonitoringWindow | "custom";
  datasetIds: string[];
  insufficientData: boolean;
  degradedReason: string | null;
  // Cases not yet embedded (cache warming) - absent from the map, reported so the UI can say so.
  caseEmbeddingsPending: number;
  // Historical traces whose question-space embedding is still backfilling - same treatment.
  traceEmbeddingsPending: number;
  points: CoverageMapPoint[];
  topics: CoverageMapTopic[];
};

export async function getCoverageMap(
  db: Db,
  options: { window: MonitoringRange; datasetIds?: string[] }
): Promise<CoverageMapResult> {
  const { sinceMs, untilMs, windowLabel } = resolveRange(options.window);
  const datasetIds = options.datasetIds ?? [];
  const empty = (degradedReason: string | null, pending = 0, tracePending = 0): CoverageMapResult => ({
    window: windowLabel,
    datasetIds,
    insufficientData: true,
    degradedReason,
    caseEmbeddingsPending: pending,
    traceEmbeddingsPending: tracePending,
    points: [],
    topics: [],
  });

  const allRows = await listClassificationsSince(db, new Date(sinceMs), new Date(untilMs));
  const candidates = allRows
    .filter(r => r.traceId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_POINTS_PER_SOURCE);

  // Question-space vectors: input_embedding when stored, else a bounded lazy backfill embedding
  // the trace's input text now and persisting it for every later request.
  const traceTexts = await traceStoreFor(db).getByIds(
    candidates.map(r => r.traceId).filter((id): id is string => !!id)
  );
  const inputTextOf = (row: ClassificationRow): string => {
    const input = row.traceId ? traceTexts.get(row.traceId)?.input : undefined;
    if (typeof input === "string") return input;
    if (input && typeof input === "object" && typeof (input as { query?: unknown }).query === "string") {
      return (input as { query: string }).query;
    }
    return input ? JSON.stringify(input) : "";
  };

  const missing = candidates
    .filter(r => !Array.isArray(r.inputEmbedding) || r.inputEmbedding.length === 0)
    .filter(r => inputTextOf(r).trim().length > 0)
    .slice(0, MAX_TRACE_BACKFILL_PER_REQUEST);
  if (missing.length > 0) {
    const vectors = await computeEmbeddings(missing.map(r => inputTextOf(r)));
    for (let i = 0; i < missing.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      missing[i]!.inputEmbedding = vector;
      const cond = and(
        eq(db.schema.monitorClassifications.id, missing[i]!.id),
        eq(db.schema.monitorClassifications.projectId, db.projectId)
      );
      if (db.kind === "sqlite") {
        db.db.update(db.schema.monitorClassifications).set({ inputEmbedding: vector }).where(cond).run();
      } else {
        await db.db.update(db.schema.monitorClassifications).set({ inputEmbedding: vector }).where(cond);
      }
    }
  }

  const traceRows = candidates.filter(
    (r): r is ClassificationRow & { inputEmbedding: number[] } =>
      Array.isArray(r.inputEmbedding) && r.inputEmbedding.length > 0
  );
  const tracePending = candidates.length - traceRows.length;

  const datasetRows = await listDatasetRows(db);
  const cases = await listDatasetCases(db, options.datasetIds, datasetRows);
  const { pending } = await attachCaseEmbeddings(db, cases);
  // Query-only embeddings - the same question space the trace side projects in.
  const embeddedCases = cases
    .filter((c): c is DatasetCase & { embedding: number[] } => Array.isArray(c.embedding))
    .slice(0, MAX_POINTS_PER_SOURCE);

  // Unlike the coverage table, the map has no lexical fallback - positions ARE similarities, and
  // there is no honest place to draw a point whose similarity was never measured.
  if (traceRows.length === 0) {
    return empty("No classified production traffic carries an embedding in this window.", pending, tracePending);
  }
  if (embeddedCases.length === 0) {
    return empty(
      cases.length === 0
        ? "No dataset cases to place yet."
        : "No dataset case embeddings are available yet - set OPENAI_API_KEY, or wait for the cache to warm.",
      pending,
      tracePending
    );
  }
  if (traceRows.length + embeddedCases.length < MIN_POINTS_FOR_MAP) {
    return empty(null, pending, tracePending);
  }

  // Topic assignment for dataset points reuses the coverage table's exact matcher (bands and
  // all), so a case never reads as covered here and off-map there.
  const groups: TopicGroup[] = groupByIntent(allRows).filter(g => g.rows.length >= MIN_TRACES_PER_TOPIC);
  const sim = embeddingSimilarity();
  const topicOf = (item: DatasetCase): string => {
    let bestTopic: string | null = null;
    let bestMargin = -1;
    let bestScore = -1;
    let matched = false;
    for (const group of groups) {
      const match = sim.toTopic(item, group);
      if (match.margin > bestMargin || (match.margin === bestMargin && match.score > bestScore)) {
        bestMargin = match.margin;
        bestScore = match.score;
        bestTopic = group.topic;
        matched = match.matched;
      }
    }
    return matched && bestTopic ? bestTopic : "unmatched";
  };

  const vectors = [...traceRows.map(r => r.inputEmbedding), ...embeddedCases.map(c => c.embedding)];
  const nNeighbors = Math.min(15, vectors.length - 1);
  const projected = new UMAP({ nComponents: 2, nNeighbors }).fit(vectors);

  const points: CoverageMapPoint[] = [
    ...traceRows.map((row, i) => ({
      x: projected[i]![0]!,
      y: projected[i]![1]!,
      source: "production" as const,
      topic: row.intent,
      query: inputTextOf(row).slice(0, 140),
      traceId: row.traceId,
    })),
    ...embeddedCases.map((item, i) => ({
      x: projected[traceRows.length + i]![0]!,
      y: projected[traceRows.length + i]![1]!,
      source: "dataset" as const,
      topic: topicOf(item),
      query: item.query,
      datasetId: item.datasetId,
      caseIndex: item.index,
    })),
  ];

  const byTopic = new Map<string, CoverageMapTopic>();
  for (const point of points) {
    const entry = byTopic.get(point.topic) ?? { topic: point.topic, productionCount: 0, datasetCount: 0 };
    if (point.source === "production") entry.productionCount++;
    else entry.datasetCount++;
    byTopic.set(point.topic, entry);
  }
  const topics = [...byTopic.values()].sort(
    (a, b) => b.productionCount - a.productionCount || b.datasetCount - a.datasetCount
  );

  return {
    window: windowLabel,
    datasetIds,
    insufficientData: false,
    degradedReason: null,
    caseEmbeddingsPending: pending,
    traceEmbeddingsPending: tracePending,
    points,
    topics,
  };
}
