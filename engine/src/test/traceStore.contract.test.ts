import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { bootstrapSqlite, bootstrapPostgres, withProjectId, type Db } from "../storage/db.js";
import * as sqliteSchema from "../storage/schema.sqlite.js";
import * as pgSchema from "../storage/schema.pg.js";
import { SqlTraceStore } from "../core/trace/store/sqlTraceStore.js";
import {
  ClickHouseTraceStore,
  bootstrapClickHouse,
  createClickHouseClientFromUrl,
} from "../core/trace/store/clickhouseTraceStore.js";
import type { TraceRow, TraceStore } from "../core/trace/store/traceStore.js";

// The golden TraceStore contract (ADR-0002): one scenario, identical assertions, every
// available backend. SQLite always runs; Postgres joins when AGENTX_TEST_DB_URL is set (same
// opt-in as dialect.integration.test.ts); the ClickHouse adapter registers here when it lands
// (ADR-0003). A behavior difference between adapters is a failing build, not a support ticket.

const TEST_POSTGRES_URL = process.env.AGENTX_TEST_DB_URL;

type Backend = {
  name: string;
  init?: () => Promise<unknown>;
  makeStore: (projectId: string) => TraceStore;
  close: () => Promise<void> | void;
};

const backends: Backend[] = [];

// SQLite: a throwaway on-disk database per suite run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentx-store-contract-"));
const sqlite = new BetterSqlite3(path.join(tmpDir, "contract.db"));
sqlite.pragma("journal_mode = WAL");
bootstrapSqlite(sqlite as never);
const sqliteDb: Db = {
  kind: "sqlite",
  db: drizzleSqlite(sqlite, { schema: sqliteSchema }),
  schema: sqliteSchema,
  projectId: "",
} as Db;
backends.push({
  name: "sqlite",
  makeStore: projectId => new SqlTraceStore(withProjectId(sqliteDb, projectId)),
  close: () => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },
});

if (TEST_POSTGRES_URL) {
  const pool = new Pool({ connectionString: TEST_POSTGRES_URL });
  const pgDb: Db = { kind: "postgres", db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema, projectId: "" } as Db;
  backends.push({
    name: "postgres",
    init: async () => {
      // Fresh databases bootstrap PARTITIONED (ADR-0007) - the flag switches the adapter to
      // its pre-check dedupe, exactly what this suite must exercise.
      const { tracesPartitioned } = await bootstrapPostgres(pool);
      (pgDb as { tracesPartitioned?: boolean }).tracesPartitioned = tracesPartitioned;
    },
    makeStore: projectId => new SqlTraceStore(withProjectId(pgDb, projectId)),
    close: () => pool.end(),
  });
}

const TEST_CLICKHOUSE_URL = process.env.AGENTX_TEST_CLICKHOUSE_URL;
if (TEST_CLICKHOUSE_URL) {
  const client = createClickHouseClientFromUrl(TEST_CLICKHOUSE_URL);
  backends.push({
    name: "clickhouse",
    init: () => bootstrapClickHouse(client, 90),
    makeStore: projectId => new ClickHouseTraceStore(client, projectId),
    close: () => client.close(),
  });
}

afterAll(async () => {
  for (const backend of backends) await backend.close();
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

function span(partial: Partial<TraceRow> & { id: string; projectId: string }): TraceRow {
  return {
    name: "contract-agent",
    input: "question",
    output: "answer",
    error: null,
    latencyMs: 100,
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
    spanKind: null,
    source: null,
    parentSpanId: null,
    startedAt: null,
    createdAt: at(5),
    agentId: null,
    ...partial,
  };
}

for (const backend of backends) {
  describe(`TraceStore contract [${backend.name}]`, () => {
    // Unique project per backend per run: Postgres reuses a shared test database, and project
    // scoping is exactly the isolation the store promises anyway.
    const projectId = `contract-${backend.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const otherProjectId = `${projectId}-other`;
    const store = () => backend.makeStore(projectId);

    beforeAll(async () => {
      await backend.init?.();
    }, 60_000);

    it("inserts idempotently on (project, span_id)", async () => {
      const s = store();
      expect(await s.insertSpan(span({ id: "root-a", projectId, spanId: "sp-a", sessionId: "sess-1", agentId: "ag-1", createdAt: at(60) }))).toBe(true);
      expect(await s.insertSpan(span({ id: "root-a-dupe", projectId, spanId: "sp-a", createdAt: at(60) }))).toBe(false);
      // No span_id never conflicts.
      expect(await s.insertSpan(span({ id: "child-a1", projectId, spanId: "sp-a1", parentSpanId: "sp-a", sessionId: "sess-1", createdAt: at(59) }))).toBe(true);
      expect(await s.insertSpan(span({ id: "root-b", projectId, source: "eval-run", output: "eval answer", createdAt: at(30) }))).toBe(true);
      expect(await s.insertSpan(span({ id: "root-c", projectId, spanId: "sp-c", model: "gpt-test", framework: "raw", createdAt: at(2) }))).toBe(true);
      expect(await s.insertSpan(span({ id: "root-empty", projectId, output: "", createdAt: at(1) }))).toBe(true);
    });

    it("point reads: by id, by ids, by span id", async () => {
      const s = store();
      expect((await s.getById("root-a"))?.sessionId).toBe("sess-1");
      expect(await s.getById("missing")).toBeUndefined();
      const byIds = await s.getByIds(["root-a", "root-c", "missing"]);
      expect([...byIds.keys()].sort()).toEqual(["root-a", "root-c"]);
      expect(await s.findBySpanId("sp-a")).toEqual({ id: "root-a", agentId: "ag-1" });
      expect(await s.findBySpanId("nope")).toBeUndefined();
    });

    it("session listing and recency", async () => {
      const s = store();
      const sess = await s.listBySession("sess-1");
      expect(sess.map(r => r.id).sort()).toEqual(["child-a1", "root-a"]);
      expect((await s.listRecent(100)).length).toBe(5);
    });

    it("window queries honor every filter", async () => {
      const s = store();
      const all = await s.queryWindow({});
      expect(all.length).toBe(5);
      const prod = await s.queryWindow({ productionOnly: true });
      expect(prod.map(r => r.id).sort()).toEqual(["child-a1", "root-a", "root-c", "root-empty"]);
      const roots = await s.queryWindow({ rootsOnly: true });
      expect(roots.map(r => r.id).sort()).toEqual(["root-a", "root-b", "root-c", "root-empty"]);
      const inSession = await s.queryWindow({ withSessionOnly: true });
      expect(inSession.map(r => r.id).sort()).toEqual(["child-a1", "root-a"]);
      const recent = await s.queryWindow({ since: at(10) });
      expect(recent.map(r => r.id).sort()).toEqual(["root-c", "root-empty"]);
      // Scorable: roots with non-empty output, newest first, limited.
      const scorable = await s.queryWindow({ scorableOnly: true, orderDesc: true, limit: 2 });
      expect(scorable.map(r => r.id)).toEqual(["root-c", "root-b"]);
    });

    it("roots page: keyset cursor, filters, search", async () => {
      const s = store();
      const page1 = await s.listRootsPage({ pageSize: 2 });
      expect(page1.length).toBe(3); // pageSize + 1 signals another page
      expect(page1.map(r => r.id)).toEqual(["root-empty", "root-c", "root-b"]);
      const boundary = page1[1]!;
      const page2 = await s.listRootsPage({ pageSize: 2, cursor: { createdAt: boundary.createdAt, id: boundary.id } });
      expect(page2.map(r => r.id)).toEqual(["root-b", "root-a"]);
      expect((await s.listRootsPage({ pageSize: 10, source: "eval" })).map(r => r.id)).toEqual(["root-b"]);
      expect((await s.listRootsPage({ pageSize: 10, source: "production" })).map(r => r.id)).toEqual([
        "root-empty",
        "root-c",
        "root-a",
      ]);
      expect((await s.listRootsPage({ pageSize: 10, framework: "raw" })).map(r => r.id)).toEqual(["root-c"]);
      expect((await s.listRootsPage({ pageSize: 10, searchTerm: "gpt-test" })).map(r => r.id)).toEqual(["root-c"]);
      // Wildcards match literally.
      expect((await s.listRootsPage({ pageSize: 10, searchTerm: "100%" })).length).toBe(0);
    });

    it("counts roots, scoped and unscoped", async () => {
      const s = store();
      expect(await s.countRoots()).toBe(4);
      expect(await s.countRoots(at(10))).toBe(2);
      const perProject = await s.countRootsByProjectUnscoped(at(24 * 60));
      const mine = perProject.find(r => r.projectId === projectId);
      expect(mine?.n).toBe(4);
    });

    it("prunes by cutoff within an agent scope", async () => {
      const s = store();
      // agentScope null only touches agent-less rows; root-a (ag-1) survives the same cutoff.
      await s.prune(at(45), null);
      expect((await s.queryWindow({})).map(r => r.id).sort()).toEqual([
        "root-a",
        "root-b",
        "root-c",
        "root-empty",
      ]);
      await s.prune(at(45), "ag-1");
      expect((await s.queryWindow({})).map(r => r.id).sort()).toEqual(["root-b", "root-c", "root-empty"]);
    });

    it("project deletion is scoped", async () => {
      const other = backend.makeStore(otherProjectId);
      await other.insertSpan(span({ id: "other-1", projectId: otherProjectId }));
      await store().deleteAllForProject();
      expect((await store().queryWindow({})).length).toBe(0);
      expect((await other.queryWindow({})).length).toBe(1);
      await other.deleteAllForProject();
    });
  });
}
