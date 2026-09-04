// The TraceStore port (ADR-0002): every read and write of span data goes through this
// interface, because in the enterprise tier (ADR-0001/0003) spans do not live in the
// relational database at all. The SQL adapter (sqlTraceStore.ts) serves SQLite and Postgres;
// ClickHouse implements the same contract natively. One golden contract suite
// (src/test/traceStore.contract.test.ts) runs against every available backend - a behavior
// difference between adapters is a failing build.
//
// The query surface is deliberately narrow: exactly the shapes the product uses today. A new
// read shape extends this interface explicitly rather than reaching around it; a lint test
// (traceStoreBoundary.test.ts) fails any module outside store/ that touches schema.traces.

export type TraceRow = {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
  latencyMs: number | null;
  framework: string | null;
  model: string | null;
  toolCalls: unknown;
  metadata: unknown;
  sessionId: string | null;
  performanceSummary: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  spanId: string | null;
  spanKind: string | null;
  source: string | null;
  parentSpanId: string | null;
  startedAt: Date | null;
  createdAt: Date;
  agentId: string | null;
  projectId: string | null;
};

// Window scans: the filter vocabulary every aggregation-ish reader shares. All filters AND
// together; omitted means "don't filter". `productionOnly` excludes eval-run traffic (see
// core/trace/evalTraffic.ts for what that means and why); `scorableOnly` is the judge-preview
// shape (root spans with a non-empty output).
export type SpanWindowFilter = {
  since?: Date;
  productionOnly?: boolean;
  rootsOnly?: boolean;
  withSessionOnly?: boolean;
  scorableOnly?: boolean;
  orderDesc?: boolean;
  limit?: number;
};

// The Live Traces list page: keyset cursor (createdAt DESC, id DESC with an id tiebreak),
// framework/source filters, and the person-greps-traffic LIKE search. Returns up to
// pageSize + 1 raw rows - the caller derives hasNextPage/cursor and maps to wire shape.
export type RootsPageQuery = {
  pageSize: number;
  cursor?: { createdAt: Date; id: string } | null;
  framework?: string;
  source?: "production" | "eval" | "all";
  searchTerm?: string;
};

export interface TraceStore {
  /** Inserts one span; false when the (project, span_id) idempotency key already exists. */
  insertSpan(row: TraceRow): Promise<boolean>;
  /**
   * Micro-batch insert (ADR-0005): one round trip for the whole batch, idempotent per row.
   * Returns the ids that actually landed - a row losing the (project, span_id) conflict is a
   * replay, and its post-ingest pipeline must not run again.
   */
  insertSpans(rows: TraceRow[]): Promise<Set<string>>;
  getById(id: string): Promise<TraceRow | undefined>;
  /** Point lookups for a known id set (review queue evidence, run linking). */
  getByIds(ids: string[]): Promise<Map<string, TraceRow>>;
  /** Resolves a caller-supplied span id to the stored row's id + agent (ingest dedupe path). */
  findBySpanId(spanId: string): Promise<{ id: string; agentId: string | null } | undefined>;
  /** Every span sharing a session id, unordered - callers sort by startedAt/createdAt. */
  listBySession(sessionId: string): Promise<TraceRow[]>;
  listRecent(limit: number): Promise<TraceRow[]>;
  listRootsPage(query: RootsPageQuery): Promise<TraceRow[]>;
  /** Total roots matching the same filters as listRootsPage (cursor ignored) - the trace
   *  list's "X of N" pagination total. */
  countRootsPage(query: Omit<RootsPageQuery, "cursor" | "pageSize">): Promise<number>;
  queryWindow(filter: SpanWindowFilter): Promise<TraceRow[]>;
  /** Root-span count in the project, optionally windowed (rate limits, volume estimates). */
  countRoots(since?: Date): Promise<number>;
  /**
   * OPS, deliberately unscoped: root counts per project across the whole instance, for the
   * admin overview. The one method here that ignores the handle's project scope.
   */
  countRootsByProjectUnscoped(since: Date): Promise<{ projectId: string | null; n: number }[]>;
  /**
   * Retention (ADR-0007): drops spans older than cutoff. agentScope null = rows with no agent,
   * a string = that agent's rows. The adapter picks the engine-native mechanism.
   */
  prune(cutoff: Date, agentScope: string | null): Promise<void>;
  /** Project teardown (org deletion, seed reset). */
  deleteAllForProject(): Promise<void>;
}
