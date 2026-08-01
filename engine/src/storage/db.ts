/// <reference types="bun-types" />
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";

export const AGENTX_HOME = process.env.AGENTX_HOME || path.join(os.homedir(), ".agentx");

// Two dialects, one interface: everything downstream (repositories, routes) talks to `Db`,
// never to `better-sqlite3`/`bun:sqlite`/`pg` directly, so switching AGENTX_DB_URL from unset
// (SQLite) to postgres://... doesn't touch a single line outside this file. Drizzle's query
// builder is shaped compatibly enough between dialects for the simple CRUD this engine does (see
// plan's "core governance logic uses plain CRUD, no aggregation pipelines" finding) that one
// query API covers both: table refs differ (sqliteSchema.traces vs pgSchema.traces) but the
// calling code is otherwise identical.
export type Db =
  | { kind: "sqlite"; db: BetterSQLite3Database<typeof sqliteSchema>; schema: typeof sqliteSchema }
  | { kind: "postgres"; db: NodePgDatabase<typeof pgSchema>; schema: typeof pgSchema };

let cached: Db | null = null;

// Node's `better-sqlite3` is a native addon whose module-root lookup breaks inside Bun's
// `--compile`d virtual filesystem (`/$bunfs/root/...` has no real package.json to find), so the
// compiled `agentx-server` binary (plan task #113) needs Bun's own built-in `bun:sqlite` instead.
// `tsx`-run dev mode is plain Node, so it needs `better-sqlite3` instead: bun:sqlite doesn't
// exist there. Both produce a drizzle instance with the same query-builder API (see the `Db`
// type above), so nothing downstream of getDb() needs to know which one is active.
const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";

// Async because bun:sqlite can only be reached via a dynamic import (a static one would fail to
// resolve under plain Node, where that module doesn't exist at all). Called once at startup
// (see index.ts's main()); getDb() below stays synchronous for every other call site.
export async function initDb(): Promise<Db> {
  if (cached) {
    return cached;
  }

  const url = process.env.AGENTX_DB_URL;
  if (url && url.startsWith("postgres")) {
    const pool = new Pool({ connectionString: url });
    await bootstrapPostgres(pool);
    cached = { kind: "postgres", db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema };
    return cached;
  }

  const sqlitePath = url?.startsWith("sqlite:") ? url.slice("sqlite:".length) : defaultSqlitePath();
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  if (isBun) {
    const { Database: BunDatabase } = await import("bun:sqlite");
    const { drizzle: drizzleBun } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new BunDatabase(sqlitePath);
    sqlite.exec("PRAGMA journal_mode = WAL;");
    bootstrapSqlite(sqlite);
    cached = {
      kind: "sqlite",
      db: drizzleBun(sqlite, { schema: sqliteSchema }) as unknown as BetterSQLite3Database<typeof sqliteSchema>,
      schema: sqliteSchema,
    };
  } else {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { drizzle: drizzleSqlite } = await import("drizzle-orm/better-sqlite3");
    const sqlite = new BetterSqlite3(sqlitePath);
    sqlite.pragma("journal_mode = WAL");
    bootstrapSqlite(sqlite);
    cached = { kind: "sqlite", db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema };
  }
  return cached;
}

export function getDb(): Db {
  if (!cached) {
    throw new Error("Database not initialized: initDb() must be awaited once at startup before getDb() is called");
  }
  return cached;
}

function defaultSqlitePath(): string {
  return path.join(AGENTX_HOME, "agentx.db");
}

// Hand-written, idempotent bootstrap DDL, so `agentx-server --dev` works out of the box with
// zero setup. Replace with real drizzle-kit migrations (`db:generate` script already wired in
// package.json) once the schema stabilizes, see plan task #107. `exec()` has the same signature
// on both better-sqlite3's and bun:sqlite's Database, so this one function serves both.
function bootstrapSqlite(sqlite: { exec(sql: string): unknown }): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      error TEXT,
      latency_ms INTEGER,
      framework TEXT,
      model TEXT,
      tool_calls TEXT,
      metadata TEXT,
      session_id TEXT,
      performance_summary TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      questions TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      judge_prompt TEXT,
      judge_model TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject TEXT,
      run_source TEXT,
      sdk_info TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_run_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      batch_id TEXT,
      idempotency_key TEXT NOT NULL,
      case_id TEXT,
      question_index INTEGER,
      run_number INTEGER,
      input TEXT,
      output TEXT,
      error TEXT,
      rating REAL,
      justification TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS evaluation_run_results_run_id_idempotency_key
      ON evaluation_run_results (run_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS monitor_patterns (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      detector_kind TEXT NOT NULL DEFAULT 'contains',
      conditions TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      polarity TEXT NOT NULL DEFAULT 'failure',
      enabled INTEGER NOT NULL DEFAULT 1,
      sample_rate REAL NOT NULL DEFAULT 1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitor_profiles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      failure_detection_enabled INTEGER NOT NULL DEFAULT 1,
      info_detection_enabled INTEGER NOT NULL DEFAULT 1,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate REAL NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      redaction_mode TEXT NOT NULL DEFAULT 'standard',
      threshold_overrides TEXT,
      approval_policy TEXT,
      channels TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS monitor_profiles_agent_id ON monitor_profiles (agent_id);

    CREATE TABLE IF NOT EXISTS monitor_signals (
      id TEXT PRIMARY KEY,
      pattern_key TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      polarity TEXT NOT NULL DEFAULT 'failure',
      status TEXT NOT NULL DEFAULT 'open',
      review_status TEXT,
      recommended_actions TEXT,
      summary TEXT NOT NULL,
      root_cause TEXT,
      agent_id TEXT,
      trace_id TEXT,
      evidence TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS monitor_signals_pattern_key_agent_id
      ON monitor_signals (pattern_key, agent_id);

    CREATE TABLE IF NOT EXISTS monitor_signal_feedback (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      original_score REAL,
      corrected_score REAL,
      rationale TEXT NOT NULL,
      queued_for_autotune INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitor_events (
      id TEXT PRIMARY KEY,
      signal_id TEXT,
      pattern_key TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      polarity TEXT NOT NULL,
      agent_id TEXT,
      trace_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS monitor_events_agent_id_created_at ON monitor_events (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS monitor_events_created_at ON monitor_events (created_at);
  `);

  // Columns added after the tables above already shipped: CREATE TABLE IF NOT EXISTS doesn't
  // retrofit existing databases, so anyone with a pre-existing ~/.agentx/agentx.db needs these
  // added explicitly. SQLite has no ADD COLUMN IF NOT EXISTS, so each is tried individually and a
  // "duplicate column" failure (already applied) is swallowed; anything else rethrows.
  const columnMigrations: Array<[string, string]> = [
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN sample_rate REAL NOT NULL DEFAULT 1"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'all'"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN agent_ids TEXT"],
    ["monitor_profiles", "ALTER TABLE monitor_profiles ADD COLUMN channels TEXT"],
    ["monitor_signals", "ALTER TABLE monitor_signals ADD COLUMN review_status TEXT"],
    ["monitor_signals", "ALTER TABLE monitor_signals ADD COLUMN recommended_actions TEXT"],
  ];
  for (const [, statement] of columnMigrations) {
    try {
      sqlite.exec(statement);
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) {
        throw err;
      }
    }
  }
}

// Postgres mirror of bootstrapSqlite above: same tables, same idempotent "IF NOT EXISTS"
// approach, Postgres column types (JSONB instead of TEXT-as-JSON, TIMESTAMP instead of an
// INTEGER epoch, BOOLEAN instead of INTEGER 0/1, DOUBLE PRECISION instead of REAL) matching
// schema.pg.ts. Replace with real drizzle-kit migrations once the schema stabilizes, see plan
// task #107 (same note as bootstrapSqlite).
async function bootstrapPostgres(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      input JSONB,
      output JSONB,
      error TEXT,
      latency_ms INTEGER,
      framework TEXT,
      model TEXT,
      tool_calls JSONB,
      metadata JSONB,
      session_id TEXT,
      performance_summary JSONB,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      questions JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      judge_prompt TEXT,
      judge_model TEXT,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject JSONB,
      run_source TEXT,
      sdk_info JSONB,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_run_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      batch_id TEXT,
      idempotency_key TEXT NOT NULL,
      case_id TEXT,
      question_index INTEGER,
      run_number INTEGER,
      input JSONB,
      output JSONB,
      error JSONB,
      rating DOUBLE PRECISION,
      justification TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS evaluation_run_results_run_id_idempotency_key
      ON evaluation_run_results (run_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS monitor_patterns (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      detector_kind TEXT NOT NULL DEFAULT 'contains',
      conditions JSONB NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      polarity TEXT NOT NULL DEFAULT 'failure',
      enabled BOOLEAN NOT NULL DEFAULT true,
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids JSONB,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitor_profiles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      failure_detection_enabled BOOLEAN NOT NULL DEFAULT true,
      info_detection_enabled BOOLEAN NOT NULL DEFAULT true,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      redaction_mode TEXT NOT NULL DEFAULT 'standard',
      threshold_overrides JSONB,
      approval_policy JSONB,
      channels JSONB,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS monitor_profiles_agent_id ON monitor_profiles (agent_id);

    CREATE TABLE IF NOT EXISTS monitor_signals (
      id TEXT PRIMARY KEY,
      pattern_key TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      polarity TEXT NOT NULL DEFAULT 'failure',
      status TEXT NOT NULL DEFAULT 'open',
      review_status TEXT,
      recommended_actions JSONB,
      summary TEXT NOT NULL,
      root_cause TEXT,
      agent_id TEXT,
      trace_id TEXT,
      evidence JSONB,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMP NOT NULL,
      last_seen_at TIMESTAMP NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS monitor_signals_pattern_key_agent_id
      ON monitor_signals (pattern_key, agent_id);

    CREATE TABLE IF NOT EXISTS monitor_signal_feedback (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      original_score DOUBLE PRECISION,
      corrected_score DOUBLE PRECISION,
      rationale TEXT NOT NULL,
      queued_for_autotune BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS monitor_events (
      id TEXT PRIMARY KEY,
      signal_id TEXT,
      pattern_key TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      polarity TEXT NOT NULL,
      agent_id TEXT,
      trace_id TEXT,
      created_at TIMESTAMP NOT NULL
    );

    CREATE INDEX IF NOT EXISTS monitor_events_agent_id_created_at ON monitor_events (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS monitor_events_created_at ON monitor_events (created_at);

    -- Postgres supports IF NOT EXISTS on ADD COLUMN natively, unlike SQLite (see
    -- bootstrapSqlite's columnMigrations for the equivalent there), so pre-existing databases
    -- from before these columns existed can just re-run this same statement safely.
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS agent_ids JSONB;
    ALTER TABLE monitor_profiles ADD COLUMN IF NOT EXISTS channels JSONB;
    ALTER TABLE monitor_signals ADD COLUMN IF NOT EXISTS review_status TEXT;
    ALTER TABLE monitor_signals ADD COLUMN IF NOT EXISTS recommended_actions JSONB;
  `);
}
