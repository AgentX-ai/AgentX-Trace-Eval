import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { RootsPageQuery, SpanWindowFilter, TraceRow, TraceStore } from "./traceStore.js";

// The ClickHouse adapter (ADR-0003): the enterprise span store. Physical column names follow
// the OTel GenAI semantic conventions (ADR-0004) - this table is greenfield and external BI /
// OTel tooling will query it directly, so gen_ai_* / session_id / agentx_* namespacing is the
// contract here. (The relational schemas keep their historical names; the ADR-0004 mapping
// table is the bridge.) Value vocabularies (span kinds, sources) stay the engine's own and
// converge on semconv values as a separate step, recorded in the ADR. MergeTree ordered by
// (project_id, created_at, id), partitioned by day, ZSTD on payload columns,
// LowCardinality on enum-shaped fields. Retention is TTL-first (bootstrap takes the default
// TTL from AGENTX_TELEMETRY_TTL_DAYS); the port's scoped prune() maps to a lightweight DELETE
// mutation for the per-project/per-agent settings the product exposes.
//
// Idempotency: ClickHouse has no unique constraints, so the (project, span_id) contract is
// enforced adapter-side - each batch first resolves which span_ids already exist, and only the
// rest insert. The ingest queue serializes flushes per process, and the deployment model is one
// engine writer per telemetry store (same stance as rollups, core/monitor/rollups.ts), which is
// what makes check-then-insert sound here. Multi-writer ClickHouse ingest is a future ADR
// (named in ADR-0003's consequences) and would move dedupe into ReplacingMergeTree semantics.

const TABLE = "agentx_spans";

export type ClickHouseConfig = {
  url: string; // http(s)://user:pass@host:8123/database
};

// Every user-influenced value binds through ClickHouse's native query parameters - no string
// interpolation of external input, ever. Numbers interpolate only after Math.floor/getTime.

function toStored(row: TraceRow): Record<string, unknown> {
  return {
    project_id: row.projectId ?? "",
    id: row.id,
    name: row.name,
    gen_ai_input_messages: row.input == null ? null : JSON.stringify(row.input),
    gen_ai_output_messages: row.output == null ? null : JSON.stringify(row.output),
    error: row.error,
    latency_ms: row.latencyMs,
    agentx_framework: row.framework,
    gen_ai_request_model: row.model,
    agentx_tool_calls: row.toolCalls == null ? null : JSON.stringify(row.toolCalls),
    agentx_metadata: row.metadata == null ? null : JSON.stringify(row.metadata),
    session_id: row.sessionId,
    agentx_performance_summary: row.performanceSummary == null ? null : JSON.stringify(row.performanceSummary),
    gen_ai_usage_input_tokens: row.inputTokens,
    gen_ai_usage_output_tokens: row.outputTokens,
    gen_ai_usage_cache_read_input_tokens: row.cacheReadTokens,
    gen_ai_usage_cache_creation_input_tokens: row.cacheWriteTokens,
    span_id: row.spanId,
    gen_ai_operation_name: row.spanKind,
    agentx_source: row.source,
    parent_span_id: row.parentSpanId,
    started_at: row.startedAt ? row.startedAt.getTime() : null,
    created_at: row.createdAt.getTime(),
    gen_ai_agent_id: row.agentId,
  };
}

type StoredRow = {
  project_id: string;
  id: string;
  name: string;
  gen_ai_input_messages: string | null;
  gen_ai_output_messages: string | null;
  error: string | null;
  latency_ms: string | number | null;
  agentx_framework: string | null;
  gen_ai_request_model: string | null;
  agentx_tool_calls: string | null;
  agentx_metadata: string | null;
  session_id: string | null;
  agentx_performance_summary: string | null;
  gen_ai_usage_input_tokens: string | number | null;
  gen_ai_usage_output_tokens: string | number | null;
  gen_ai_usage_cache_read_input_tokens: string | number | null;
  gen_ai_usage_cache_creation_input_tokens: string | number | null;
  span_id: string | null;
  gen_ai_operation_name: string | null;
  agentx_source: string | null;
  parent_span_id: string | null;
  started_at: string | null;
  created_at: string;
  gen_ai_agent_id: string | null;
};

const num = (v: string | number | null): number | null => (v == null ? null : Number(v));
const json = (v: string | null): unknown => {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

function fromStored(row: StoredRow): TraceRow {
  return {
    id: row.id,
    name: row.name,
    input: json(row.gen_ai_input_messages),
    output: json(row.gen_ai_output_messages),
    error: row.error,
    latencyMs: num(row.latency_ms),
    framework: row.agentx_framework,
    model: row.gen_ai_request_model,
    toolCalls: json(row.agentx_tool_calls),
    metadata: json(row.agentx_metadata),
    sessionId: row.session_id,
    performanceSummary: json(row.agentx_performance_summary),
    inputTokens: num(row.gen_ai_usage_input_tokens),
    outputTokens: num(row.gen_ai_usage_output_tokens),
    cacheReadTokens: num(row.gen_ai_usage_cache_read_input_tokens),
    cacheWriteTokens: num(row.gen_ai_usage_cache_creation_input_tokens),
    spanId: row.span_id,
    spanKind: row.gen_ai_operation_name,
    source: row.agentx_source,
    parentSpanId: row.parent_span_id,
    startedAt: row.started_at ? new Date(`${row.started_at}Z`) : null,
    createdAt: new Date(`${row.created_at}Z`),
    agentId: row.gen_ai_agent_id,
    projectId: row.project_id,
  };
}

export async function bootstrapClickHouse(client: ClickHouseClient, ttlDays: number): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        project_id String,
        id String,
        name String CODEC(ZSTD),
        gen_ai_input_messages Nullable(String) CODEC(ZSTD),
        gen_ai_output_messages Nullable(String) CODEC(ZSTD),
        error Nullable(String) CODEC(ZSTD),
        latency_ms Nullable(Int64),
        agentx_framework LowCardinality(Nullable(String)),
        gen_ai_request_model LowCardinality(Nullable(String)),
        agentx_tool_calls Nullable(String) CODEC(ZSTD),
        agentx_metadata Nullable(String) CODEC(ZSTD),
        session_id Nullable(String),
        agentx_performance_summary Nullable(String) CODEC(ZSTD),
        gen_ai_usage_input_tokens Nullable(Int64),
        gen_ai_usage_output_tokens Nullable(Int64),
        gen_ai_usage_cache_read_input_tokens Nullable(Int64),
        gen_ai_usage_cache_creation_input_tokens Nullable(Int64),
        span_id Nullable(String),
        gen_ai_operation_name LowCardinality(Nullable(String)),
        agentx_source LowCardinality(Nullable(String)),
        parent_span_id Nullable(String),
        started_at Nullable(DateTime64(3, 'UTC')),
        created_at DateTime64(3, 'UTC'),
        gen_ai_agent_id Nullable(String)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMMDD(created_at)
      ORDER BY (project_id, created_at, id)
      TTL toDateTime(created_at) + INTERVAL ${Math.max(1, Math.floor(ttlDays))} DAY
    `,
  });
}

export class ClickHouseTraceStore implements TraceStore {
  private readonly client: ClickHouseClient;
  private readonly projectId: string;

  constructor(client: ClickHouseClient, projectId: string) {
    this.client = client;
    this.projectId = projectId;
  }

  private async rows(query: string, params: Record<string, unknown> = {}): Promise<StoredRow[]> {
    const result = await this.client.query({
      query,
      query_params: { project: this.projectId, ...params },
      format: "JSONEachRow",
    });
    return (await result.json()) as StoredRow[];
  }

  private scope(): string {
    return `project_id = {project:String}`;
  }

  async insertSpan(row: TraceRow): Promise<boolean> {
    const won = await this.insertSpans([row]);
    return won.has(row.id);
  }

  async insertSpans(rows: TraceRow[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    // Adapter-side idempotency (see module header): resolve already-present span_ids first.
    const spanIds = rows.map(r => r.spanId).filter((v): v is string => !!v);
    const taken = new Set<string>();
    if (spanIds.length > 0) {
      const existing = await this.rows(
        `SELECT span_id FROM ${TABLE} WHERE ${this.scope()} AND span_id IN {ids:Array(String)}`,
        { ids: spanIds }
      );
      for (const r of existing) if (r.span_id) taken.add(r.span_id);
    }
    const winners: TraceRow[] = [];
    const seenInBatch = new Set<string>();
    for (const row of rows) {
      if (row.spanId && (taken.has(row.spanId) || seenInBatch.has(row.spanId))) continue;
      if (row.spanId) seenInBatch.add(row.spanId);
      winners.push(row);
    }
    if (winners.length > 0) {
      await this.client.insert({ table: TABLE, values: winners.map(toStored), format: "JSONEachRow" });
    }
    return new Set(winners.map(r => r.id));
  }

  async getById(id: string): Promise<TraceRow | undefined> {
    const rows = await this.rows(`SELECT * FROM ${TABLE} WHERE ${this.scope()} AND id = {id:String} LIMIT 1`, { id });
    return rows[0] ? fromStored(rows[0]) : undefined;
  }

  async getByIds(ids: string[]): Promise<Map<string, TraceRow>> {
    const out = new Map<string, TraceRow>();
    if (ids.length === 0) return out;
    const rows = await this.rows(`SELECT * FROM ${TABLE} WHERE ${this.scope()} AND id IN {ids:Array(String)}`, {
      ids,
    });
    for (const row of rows) out.set(row.id, fromStored(row));
    return out;
  }

  async findBySpanId(spanId: string): Promise<{ id: string; agentId: string | null } | undefined> {
    const rows = await this.rows(
      `SELECT id, gen_ai_agent_id AS agent_id FROM ${TABLE} WHERE ${this.scope()} AND span_id = {spanId:String} LIMIT 1`,
      { spanId }
    );
    return rows[0] ? { id: rows[0].id, agentId: (rows[0] as unknown as { agent_id: string | null }).agent_id } : undefined;
  }

  async listBySession(sessionId: string): Promise<TraceRow[]> {
    const rows = await this.rows(
      `SELECT * FROM ${TABLE} WHERE ${this.scope()} AND session_id = {sessionId:String}`,
      { sessionId }
    );
    return rows.map(fromStored);
  }

  async listRecent(limit: number): Promise<TraceRow[]> {
    const rows = await this.rows(`SELECT * FROM ${TABLE} WHERE ${this.scope()} LIMIT ${Math.floor(limit)}`);
    return rows.map(fromStored);
  }

  // Shared by listRootsPage and countRootsPage so the page and its total agree on "matching".
  private rootsPageFilter(query: Omit<RootsPageQuery, "cursor" | "pageSize">): {
    conds: string[];
    params: Record<string, unknown>;
  } {
    const conds = [this.scope(), "parent_span_id IS NULL"];
    const params: Record<string, unknown> = {};
    if (query.framework) {
      conds.push(`agentx_framework = {framework:String}`);
      params.framework = query.framework;
    }
    if (query.source === "production") conds.push(`(agentx_source IS NULL OR agentx_source != 'eval-run')`);
    if (query.source === "eval") conds.push(`agentx_source = 'eval-run'`);
    const term = query.searchTerm?.trim();
    if (term) {
      params.pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const cols = ["name", "gen_ai_input_messages", "gen_ai_output_messages", "gen_ai_request_model", "error", "id", "session_id"];
      conds.push(`(${cols.map(c => `${c} ILIKE {pattern:String}`).join(" OR ")})`);
    }
    return { conds, params };
  }

  async countRootsPage(query: Omit<RootsPageQuery, "cursor" | "pageSize">): Promise<number> {
    const { conds, params } = this.rootsPageFilter(query);
    const rows = await this.rows(`SELECT count(*) AS id FROM ${TABLE} WHERE ${conds.join(" AND ")}`, params);
    return Number((rows[0] as unknown as { id: string })?.id ?? 0);
  }

  async listRootsPage(query: RootsPageQuery): Promise<TraceRow[]> {
    const { conds, params } = this.rootsPageFilter(query);
    if (query.cursor) {
      const at = query.cursor.createdAt.getTime();
      params.cursorId = query.cursor.id;
      conds.push(
        `(created_at < fromUnixTimestamp64Milli(${at}) OR (created_at = fromUnixTimestamp64Milli(${at}) AND id < {cursorId:String}))`
      );
    }
    const rows = await this.rows(
      `SELECT * FROM ${TABLE} WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${query.pageSize + 1}`,
      params
    );
    return rows.map(fromStored);
  }

  async queryWindow(filter: SpanWindowFilter): Promise<TraceRow[]> {
    const conds = [this.scope()];
    if (filter.since) conds.push(`created_at >= fromUnixTimestamp64Milli(${filter.since.getTime()})`);
    if (filter.productionOnly) conds.push(`(agentx_source IS NULL OR agentx_source != 'eval-run')`);
    if (filter.rootsOnly) conds.push("parent_span_id IS NULL");
    if (filter.withSessionOnly) conds.push("session_id IS NOT NULL");
    if (filter.scorableOnly) conds.push(
        "parent_span_id IS NULL",
        "gen_ai_output_messages IS NOT NULL",
        "gen_ai_output_messages != ''",
        `gen_ai_output_messages != '\"\"'`
      );
    let query = `SELECT * FROM ${TABLE} WHERE ${conds.join(" AND ")}`;
    if (filter.orderDesc) query += " ORDER BY created_at DESC";
    if (filter.limit != null) query += ` LIMIT ${Math.floor(filter.limit)}`;
    const rows = await this.rows(query);
    return rows.map(fromStored);
  }

  async countRoots(since?: Date): Promise<number> {
    const conds = [this.scope(), "parent_span_id IS NULL"];
    if (since) conds.push(`created_at >= fromUnixTimestamp64Milli(${since.getTime()})`);
    const rows = await this.rows(`SELECT count(*) AS id FROM ${TABLE} WHERE ${conds.join(" AND ")}`);
    return Number((rows[0] as unknown as { id: string })?.id ?? 0);
  }

  async countRootsByProjectUnscoped(since: Date): Promise<{ projectId: string | null; n: number }[]> {
    const rows = await this.rows(
      `SELECT project_id, count(*) AS id FROM ${TABLE} WHERE parent_span_id IS NULL AND created_at >= fromUnixTimestamp64Milli(${since.getTime()}) GROUP BY project_id`
    );
    return (rows as unknown as { project_id: string; id: string }[]).map(r => ({
      projectId: r.project_id || null,
      n: Number(r.id),
    }));
  }

  async prune(cutoff: Date, agentScope: string | null): Promise<void> {
    const agentCond = agentScope === null ? "gen_ai_agent_id IS NULL" : "gen_ai_agent_id = {agent:String}";
    await this.client.command({
      query: `ALTER TABLE ${TABLE} DELETE WHERE ${this.scope()} AND ${agentCond} AND created_at < fromUnixTimestamp64Milli(${cutoff.getTime()})`,
      query_params: { project: this.projectId, ...(agentScope === null ? {} : { agent: agentScope }) },
      clickhouse_settings: { mutations_sync: "1" },
    });
  }

  async deleteAllForProject(): Promise<void> {
    await this.client.command({
      query: `ALTER TABLE ${TABLE} DELETE WHERE ${this.scope()}`,
      query_params: { project: this.projectId },
      clickhouse_settings: { mutations_sync: "1" },
    });
  }
}

export function createClickHouseClientFromUrl(url: string): ClickHouseClient {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, "") || "default";
  return createClient({
    url: `${parsed.protocol}//${parsed.host}`,
    username: decodeURIComponent(parsed.username || "default"),
    password: decodeURIComponent(parsed.password || ""),
    database,
  });
}
