import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { openTestDb, type TestDb } from "./dbHarness.js";
import { listTracesPaginated } from "../core/trace/ingest.js";
import type { Db } from "../storage/db.js";

// Deep-dive round 3, bug #6: the trace list's keyset cursor filtered on createdAt alone, so
// every row sharing the page-boundary row's millisecond was skipped (3 of 2000 lost in a
// realistic 20-thread burst - storage had all 2000, the paginated read didn't). Driven at the
// core function with hand-planted timestamp collisions, since reproducing ties through the
// HTTP path is a coin flip.

let test: TestDb;
let db: Db;

async function insertTrace(target: Db, name: string, createdAt: Date): Promise<void> {
  const values = {
    id: nanoid(),
    name,
    input: "q",
    output: "a",
    error: null,
    latencyMs: 1,
    framework: null,
    model: null,
    toolCalls: null,
    metadata: null,
    sessionId: null,
    performanceSummary: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    spanId: null,
    parentSpanId: null,
    startedAt: createdAt,
    createdAt,
    agentId: null,
    projectId: target.projectId,
  };
  if (target.kind === "sqlite") {
    await target.db.insert(target.schema.traces).values(values);
  } else {
    await target.db.insert(target.schema.traces).values(values);
  }
}

beforeAll(async () => {
  test = await openTestDb();
  db = test.scoped(await test.newProject("pagination"));
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("listTracesPaginated under timestamp collisions", () => {
  it("returns every row exactly once when many share a createdAt millisecond", async () => {
    // 7 distinct milliseconds x 25 rows each = 175 rows, page size 20: every page boundary
    // lands inside a tie group, the exact shape the createdAt-only cursor lost rows on.
    const base = Date.now() - 60_000;
    for (let bucket = 0; bucket < 7; bucket++) {
      for (let i = 0; i < 25; i++) {
        await insertTrace(db, `tie-${bucket}-${i}`, new Date(base + bucket * 1000));
      }
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listTracesPaginated(db, { limit: 20, ...(cursor ? { cursor } : {}) });
      for (const t of page.traces as { _id: string; name: string }[]) {
        expect(seen.has(t._id)).toBe(false); // no dupes either - the other keyset failure mode
        seen.add(t._id);
      }
      pages += 1;
      expect(pages).toBeLessThan(50);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor as string;
    }

    expect(seen.size).toBe(175);
  });
});
