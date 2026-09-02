import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import type { Db } from "../storage/db.js";
import { backfillFrameworkCasefold, traceStoreFor } from "../core/trace/store/index.js";

// The latent bug this closes: ingest folds `framework` to lowercase since the Platforms chart
// landed, and every reader folds its queries the same way - but rows stored BEFORE the fold
// keep their original casing and would silently never match again. The backfill rewrites them
// once, marks app_settings, and never scans again.

let test: TestDb;
let db: Db;

async function insertTrace(framework: string | null): Promise<string> {
  const id = nanoid();
  const values = {
    id,
    name: "casefold-agent",
    input: "q",
    output: "a",
    error: null,
    latencyMs: 1,
    framework,
    model: null,
    toolCalls: null,
    metadata: null,
    sessionId: null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanKind: null,
    source: null,
    spanId: null,
    parentSpanId: null,
    startedAt: null,
    createdAt: new Date(),
    agentId: null,
    projectId: db.projectId,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.traces).values(values);
  } else {
    await db.db.insert(db.schema.traces).values(values);
  }
  return id;
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("Casefold"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("framework casefold backfill", () => {
  it("folds legacy mixed-case rows, leaves null alone, and marks itself done", async () => {
    // Direct inserts, deliberately bypassing ingest normalization - these ARE the legacy rows.
    const legacy = await insertTrace("LangChain");
    const padded = await insertTrace("  OpenAI-Agents ");
    const nullRow = await insertTrace(null);
    const already = await insertTrace("crewai");

    await backfillFrameworkCasefold(db);

    const store = traceStoreFor(db);
    expect((await store.getById(legacy))?.framework).toBe("langchain");
    expect((await store.getById(padded))?.framework).toBe("openai-agents");
    expect((await store.getById(nullRow))?.framework).toBeNull();
    expect((await store.getById(already))?.framework).toBe("crewai");

    // Marker written - a second run must not rewrite anything (proven via a fresh mixed-case
    // row surviving untouched, since the guard short-circuits before any UPDATE).
    const late = await insertTrace("LateComer");
    await backfillFrameworkCasefold(db);
    expect((await store.getById(late))?.framework).toBe("LateComer");
  });
});
