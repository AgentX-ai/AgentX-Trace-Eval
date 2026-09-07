import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import { getCoverageMap } from "../core/insights/coverageMap.js";
import { createDataset } from "../core/evaluate/datasets.js";
import { caseKeyFor } from "../core/insights/cases.js";

// Postgres twin for the one dialect-branched WRITE in the coverage-map path: the lazy
// question-space backfill (coverageMap.ts persists input_embedding with a per-dialect UPDATE).
// The sqlite branch is covered by insights.integration.test.ts; openTestDb allows one database
// per worker, which is why this lives in its own file. Opt-in via AGENTX_TEST_DB_URL like every
// other Postgres suite.

const { registered } = vi.hoisted(() => ({ registered: new Map<string, number[]>() }));

vi.mock("../core/evaluate/judge.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../core/evaluate/judge.js")>();
  const one = (text: string): number[] | null => registered.get(text.trim()) ?? null;
  return {
    ...actual,
    embeddingsAvailable: async () => true,
    computeEmbedding: async (text: string) => one(text),
    computeEmbeddings: async (texts: string[]) => texts.map(one),
  };
});

const unit = (angle: number): number[] => [Math.cos(angle), Math.sin(angle), 0, 0];

// Same narrowing trick as insights.integration.test.ts's insertRow: the sqlite/pg handle union
// isn't callable until db.kind narrows it, even though both branches are the same statement.
async function insertRow(handle: Db, table: unknown, values: Record<string, unknown>): Promise<void> {
  if (handle.kind === "sqlite") {
    await handle.db.insert(table as Parameters<typeof handle.db.insert>[0]).values(values as never);
  } else {
    await handle.db.insert(table as Parameters<typeof handle.db.insert>[0]).values(values as never);
  }
}

let test: TestDb;
let db: Db;

async function classify(opts: { intent: string; input: string; embedded: boolean }): Promise<void> {
  const traceId = nanoid();
  await insertRow(db, db.schema.traces, {
    id: traceId,
    name: "insights-agent",
    input: opts.input,
    output: "a",
    projectId: db.projectId,
    createdAt: new Date(),
  });
  await insertRow(db, db.schema.monitorClassifications, {
    id: nanoid(),
    traceId,
    agentId: null,
    intent: opts.intent,
    sentiment: "neutral",
    issueType: "none",
    createdAt: new Date(),
    projectId: db.projectId,
    embedding: unit(0),
    inputEmbedding: opts.embedded ? unit(0) : null,
  });
}

describe.skipIf(!process.env.AGENTX_TEST_DB_URL)("coverage map on Postgres", () => {
  beforeAll(async () => {
    test = await openTestDb({ postgres: true });
    db = test.scoped(await test.newProject("MapPg"));
  }, 60_000);

  afterAll(async () => {
    await test?.close();
  });

  it("lazily backfills input_embedding through the pg branch and reads it back on the next call", async () => {
    for (let i = 0; i < 6; i++) {
      await classify({ intent: "refund request", input: "I want a refund", embedded: true });
    }
    // Historical rows: classified before the question-space column existed (inputEmbedding
    // null), but their input text embeds - exactly what the lazy backfill is for.
    const legacyTexts = ["legacy q 0", "legacy q 1", "legacy q 2"];
    for (const text of legacyTexts) {
      registered.set(text, unit(0.3));
      await classify({ intent: "refund request", input: text, embedded: false });
    }

    const query = "I want a refund";
    const dataset = await createDataset(db, {
      name: "map-pg-ds",
      questions: [{ main_question: { query, expectedResults: `expected for ${query}` }, follow_up_questions: [] }],
    });
    const datasetId = (dataset as { _id: string })._id;
    await insertRow(db, db.schema.insightCaseEmbeddings, {
      id: nanoid(),
      projectId: db.projectId,
      datasetId,
      caseKey: caseKeyFor(query, `expected for ${query}`),
      query,
      embedding: unit(0),
      embeddingFull: unit(0),
      model: "test-injected",
      createdAt: new Date(),
    });

    const first = await getCoverageMap(db, { window: "7d", datasetIds: [datasetId] });
    expect(first.insufficientData).toBe(false);
    expect(first.traceEmbeddingsPending).toBe(0);
    expect(first.points.filter(p => p.source === "production")).toHaveLength(9);

    // Persistence, not recomputation: forget the texts the mock could embed - a second call
    // must serve the same 9 points from the input_embedding column the UPDATE wrote.
    for (const text of legacyTexts) {
      registered.delete(text);
    }
    const second = await getCoverageMap(db, { window: "7d", datasetIds: [datasetId] });
    expect(second.traceEmbeddingsPending).toBe(0);
    expect(second.points.filter(p => p.source === "production")).toHaveLength(9);
  }, 30_000);
});
