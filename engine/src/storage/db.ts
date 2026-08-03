/// <reference types="bun-types" />
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import { seedExampleDataIfEmpty } from "../core/seed.js";

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
// The raw handle underneath `cached` (better-sqlite3/bun:sqlite Database or pg Pool) isn't part
// of the `Db` type downstream code sees, but graceful shutdown needs it to flush WAL / release the
// connection cleanly instead of leaving the process to SIGKILL it. Kept module-private, closed via
// closeDb() below.
let closeHandle: (() => void | Promise<void>) | null = null;

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
    closeHandle = () => pool.end();
    await seedPortabilityModelsIfEmpty(cached);
    await seedExampleDataIfEmpty(cached);
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
    closeHandle = () => {
      sqlite.close();
    };
  } else {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { drizzle: drizzleSqlite } = await import("drizzle-orm/better-sqlite3");
    const sqlite = new BetterSqlite3(sqlitePath);
    sqlite.pragma("journal_mode = WAL");
    bootstrapSqlite(sqlite);
    cached = { kind: "sqlite", db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema };
    closeHandle = () => {
      sqlite.close();
    };
  }
  await seedPortabilityModelsIfEmpty(cached);
  await seedExampleDataIfEmpty(cached);
  return cached;
}

// One-time seed, not a permanent hardcoded fallback: Model Portability's candidate models used to
// be a static array (core/evaluate/models.ts) — now a dashboard-editable table
// (portability_models). Only inserts when the table is genuinely empty (a real first boot), using
// drizzle's own cross-dialect query builder rather than hand-rolled conditional SQL across two
// dialects, so a user who later deletes some or all of these never sees them silently reappear on
// the next restart. Prices are approximate/point-in-time — see core/evaluate/models.ts's comment.
const DEFAULT_PORTABILITY_MODELS: Array<{
  id: string;
  provider: "openai" | "anthropic";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
}> = [
  { id: "gpt-4.1", provider: "openai", label: "GPT-4.1", pricePerMInputTokens: 2.0, pricePerMOutputTokens: 8.0 },
  { id: "gpt-4.1-mini", provider: "openai", label: "GPT-4.1 mini", pricePerMInputTokens: 0.4, pricePerMOutputTokens: 1.6 },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", pricePerMInputTokens: 2.5, pricePerMOutputTokens: 10.0 },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini", pricePerMInputTokens: 0.15, pricePerMOutputTokens: 0.6 },
  { id: "claude-opus-4-1", provider: "anthropic", label: "Claude Opus 4.1", pricePerMInputTokens: 15.0, pricePerMOutputTokens: 75.0 },
  { id: "claude-sonnet-4-5", provider: "anthropic", label: "Claude Sonnet 4.5", pricePerMInputTokens: 3.0, pricePerMOutputTokens: 15.0 },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", pricePerMInputTokens: 1.0, pricePerMOutputTokens: 5.0 },
];

async function seedPortabilityModelsIfEmpty(db: Db): Promise<void> {
  const existing =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.portabilityModels).limit(1).all()
      : await db.db.select().from(db.schema.portabilityModels).limit(1);
  if (existing.length > 0) {
    return;
  }
  const now = new Date();
  const rows = DEFAULT_PORTABILITY_MODELS.map(m => ({ ...m, createdAt: now, updatedAt: now }));
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.portabilityModels).values(rows);
  } else {
    await db.db.insert(db.schema.portabilityModels).values(rows);
  }
}

export function getDb(): Db {
  if (!cached) {
    throw new Error("Database not initialized: initDb() must be awaited once at startup before getDb() is called");
  }
  return cached;
}

// Called from index.ts's SIGINT/SIGTERM handler. Flushes SQLite's WAL file / releases the pg pool
// instead of leaving the OS to reclaim the file descriptor when the process is killed outright.
export async function closeDb(): Promise<void> {
  await closeHandle?.();
  cached = null;
  closeHandle = null;
}

function defaultSqlitePath(): string {
  return path.join(AGENTX_HOME, "agentx.db");
}

type SqliteHandle = {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
};

// Hand-written, idempotent bootstrap DDL, so `agentx-server --dev` works out of the box with
// zero setup. Replace with real drizzle-kit migrations (`db:generate` script already wired in
// package.json) once the schema stabilizes, see plan task #107. `exec()`/`prepare()` have the same
// signature on both better-sqlite3's and bun:sqlite's Database, so this one function serves both.
function bootstrapSqlite(sqlite: SqliteHandle): void {
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
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject TEXT,
      version TEXT,
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

    CREATE TABLE IF NOT EXISTS monitor_online_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      evaluation_settings_id TEXT,
      sample_rate REAL NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_prompt_id_version
      ON prompt_versions (prompt_id, version);

    CREATE TABLE IF NOT EXISTS portability_models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      price_per_m_input_tokens REAL NOT NULL,
      price_per_m_output_tokens REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN online_evaluator_id TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN rating REAL"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN justification TEXT"],
    ["evaluation_runs", "ALTER TABLE evaluation_runs ADD COLUMN version TEXT"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN evaluation_settings_id TEXT"],
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

  migrateOnlineEvaluatorsToConfigsSqlite(sqlite);
}

// One-time backfill: online evaluators used to store their own acceptance_criteria/
// rejection_criteria/evaluation_criteria/judge_prompt/judge_model instead of referencing an
// evaluation_settings row (see schema.sqlite.ts's monitorOnlineEvaluators comment). Every row
// created before this migration has evaluation_settings_id NULL but still has its legacy columns
// physically present (added above via columnMigrations, never dropped until this function drops
// them at the end) — read them once, materialize a real evaluation_settings row per evaluator (so
// existing judge criteria aren't lost), point the evaluator at it, then drop the now-unused legacy
// columns. Safe to re-run: the SELECT only matches rows still missing evaluation_settings_id, and
// the DROP COLUMNs are individually guarded the same way columnMigrations above are.
function migrateOnlineEvaluatorsToConfigsSqlite(sqlite: SqliteHandle): void {
  let legacyRows: Array<{
    id: string;
    name: string;
    acceptance_criteria: string | null;
    rejection_criteria: string | null;
    evaluation_criteria: string | null;
    judge_prompt: string | null;
    judge_model: string | null;
  }>;
  try {
    legacyRows = sqlite
      .prepare(
        `SELECT id, name, acceptance_criteria, rejection_criteria, evaluation_criteria, judge_prompt, judge_model
         FROM monitor_online_evaluators WHERE evaluation_settings_id IS NULL`
      )
      .all() as typeof legacyRows;
  } catch {
    // Legacy columns already dropped by a previous run of this migration — nothing left to do.
    legacyRows = [];
  }

  const now = Date.now();
  for (const row of legacyRows) {
    const settingsId = nanoid();
    sqlite
      .prepare(
        `INSERT INTO evaluation_settings
           (id, name, acceptance_criteria, rejection_criteria, evaluation_criteria, judge_prompt, judge_model, is_default, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'published', ?)`
      )
      .run(
        settingsId,
        row.name,
        row.acceptance_criteria,
        row.rejection_criteria,
        row.evaluation_criteria,
        row.judge_prompt,
        row.judge_model,
        now
      );
    sqlite
      .prepare(`UPDATE monitor_online_evaluators SET evaluation_settings_id = ? WHERE id = ?`)
      .run(settingsId, row.id);
  }

  for (const column of ["acceptance_criteria", "rejection_criteria", "evaluation_criteria", "judge_prompt", "judge_model"]) {
    try {
      sqlite.exec(`ALTER TABLE monitor_online_evaluators DROP COLUMN ${column}`);
    } catch (err) {
      if (!(err instanceof Error) || !/no such column/i.test(err.message)) {
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
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject JSONB,
      version TEXT,
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

    CREATE TABLE IF NOT EXISTS monitor_online_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      evaluation_settings_id TEXT,
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids JSONB,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at TIMESTAMP NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_prompt_id_version
      ON prompt_versions (prompt_id, version);

    CREATE TABLE IF NOT EXISTS portability_models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      price_per_m_input_tokens DOUBLE PRECISION NOT NULL,
      price_per_m_output_tokens DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    -- Postgres supports IF NOT EXISTS on ADD COLUMN natively, unlike SQLite (see
    -- bootstrapSqlite's columnMigrations for the equivalent there), so pre-existing databases
    -- from before these columns existed can just re-run this same statement safely.
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS agent_ids JSONB;
    ALTER TABLE monitor_profiles ADD COLUMN IF NOT EXISTS channels JSONB;
    ALTER TABLE monitor_signals ADD COLUMN IF NOT EXISTS review_status TEXT;
    ALTER TABLE monitor_signals ADD COLUMN IF NOT EXISTS recommended_actions JSONB;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS online_evaluator_id TEXT;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS rating DOUBLE PRECISION;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS justification TEXT;
    ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS version TEXT;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS evaluation_settings_id TEXT;
  `);

  await migrateOnlineEvaluatorsToConfigsPostgres(pool);
}

// Postgres mirror of migrateOnlineEvaluatorsToConfigsSqlite above — see that function's comment
// for the full rationale. information_schema check up front since Postgres (unlike SQLite) errors
// immediately on SELECTing a column that's already been dropped by a previous run, rather than
// only erroring on the DROP itself.
async function migrateOnlineEvaluatorsToConfigsPostgres(pool: Pool): Promise<void> {
  const { rows: existingCols } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'monitor_online_evaluators'`
  );
  const legacyColumns = ["acceptance_criteria", "rejection_criteria", "evaluation_criteria", "judge_prompt", "judge_model"];
  const hasLegacyColumns = legacyColumns.some(col => existingCols.some(c => c.column_name === col));

  if (hasLegacyColumns) {
    const { rows: legacyRows } = await pool.query<{
      id: string;
      name: string;
      acceptance_criteria: string | null;
      rejection_criteria: string | null;
      evaluation_criteria: string | null;
      judge_prompt: string | null;
      judge_model: string | null;
    }>(
      `SELECT id, name, acceptance_criteria, rejection_criteria, evaluation_criteria, judge_prompt, judge_model
       FROM monitor_online_evaluators WHERE evaluation_settings_id IS NULL`
    );
    for (const row of legacyRows) {
      const settingsId = nanoid();
      await pool.query(
        `INSERT INTO evaluation_settings
           (id, name, acceptance_criteria, rejection_criteria, evaluation_criteria, judge_prompt, judge_model, is_default, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 'published', NOW())`,
        [settingsId, row.name, row.acceptance_criteria, row.rejection_criteria, row.evaluation_criteria, row.judge_prompt, row.judge_model]
      );
      await pool.query(`UPDATE monitor_online_evaluators SET evaluation_settings_id = $1 WHERE id = $2`, [settingsId, row.id]);
    }
    for (const column of legacyColumns) {
      await pool.query(`ALTER TABLE monitor_online_evaluators DROP COLUMN IF EXISTS ${column}`);
    }
  }
}
