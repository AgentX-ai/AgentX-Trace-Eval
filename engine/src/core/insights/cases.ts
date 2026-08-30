import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { computeEmbeddings, embeddingsAvailable } from "../evaluate/judge.js";
import { DEFAULT_EMBEDDING_MODEL } from "@agentx/judge-core";
import { listDatasets } from "../evaluate/datasets.js";
import { normalizeText } from "../shared/vector.js";
import { logger } from "../../log.js";

// The dataset half of Insights: each case's text, with cached embeddings.
//
// TWO embeddings per case, because there are two comparisons and they live in different spaces:
//   embedding     - the query alone. Compared against a user's typed query by the probe.
//   embeddingFull - query + expected result. Compared against TRACE embeddings by coverage, which
//                   monitor/topics.ts builds from input + output.
// Scoring a query-only vector against a query+answer vector is a cross-space comparison: it reads
// systematically low, so cases fall off the map and topics report "missing" that are covered fine.
//
// Only the main question is embedded, never follow-ups - a follow-up is a fragment ("and if it's
// expired?") that would drag its case's assignment somewhere meaningless.

export type DatasetCase = {
  datasetId: string;
  datasetName: string;
  index: number;
  query: string;
  expectedResults: string | null;
  caseKey: string;
  /** Query only - the probe's space. Null when not yet computed. */
  embedding: number[] | null;
  /** Query + expected result - the traces' space. Null when not yet computed. */
  embeddingFull: number[] | null;
};

type QuestionShape = { main_question?: { query?: unknown; expectedResults?: unknown } };

// Hash of the text that was embedded, so editing a case re-embeds it while reordering costs
// nothing - a positional key would get that exactly backwards.
export function caseKeyFor(query: string, expectedResults?: string | null): string {
  return createHash("sha256")
    .update(`${normalizeText(query)} ${normalizeText(expectedResults ?? "")}`)
    .digest("hex")
    .slice(0, 32);
}

// Cases embedded per request. A first call on a large dataset warms part of the cache and reports
// the rest as pending; the next call continues from there.
const MAX_NEW_EMBEDDINGS_PER_REQUEST = 60;

export async function listDatasetCases(db: Db, datasetId?: string): Promise<DatasetCase[]> {
  const datasets = (await listDatasets(db)) as { _id: string; name: string; questions?: unknown }[];
  const wanted = datasetId ? datasets.filter(d => d._id === datasetId) : datasets;
  const cases: DatasetCase[] = [];
  for (const dataset of wanted) {
    const questions = Array.isArray(dataset.questions) ? (dataset.questions as QuestionShape[]) : [];
    questions.forEach((question, index) => {
      const query = typeof question?.main_question?.query === "string" ? question.main_question.query.trim() : "";
      if (!query) {
        return;
      }
      const raw = question.main_question?.expectedResults;
      const expectedResults = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      cases.push({
        datasetId: dataset._id,
        datasetName: dataset.name,
        index,
        query,
        expectedResults,
        caseKey: caseKeyFor(query, expectedResults),
        embedding: null,
        embeddingFull: null,
      });
    });
  }
  return cases;
}

type CacheRow = { datasetId: string; caseKey: string; embedding: unknown; embeddingFull: unknown };

async function readCache(db: Db, datasetIds: string[]): Promise<Map<string, CacheRow>> {
  const byKey = new Map<string, CacheRow>();
  if (datasetIds.length === 0) {
    return byKey;
  }
  const cond = and(
    eq(db.schema.insightCaseEmbeddings.projectId, db.projectId),
    inArray(db.schema.insightCaseEmbeddings.datasetId, datasetIds)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.insightCaseEmbeddings).where(cond).all()
      : await db.db.select().from(db.schema.insightCaseEmbeddings).where(cond)
  ) as CacheRow[];
  for (const row of rows) {
    byKey.set(`${row.datasetId}:${row.caseKey}`, row);
  }
  return byKey;
}

async function writeCache(
  db: Db,
  entry: { datasetId: string; caseKey: string; query: string; embedding: number[]; embeddingFull: number[] }
): Promise<void> {
  try {
    const row = {
      id: nanoid(),
      projectId: db.projectId,
      datasetId: entry.datasetId,
      caseKey: entry.caseKey,
      query: entry.query,
      embedding: entry.embedding,
      embeddingFull: entry.embeddingFull,
      model: DEFAULT_EMBEDDING_MODEL,
      createdAt: new Date(),
    };
    if (db.kind === "sqlite") {
      db.db.insert(db.schema.insightCaseEmbeddings).values(row).run();
    } else {
      await db.db.insert(db.schema.insightCaseEmbeddings).values(row);
    }
  } catch (err) {
    // The unique index did its job: a concurrent poll embedded the same case, to the same value.
    logger.debug({ err: err instanceof Error ? err.message : err }, "Insight case embedding already cached");
  }
}

export type CaseEmbeddingResult = {
  cases: DatasetCase[];
  /** At least one case carries usable vectors, so cosine scoring is meaningful. */
  embedded: boolean;
  /** Cases still unembedded when this returned - cap hit, no key, or a failed call. */
  pending: number;
};

// Never caches a null. A failed call and a missing key are indistinguishable at the embedder's
// boundary, and caching that as permanent would exclude those cases forever - adding a key later
// would not recover them. Instead the no-key case short-circuits before any call, so nothing
// retries in a doomed loop, and a real failure just stays pending until next time.
export async function attachCaseEmbeddings(db: Db, cases: DatasetCase[]): Promise<CaseEmbeddingResult> {
  const datasetIds = Array.from(new Set(cases.map(c => c.datasetId)));
  const cache = await readCache(db, datasetIds);
  const canEmbed = cases.length > 0 && (await embeddingsAvailable());

  const uncached: DatasetCase[] = [];
  for (const item of cases) {
    const cached = cache.get(`${item.datasetId}:${item.caseKey}`);
    if (cached) {
      item.embedding = Array.isArray(cached.embedding) ? (cached.embedding as number[]) : null;
      item.embeddingFull = Array.isArray(cached.embeddingFull) ? (cached.embeddingFull as number[]) : null;
    } else if (canEmbed && uncached.length < MAX_NEW_EMBEDDINGS_PER_REQUEST) {
      uncached.push(item);
    }
  }

  if (uncached.length > 0) {
    // Every text this request needs, gathered before anything is sent, so the whole cold batch is
    // one or two API calls instead of two per case in sequence. Identical texts share a slot: a
    // case with no expected result has query and full text the same, and that is the common shape.
    const texts: string[] = [];
    const slotOf = new Map<string, number>();
    const slot = (text: string): number => {
      const existing = slotOf.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const next = texts.push(text) - 1;
      slotOf.set(text, next);
      return next;
    };
    const wanted = uncached.map(item => ({
      item,
      query: slot(item.query),
      full: slot(item.expectedResults ? `${item.query}\n\n${item.expectedResults}` : item.query),
    }));

    const vectors = await computeEmbeddings(texts);
    for (const entry of wanted) {
      const query = vectors[entry.query];
      const full = vectors[entry.full];
      // Both or neither: a case with one usable vector is scoreable in one space and silently
      // absent from the other, which reads as a coverage gap that isn't one.
      if (query && full) {
        entry.item.embedding = query;
        entry.item.embeddingFull = full;
        await writeCache(db, {
          datasetId: entry.item.datasetId,
          caseKey: entry.item.caseKey,
          query: entry.item.query,
          embedding: query,
          embeddingFull: full,
        });
      }
    }
  }

  let embedded = false;
  let pending = 0;
  for (const item of cases) {
    if (item.embedding && item.embeddingFull) {
      embedded = true;
    } else {
      pending++;
    }
  }
  return { cases, embedded, pending };
}
