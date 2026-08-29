import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { computeEmbedding } from "../evaluate/judge.js";
import { DEFAULT_EMBEDDING_MODEL } from "@agentx/judge-core";
import { listDatasets } from "../evaluate/datasets.js";
import { normalizeText } from "../shared/vector.js";
import { logger } from "../../log.js";

// The dataset half of Insights: pull every case's question text out of the datasets' `questions`
// JSON and give each one a cached embedding, so coverage (coverage.ts) and the probe (probe.ts)
// can compare cases against production traffic in one vector space.
//
// Only the MAIN question is embedded, not follow-ups. A follow-up only makes sense as the second
// turn of its own case - on its own it is usually a fragment ("and if it's expired?") that would
// land nowhere near any topic and drag the case's assignment with it. The case is represented by
// the thing a user would actually walk in and ask.

export type DatasetCase = {
  datasetId: string;
  datasetName: string;
  // Index into the dataset's `questions` array - the address the dashboard needs to link to it.
  index: number;
  query: string;
  expectedResults: string | null;
  // sha256 of the normalized query: stable across reordering, changes when the text is edited.
  caseKey: string;
  embedding: number[] | null;
};

type QuestionShape = {
  main_question?: { query?: unknown; expectedResults?: unknown };
};

export function caseKeyFor(query: string): string {
  return createHash("sha256").update(normalizeText(query)).digest("hex").slice(0, 32);
}

// New embeddings computed in a single request. A first call on a large dataset warms part of the
// cache and reports `degraded` for the rest; the next call picks up where this one stopped. That
// is deliberately preferable to either blocking a dashboard load on 400 sequential embedding
// calls or silently reporting a coverage number computed from a third of the dataset.
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
      const expected = question.main_question?.expectedResults;
      cases.push({
        datasetId: dataset._id,
        datasetName: dataset.name,
        index,
        query,
        expectedResults: typeof expected === "string" && expected.trim() ? expected.trim() : null,
        caseKey: caseKeyFor(query),
        embedding: null,
      });
    });
  }
  return cases;
}

type CacheRow = { datasetId: string; caseKey: string; embedding: unknown };

async function readCache(db: Db, datasetIds: string[]): Promise<Map<string, number[] | null>> {
  const byKey = new Map<string, number[] | null>();
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
    // A cached NULL is a remembered failure, and must stay distinct from "not cached yet" - it is
    // the whole reason a missing OPENAI_API_KEY doesn't re-attempt an embedding per case per
    // request forever. Map.has() separates the two; a bare get() would not.
    byKey.set(`${row.datasetId}:${row.caseKey}`, Array.isArray(row.embedding) ? (row.embedding as number[]) : null);
  }
  return byKey;
}

async function writeCache(
  db: Db,
  entry: { datasetId: string; caseKey: string; query: string; embedding: number[] | null }
): Promise<void> {
  const row = {
    id: nanoid(),
    projectId: db.projectId,
    datasetId: entry.datasetId,
    caseKey: entry.caseKey,
    query: entry.query,
    embedding: entry.embedding,
    model: entry.embedding ? DEFAULT_EMBEDDING_MODEL : null,
    createdAt: new Date(),
  };
  try {
    if (db.kind === "sqlite") {
      db.db.insert(db.schema.insightCaseEmbeddings).values(row).run();
    } else {
      await db.db.insert(db.schema.insightCaseEmbeddings).values(row);
    }
  } catch (err) {
    // The unique index on (project_id, dataset_id, case_key) is doing its job: two concurrent
    // dashboard polls raced to embed the same case. The other one won and the value is identical,
    // so there is nothing to repair.
    logger.debug({ err: err instanceof Error ? err.message : err }, "Insight case embedding already cached");
  }
}

export type CaseEmbeddingResult = {
  cases: DatasetCase[];
  /** True when at least one case has a usable embedding - i.e. cosine coverage is meaningful. */
  embedded: boolean;
  /** Cases still without an embedding when this call returned (cap hit, or no LLM key). */
  pending: number;
};

// Fills in `embedding` on the given cases, reading the cache first and computing at most
// MAX_NEW_EMBEDDINGS_PER_REQUEST new ones. Never throws: an embedding failure is recorded as a
// cached null and the caller degrades to the lexical fallback, exactly as every other embedding
// path in this repo does.
export async function attachCaseEmbeddings(db: Db, cases: DatasetCase[]): Promise<CaseEmbeddingResult> {
  const datasetIds = Array.from(new Set(cases.map(c => c.datasetId)));
  const cache = await readCache(db, datasetIds);
  let budget = MAX_NEW_EMBEDDINGS_PER_REQUEST;
  let embedded = false;
  let pending = 0;

  for (const item of cases) {
    const key = `${item.datasetId}:${item.caseKey}`;
    if (cache.has(key)) {
      item.embedding = cache.get(key) ?? null;
    } else if (budget > 0) {
      budget--;
      item.embedding = await computeEmbedding(item.query);
      await writeCache(db, { datasetId: item.datasetId, caseKey: item.caseKey, query: item.query, embedding: item.embedding });
      cache.set(key, item.embedding);
    }
    if (item.embedding) {
      embedded = true;
    } else {
      pending++;
    }
  }
  return { cases, embedded, pending };
}
