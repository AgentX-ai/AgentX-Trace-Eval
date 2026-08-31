import { and, count, desc, eq, gt, gte, isNull, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../storage/db.js";
import { EVAL_RUN_SOURCE } from "../evalTraffic.js";
import type { RootsPageQuery, SpanWindowFilter, TraceRow, TraceStore } from "./traceStore.js";

// The SQL adapter: one implementation serving both drizzle dialects (SQLite and Postgres),
// carrying the per-dialect branches that used to be copy-pasted across 17 modules. Everything
// here is a MOVE of existing query logic, not new behavior - the contract suite pins parity.

// The WHERE fragment every production-only read shares. Null source (everything before the
// column existed, and all normal traffic) is production; see core/trace/evalTraffic.ts.
function productionOnlyCond(db: Db): SQL {
  return or(isNull(db.schema.traces.source), ne(db.schema.traces.source, EVAL_RUN_SOURCE)) as SQL;
}

export class SqlTraceStore implements TraceStore {
  constructor(private readonly db: Db) {}

  private partitionedPg(): boolean {
    const db = this.db;
    return db.kind === "postgres" && db.tracesPartitioned === true;
  }

  // Partitioned-Postgres dedupe (ADR-0007): a partitioned table cannot carry the global
  // (project_id, span_id) unique index, so replays are filtered by a pre-check - sound under
  // the single-writer-per-store deployment model, exactly like the ClickHouse adapter.
  private async filterSpanIdWinners(rows: TraceRow[]): Promise<TraceRow[]> {
    const db = this.db;
    const spanIds = rows.map(r => r.spanId).filter((v): v is string => !!v);
    const taken = new Set<string>();
    if (spanIds.length > 0) {
      const t = db.schema.traces;
      const cond = and(eq(t.projectId, db.projectId), or(...spanIds.map(id => eq(t.spanId, id))));
      const existing =
        db.kind === "sqlite"
          ? db.db.select({ spanId: db.schema.traces.spanId }).from(db.schema.traces).where(cond).all()
          : await db.db.select({ spanId: db.schema.traces.spanId }).from(db.schema.traces).where(cond);
      for (const r of existing as { spanId: string | null }[]) if (r.spanId) taken.add(r.spanId);
    }
    const winners: TraceRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.spanId && (taken.has(row.spanId) || seen.has(row.spanId))) continue;
      if (row.spanId) seen.add(row.spanId);
      winners.push(row);
    }
    return winners;
  }

  async insertSpan(row: TraceRow): Promise<boolean> {
    const db = this.db;
    if (this.partitionedPg()) {
      const won = await this.insertSpans([row]);
      return won.has(row.id);
    }
    const inserted =
      db.kind === "sqlite"
        ? db.db.insert(db.schema.traces).values(row).onConflictDoNothing().returning({ id: db.schema.traces.id }).all()
        : await db.db
            .insert(db.schema.traces)
            .values(row)
            .onConflictDoNothing()
            .returning({ id: db.schema.traces.id });
    return inserted.length > 0;
  }

  async insertSpans(rows: TraceRow[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    const db = this.db;
    if (this.partitionedPg()) {
      const winners = await this.filterSpanIdWinners(rows);
      if (winners.length > 0 && db.kind === "postgres") {
        await db.db.insert(db.schema.traces).values(winners);
      }
      return new Set(winners.map(r => r.id));
    }
    const won =
      db.kind === "sqlite"
        ? db.db.insert(db.schema.traces).values(rows).onConflictDoNothing().returning({ id: db.schema.traces.id }).all()
        : await db.db
            .insert(db.schema.traces)
            .values(rows)
            .onConflictDoNothing()
            .returning({ id: db.schema.traces.id });
    return new Set(won.map(r => r.id));
  }

  async getById(id: string): Promise<TraceRow | undefined> {
    const db = this.db;
    const cond = and(eq(db.schema.traces.id, id), eq(db.schema.traces.projectId, db.projectId));
    const rows =
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.traces).where(cond).all()
        : await db.db.select().from(db.schema.traces).where(cond);
    return rows[0] as TraceRow | undefined;
  }

  async getByIds(ids: string[]): Promise<Map<string, TraceRow>> {
    const out = new Map<string, TraceRow>();
    if (ids.length === 0) return out;
    const db = this.db;
    const t = db.schema.traces;
    // Chunked IN-lists: bounded statement size however large the id set gets.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const cond = and(eq(t.projectId, db.projectId), or(...chunk.map(id => eq(t.id, id))));
      const rows =
        db.kind === "sqlite"
          ? db.db.select().from(db.schema.traces).where(cond).all()
          : await db.db.select().from(db.schema.traces).where(cond);
      for (const row of rows as TraceRow[]) out.set(row.id, row);
    }
    return out;
  }

  async findBySpanId(spanId: string): Promise<{ id: string; agentId: string | null } | undefined> {
    const db = this.db;
    const cond = and(eq(db.schema.traces.spanId, spanId), eq(db.schema.traces.projectId, db.projectId));
    const rows =
      db.kind === "sqlite"
        ? db.db
            .select({ id: db.schema.traces.id, agentId: db.schema.traces.agentId })
            .from(db.schema.traces)
            .where(cond)
            .limit(1)
            .all()
        : await db.db
            .select({ id: db.schema.traces.id, agentId: db.schema.traces.agentId })
            .from(db.schema.traces)
            .where(cond)
            .limit(1);
    return rows[0];
  }

  async listBySession(sessionId: string): Promise<TraceRow[]> {
    const db = this.db;
    const cond = and(eq(db.schema.traces.sessionId, sessionId), eq(db.schema.traces.projectId, db.projectId));
    const rows =
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.traces).where(cond).all()
        : await db.db.select().from(db.schema.traces).where(cond);
    return rows as TraceRow[];
  }

  async listRecent(limit: number): Promise<TraceRow[]> {
    const db = this.db;
    const cond = eq(db.schema.traces.projectId, db.projectId);
    const rows =
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.traces).where(cond).limit(limit).all()
        : await db.db.select().from(db.schema.traces).where(cond).limit(limit);
    return rows as TraceRow[];
  }

  async listRootsPage(query: RootsPageQuery): Promise<TraceRow[]> {
    const db = this.db;
    const t = db.schema.traces;
    // Root spans only: a multi-span trace otherwise floods the list with one row per LLM/tool
    // call. Children stay reachable through the trace dialog's session fetch.
    const conditions: SQL[] = [isNull(t.parentSpanId), eq(t.projectId, db.projectId)];
    if (query.framework) conditions.push(eq(t.framework, query.framework));
    if (query.source === "production") conditions.push(productionOnlyCond(db));
    if (query.source === "eval") conditions.push(eq(t.source, EVAL_RUN_SOURCE));
    const term = query.searchTerm?.trim();
    if (term) {
      // A LIKE across the columns a person actually greps traffic by; wildcards escaped so
      // searching "100%" matches literally. SQLite LIKE is ASCII-case-insensitive already;
      // Postgres needs ILIKE. Explicit ESCAPE because SQLite has no default escape character.
      const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const columns = [t.name, t.input, t.output, t.model, t.error, t.id, t.sessionId];
      // CAST to text on Postgres: input/output are jsonb there, and `jsonb ILIKE` is not an
      // operator - the search 500'd on every Postgres deployment until the contract suite ran
      // this shape against a real Postgres. SQLite stores json as TEXT, so LIKE just works.
      const searchCond = or(
        ...columns.map(column =>
          db.kind === "sqlite"
            ? sql`${column} LIKE ${pattern} ESCAPE '\\'`
            : sql`CAST(${column} AS TEXT) ILIKE ${pattern} ESCAPE '\\'`
        )
      );
      if (searchCond) conditions.push(searchCond);
    }
    // Keyset with an id tiebreak matching the (createdAt DESC, id DESC) sort: "strictly older
    // than the boundary" alone silently skips the boundary row's same-millisecond siblings.
    if (query.cursor) {
      const next = or(
        lt(t.createdAt, query.cursor.createdAt),
        and(eq(t.createdAt, query.cursor.createdAt), lt(t.id, query.cursor.id))
      );
      if (next) conditions.push(next);
    }
    const where = and(...conditions);
    const rows =
      db.kind === "sqlite"
        ? db.db
            .select()
            .from(db.schema.traces)
            .where(where)
            .orderBy(desc(db.schema.traces.createdAt), desc(db.schema.traces.id))
            .limit(query.pageSize + 1)
            .all()
        : await db.db
            .select()
            .from(db.schema.traces)
            .where(where)
            .orderBy(desc(db.schema.traces.createdAt), desc(db.schema.traces.id))
            .limit(query.pageSize + 1);
    return rows as TraceRow[];
  }

  async queryWindow(filter: SpanWindowFilter): Promise<TraceRow[]> {
    const db = this.db;
    const t = db.schema.traces;
    const conditions: SQL[] = [eq(t.projectId, db.projectId) as SQL];
    if (filter.since) conditions.push(gte(t.createdAt, filter.since));
    if (filter.productionOnly) conditions.push(productionOnlyCond(db));
    if (filter.rootsOnly) conditions.push(isNull(t.parentSpanId));
    if (filter.withSessionOnly) conditions.push(isNotNull(t.sessionId));
    if (filter.scorableOnly) {
      conditions.push(isNull(t.parentSpanId), isNotNull(t.output), ne(t.output, ""));
    }
    const where = and(...conditions);
    // The mild duplication below is the codebase's dialect idiom: drizzle's sqlite and pg
    // builders don't share a supertype, so each branch stays fully narrowed.
    if (db.kind === "sqlite") {
      let q = db.db.select().from(db.schema.traces).where(where).$dynamic();
      if (filter.orderDesc) q = q.orderBy(desc(db.schema.traces.createdAt));
      if (filter.limit != null) q = q.limit(filter.limit);
      return q.all() as TraceRow[];
    }
    let q = db.db.select().from(db.schema.traces).where(where).$dynamic();
    if (filter.orderDesc) q = q.orderBy(desc(db.schema.traces.createdAt));
    if (filter.limit != null) q = q.limit(filter.limit);
    return (await q) as TraceRow[];
  }

  async countRoots(since?: Date): Promise<number> {
    const db = this.db;
    const t = db.schema.traces;
    const conditions: SQL[] = [eq(t.projectId, db.projectId) as SQL, isNull(t.parentSpanId) as SQL];
    // gte, not gt: the pre-port quota count (countTracesToday) used gte, and a span stamped
    // exactly at local midnight must still count against the daily quota.
    if (since) conditions.push(gte(t.createdAt, since));
    const where = and(...conditions);
    const rows =
      db.kind === "sqlite"
        ? db.db.select({ n: count() }).from(db.schema.traces).where(where).all()
        : await db.db.select({ n: count() }).from(db.schema.traces).where(where);
    return Number(rows[0]?.n ?? 0);
  }

  async countRootsByProjectUnscoped(since: Date): Promise<{ projectId: string | null; n: number }[]> {
    const db = this.db;
    const t = db.schema.traces;
    const where = and(gte(t.createdAt, since), isNull(t.parentSpanId));
    const rows =
      db.kind === "sqlite"
        ? db.db
            .select({ projectId: db.schema.traces.projectId, n: sql<number>`count(*)` })
            .from(db.schema.traces)
            .where(where)
            .groupBy(db.schema.traces.projectId)
            .all()
        : await db.db
            .select({ projectId: db.schema.traces.projectId, n: sql<number>`count(*)` })
            .from(db.schema.traces)
            .where(where)
            .groupBy(db.schema.traces.projectId);
    return (rows as { projectId: string | null; n: number }[]).map(r => ({ projectId: r.projectId, n: Number(r.n) }));
  }

  async prune(cutoff: Date, agentScope: string | null): Promise<void> {
    const db = this.db;
    const t = db.schema.traces;
    const cond =
      agentScope === null
        ? and(lt(t.createdAt, cutoff), isNull(t.agentId), eq(t.projectId, db.projectId))
        : and(lt(t.createdAt, cutoff), eq(t.agentId, agentScope), eq(t.projectId, db.projectId));
    if (db.kind === "sqlite") {
      db.db.delete(db.schema.traces).where(cond).run();
    } else {
      await db.db.delete(db.schema.traces).where(cond);
    }
  }

  async deleteAllForProject(): Promise<void> {
    const db = this.db;
    const cond = eq(db.schema.traces.projectId, db.projectId);
    if (db.kind === "sqlite") {
      db.db.delete(db.schema.traces).where(cond).run();
    } else {
      await db.db.delete(db.schema.traces).where(cond);
    }
  }
}
