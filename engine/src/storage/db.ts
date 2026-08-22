/// <reference types="bun-types" />
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import { seedExampleDataIfEmpty } from "../core/seed.js";
import { getDefaultProject } from "../core/project/projects.js";

export const AGENTX_HOME = process.env.AGENTX_HOME || path.join(os.homedir(), ".agentx");

// Two dialects, one interface: everything downstream (repositories, routes) talks to `Db`,
// never to `better-sqlite3`/`bun:sqlite`/`pg` directly, so switching AGENTX_DB_URL from unset
// (SQLite) to postgres://... doesn't touch a single line outside this file. Drizzle's query
// builder is shaped compatibly enough between dialects for the simple CRUD this engine does (see
// plan's "core governance logic uses plain CRUD, no aggregation pipelines" finding) that one
// query API covers both: table refs differ (sqliteSchema.traces vs pgSchema.traces) but the
// calling code is otherwise identical.
// projectId: multi-project support (core/project/projects.ts) - every project-scoped query reads
// this off the Db it's given rather than taking a separate parameter, so none of core/'s ~150
// exported functions needed a signature change to become project-aware, only their bodies. getDb()
// below returns the cached singleton with projectId set to "" (see its own comment - a sentinel
// that can never match a real project_id column value, so any code path that forgets to build a
// properly-scoped Db fails closed with empty results, never a cross-project leak). Every
// requireApiKey()-protected route builds a real one via withProjectId(getDb(), req.projectId)
// before calling into anything project-scoped.
export type Db =
  | { kind: "sqlite"; db: BetterSQLite3Database<typeof sqliteSchema>; schema: typeof sqliteSchema; projectId: string }
  | { kind: "postgres"; db: NodePgDatabase<typeof pgSchema>; schema: typeof pgSchema; projectId: string };

export function withProjectId(db: Db, projectId: string): Db {
  return { ...db, projectId } as Db;
}

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
    // "" is a deliberate never-matches-a-real-project sentinel - see the Db type's own comment.
    cached = { kind: "postgres", db: drizzlePg(pool, { schema: pgSchema }), schema: pgSchema, projectId: "" };
    closeHandle = () => pool.end();
    await seedPortabilityModelsIfEmpty(cached);
    await ensureRealWorldPortabilityModels(cached);
    // seedExampleDataIfEmpty writes project-scoped rows (datasets, agents, traces, ...), so it
    // needs a real projectId, not `cached`'s never-matches sentinel (see the Db type's own
    // comment) - backfillDefaultProjectPostgres above already guarantees a default project
    // exists by this point. The `?? cached` fallback is unreachable in practice, kept only so a
    // violated invariant here degrades to today's existing (broken) behavior instead of a new,
    // different crash.
    const defaultProject = await getDefaultProject(cached);
    await seedExampleDataIfEmpty(defaultProject ? withProjectId(cached, defaultProject.id) : cached);
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
      projectId: "",
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
    cached = { kind: "sqlite", db: drizzleSqlite(sqlite, { schema: sqliteSchema }), schema: sqliteSchema, projectId: "" };
    closeHandle = () => {
      sqlite.close();
    };
  }
  await seedPortabilityModelsIfEmpty(cached);
  await ensureRealWorldPortabilityModels(cached);
  // See the postgres branch above for why this needs a real projectId, not `cached` directly.
  const defaultProject = await getDefaultProject(cached);
  await seedExampleDataIfEmpty(defaultProject ? withProjectId(cached, defaultProject.id) : cached);
  return cached;
}

// One-time seed, not a permanent hardcoded fallback: Model Portability's candidate models used to
// be a static array (core/evaluate/models.ts) - now a dashboard-editable table
// (portability_models). Only inserts when the table is genuinely empty (a real first boot), using
// drizzle's own cross-dialect query builder rather than hand-rolled conditional SQL across two
// dialects, so a user who later deletes some or all of these never sees them silently reappear on
// the next restart. Prices are approximate/point-in-time - see core/evaluate/models.ts's comment.
// Current as of Aug 2026 - verified against platform.openai.com/docs/models and
// platform.claude.com's models overview at the time this list was last updated. Model lineups
// move fast; re-check both providers' docs before trusting this list again in a few months.
// Cache-rate ratios below follow each provider's actual published prompt-caching discount policy
// (Anthropic: cache write ≈ 1.25x input, cache read ≈ 0.1x input; OpenAI: cached input ≈ 0.5x
// input, no separate cache-write concept) applied against each row's own (fictional) input price -
// see core/evaluate/models.ts's estimateCostUSD for how these are used.
const DEFAULT_PORTABILITY_MODELS: Array<{
  id: string;
  provider: "openai" | "anthropic" | "gemini";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  pricePerMCacheReadTokens?: number;
  pricePerMCacheWriteTokens?: number;
  isDefault?: boolean;
}> = [
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol", pricePerMInputTokens: 5.0, pricePerMOutputTokens: 30.0, pricePerMCacheReadTokens: 2.5 },
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra", pricePerMInputTokens: 2.0, pricePerMOutputTokens: 12.0, pricePerMCacheReadTokens: 1.0 },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna", pricePerMInputTokens: 0.2, pricePerMOutputTokens: 1.2, pricePerMCacheReadTokens: 0.1 },
  { id: "claude-fable-5", provider: "anthropic", label: "Claude Fable 5", pricePerMInputTokens: 10.0, pricePerMOutputTokens: 50.0, pricePerMCacheReadTokens: 1.0, pricePerMCacheWriteTokens: 12.5 },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", pricePerMInputTokens: 5.0, pricePerMOutputTokens: 25.0, pricePerMCacheReadTokens: 0.5, pricePerMCacheWriteTokens: 6.25 },
  // Default judge model: strong quality/cost balance, far cheaper than Fable 5/Opus 5 - good
  // enough to be everyone's first pick for evaluating another agent's responses.
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    pricePerMInputTokens: 3.0,
    pricePerMOutputTokens: 15.0,
    pricePerMCacheReadTokens: 0.3,
    pricePerMCacheWriteTokens: 3.75,
    isDefault: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    pricePerMInputTokens: 1.0,
    pricePerMOutputTokens: 5.0,
    pricePerMCacheReadTokens: 0.1,
    pricePerMCacheWriteTokens: 1.25,
  },
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

// gpt-4o-mini specifically: the most commonly traced real model in the SDK's own demo scripts
// (02_trace_your_agent.py and friends) and any bring-your-own-agent usage, so it having no price
// in the catalog above - Overview's "Total LLM cost" silently showing $0/empty for real traced
// usage - is a near-guaranteed first impression, not an edge case. Ensured separately from
// seedPortabilityModelsIfEmpty above (which only ever runs once, on a genuinely empty table) so
// this also retroactively fixes an install that already seeded the fictional catalog before this
// was added - inserted only if this specific id is missing, never touches a price the user
// already edited or a row they deliberately deleted.
const REAL_WORLD_MODELS_TO_ENSURE: Array<{
  id: string;
  provider: "openai" | "anthropic" | "gemini";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  pricePerMCacheReadTokens?: number;
}> = [
  {
    id: "gpt-4o-mini",
    provider: "openai",
    label: "GPT-4o mini",
    pricePerMInputTokens: 0.15,
    pricePerMOutputTokens: 0.6,
    // Real published OpenAI cached-input rate: ~half the regular input price.
    pricePerMCacheReadTokens: 0.075,
  },
  // Real published Google list pricing (<=200k context tier) as of Gemini support landing here -
  // same "verify against the provider's current pricing page" caveat as every other row above.
  {
    id: "gemini-2.5-pro",
    provider: "gemini",
    label: "Gemini 2.5 Pro",
    pricePerMInputTokens: 1.25,
    pricePerMOutputTokens: 10.0,
    pricePerMCacheReadTokens: 0.31,
  },
  {
    id: "gemini-2.5-flash",
    provider: "gemini",
    label: "Gemini 2.5 Flash",
    pricePerMInputTokens: 0.3,
    pricePerMOutputTokens: 2.5,
    pricePerMCacheReadTokens: 0.075,
  },
];

async function ensureRealWorldPortabilityModels(db: Db): Promise<void> {
  const now = new Date();
  for (const model of REAL_WORLD_MODELS_TO_ENSURE) {
    const existing =
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, model.id)).limit(1).all()
        : await db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, model.id)).limit(1);
    if (existing.length > 0) {
      continue;
    }
    const row = { ...model, isDefault: false, createdAt: now, updatedAt: now };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.portabilityModels).values(row);
    } else {
      await db.db.insert(db.schema.portabilityModels).values(row);
    }
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

// Created at the END of bootstrap, not inline with the CREATE TABLEs that own them. All three key
// on project_id, and on a pre-existing (pre-multi-project) install those tables already exist, so
// CREATE TABLE IF NOT EXISTS no-ops and project_id only arrives via the ALTER TABLEs further down.
// Creating these indexes any earlier fails the entire boot with "no such column: project_id" - a
// fresh install never noticed, because there the CREATE TABLE really does run first.
const PROJECT_SCOPED_UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS monitor_profiles_agent_id ON monitor_profiles (project_id, agent_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS monitor_signals_pattern_key_agent_id ON monitor_signals (project_id, pattern_key, agent_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_prompt_id_version ON prompt_versions (project_id, prompt_id, version)`,
];

// Same posture as ensureVersionUnique below: an install that somehow already collected duplicate
// rows keeps booting (degraded, without the constraint) rather than being bricked at startup.
function ensureProjectScopedUniqueIndexes(exec: (statement: string) => void): void {
  for (const statement of PROJECT_SCOPED_UNIQUE_INDEXES) {
    try {
      exec(statement);
    } catch (err) {
      console.warn(
        `Could not create the unique index from \`${statement}\`: ${err instanceof Error ? err.message : String(err)}\n` +
          `  This usually means duplicate rows already exist for that key.`
      );
    }
  }
}

function bootstrapSqlite(sqlite: SqliteHandle): void {
  // CREATE UNIQUE INDEX IF NOT EXISTS only checks the index *name* - on a pre-existing install
  // that already created these 3 with their old (pre-multi-project) column sets, the IF NOT
  // EXISTS in ensureProjectScopedUniqueIndexes (run at the end of this function) would otherwise
  // silently no-op and leave the old, narrower uniqueness constraint in place. Dropping first
  // makes that recreation actually pick up project_id. Cheap/no-op safe to run every boot (small
  // dev-scale indexes).
  sqlite.exec(`
    DROP INDEX IF EXISTS monitor_profiles_agent_id;
    DROP INDEX IF EXISTS monitor_signals_pattern_key_agent_id;
    DROP INDEX IF EXISTS prompt_versions_prompt_id_version;
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate REAL NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      latency_threshold_ms INTEGER NOT NULL DEFAULT 20000,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_api_key ON projects (api_key);

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
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      span_id TEXT,
      parent_span_id TEXT,
      started_at INTEGER,
      created_at INTEGER NOT NULL,
      agent_id TEXT,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS agents_name ON agents (name);

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      number_of_requests INTEGER NOT NULL DEFAULT 1,
      similarity_config TEXT,
      code_scorers TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      questions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      number_of_requests INTEGER NOT NULL DEFAULT 1,
      similarity_config TEXT,
      code_scorers TEXT,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      judge_prompt TEXT,
      judge_model TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject TEXT,
      version TEXT,
      run_source TEXT,
      sdk_info TEXT,
      smoke_test_variants TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at INTEGER NOT NULL,
      project_id TEXT
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
      trace_id TEXT,
      is_smoke_test_variant INTEGER NOT NULL DEFAULT 0,
      smoke_test_variant_text TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      vector_similarity REAL,
      jaccard_similarity REAL,
      bleu_score REAL,
      rouge_score REAL,
      code_scorer_results TEXT,
      rating REAL,
      justification TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS evaluation_run_results_run_id_idempotency_key
      ON evaluation_run_results (run_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS dataset_versions (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      change_summary TEXT,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings_versions (
      id TEXT PRIMARY KEY,
      evaluation_settings_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      change_summary TEXT,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS playground_runs (
      id TEXT PRIMARY KEY,
      snapshot TEXT NOT NULL,
      results TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT,
      prompt_id TEXT
    );

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
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_profiles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      failure_detection_enabled INTEGER NOT NULL DEFAULT 1,
      info_detection_enabled INTEGER NOT NULL DEFAULT 1,
      topics_enabled INTEGER NOT NULL DEFAULT 0,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate REAL NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      threshold_overrides TEXT,
      approval_policy TEXT,
      channels TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT
    );

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
      last_seen_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_signal_feedback (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      event_id TEXT,
      metric TEXT NOT NULL,
      original_score REAL,
      corrected_score REAL,
      rationale TEXT NOT NULL,
      queued_for_autotune INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT
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
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE INDEX IF NOT EXISTS monitor_events_agent_id_created_at ON monitor_events (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS monitor_events_created_at ON monitor_events (created_at);

    CREATE TABLE IF NOT EXISTS monitor_classifications (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      agent_id TEXT,
      intent TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_id TEXT,
      embedding TEXT
    );

    CREATE INDEX IF NOT EXISTS monitor_classifications_created_at ON monitor_classifications (created_at);

    CREATE TABLE IF NOT EXISTS monitor_online_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      evaluation_settings_id TEXT,
      sample_rate REAL NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- NULL means "never raise a Signal for a low score", distinct from 0 (raise below any
      -- score including 0).
      alert_threshold REAL DEFAULT 5,
      severity TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS custom_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      sample_rate REAL NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      invert_match INTEGER NOT NULL DEFAULT 0,
      severity TEXT NOT NULL DEFAULT 'medium',
      kind TEXT NOT NULL DEFAULT 'external',
      language TEXT,
      script TEXT,
      alert_below REAL,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      headers TEXT,
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS outcome_reports (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      evaluation_run_result_id TEXT,
      outcome TEXT NOT NULL,
      is_negative INTEGER NOT NULL,
      reason TEXT,
      reported_by TEXT,
      reported_at INTEGER NOT NULL,
      project_id TEXT
    );


    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      comment TEXT,
      end_user_id TEXT,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );


    CREATE TABLE IF NOT EXISTS improvement_proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      current_text TEXT NOT NULL,
      proposal TEXT NOT NULL,
      validation TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      model TEXT,
      organization_id TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_events_created_at ON usage_events (created_at);

    CREATE TABLE IF NOT EXISTS gate_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      passed INTEGER NOT NULL,
      average_rating REAL,
      baseline_run_id TEXT,
      baseline_average REAL,
      checks TEXT,
      caller TEXT,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS session_scores (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      rating REAL,
      justification TEXT,
      drift_span_id TEXT,
      span_count INTEGER NOT NULL,
      judge_model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sweep_leases (
      name TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      summary TEXT,
      ip TEXT,
      project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events (created_at);

    CREATE TABLE IF NOT EXISTS tool_schemas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_schema_versions (
      id TEXT PRIMARY KEY,
      tool_schema_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS portability_models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      price_per_m_input_tokens REAL NOT NULL,
      price_per_m_output_tokens REAL NOT NULL,
      price_per_m_cache_read_tokens REAL,
      price_per_m_cache_write_tokens REAL,
      is_default INTEGER NOT NULL DEFAULT 0,
      base_url TEXT,
      api_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_analyses (
      evaluation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      judge_model TEXT NOT NULL,
      judge_models TEXT,
      analysis TEXT,
      statistics TEXT,
      judge_evidence TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      openai_api_key TEXT,
      anthropic_api_key TEXT,
      gemini_api_key TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL,
      active_organization_id TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_account (
      id TEXT PRIMARY KEY,
      issuer TEXT,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS auth_organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      logo TEXT,
      created_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_member (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_invitation (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      inviter_id TEXT NOT NULL
    );
  `);

  // Columns added after the tables above already shipped: CREATE TABLE IF NOT EXISTS doesn't
  // retrofit existing databases, so anyone with a pre-existing ~/.agentx/agentx.db needs these
  // added explicitly. SQLite has no ADD COLUMN IF NOT EXISTS, so each is tried individually and a
  // "duplicate column" failure (already applied) is swallowed; anything else rethrows.
  const columnMigrations: Array<[string, string]> = [
    // better-auth 1.7 added `issuer` to its account model and `created_at` to invitations; the
    // hand-written tables above predate it, and without these an install that upgrades
    // better-auth 500s on every single sign-up (see the backfill below).
    ["auth_account", "ALTER TABLE auth_account ADD COLUMN issuer TEXT"],
    ["auth_invitation", "ALTER TABLE auth_invitation ADD COLUMN created_at INTEGER"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN sample_rate REAL NOT NULL DEFAULT 1"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'all'"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN agent_ids TEXT"],
    ["monitor_profiles", "ALTER TABLE monitor_profiles ADD COLUMN channels TEXT"],
    ["monitor_signals", "ALTER TABLE monitor_signals ADD COLUMN review_status TEXT"],
    ["monitor_signals", "ALTER TABLE monitor_signals ADD COLUMN recommended_actions TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN online_evaluator_id TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN rating REAL"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN justification TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN custom_evaluator_id TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN matched INTEGER"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN score REAL"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN session_id TEXT"],
    ["evaluation_runs", "ALTER TABLE evaluation_runs ADD COLUMN version TEXT"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN evaluation_settings_id TEXT"],
    // Existing rows backfill to 5 (the same default a fresh evaluator gets) rather than NULL, so
    // upgrading a self-host install doesn't silently turn off the new Signals integration for
    // evaluators created before this shipped; NULL remains available going forward as the
    // explicit "never raise a Signal for this evaluator" opt-out.
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN alert_threshold REAL DEFAULT 5"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN severity TEXT NOT NULL DEFAULT 'medium'"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN trace_id TEXT"],
    ["datasets", "ALTER TABLE datasets ADD COLUMN number_of_requests INTEGER NOT NULL DEFAULT 1"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN number_of_requests INTEGER NOT NULL DEFAULT 1"],
    ["evaluation_runs", "ALTER TABLE evaluation_runs ADD COLUMN smoke_test_variants TEXT"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN is_smoke_test_variant INTEGER NOT NULL DEFAULT 0"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN smoke_test_variant_text TEXT"],
    ["datasets", "ALTER TABLE datasets ADD COLUMN similarity_config TEXT"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN similarity_config TEXT"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN vector_similarity REAL"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN jaccard_similarity REAL"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN bleu_score REAL"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN rouge_score REAL"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN latency_ms INTEGER"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN input_tokens INTEGER"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN output_tokens INTEGER"],
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0"],
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN organization_id TEXT"],
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN base_url TEXT"],
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN api_key TEXT"],
    ["evaluation_analyses", "ALTER TABLE evaluation_analyses ADD COLUMN judge_models TEXT"],
    ["monitor_signal_feedback", "ALTER TABLE monitor_signal_feedback ADD COLUMN event_id TEXT"],
    ["monitor_profiles", "ALTER TABLE monitor_profiles ADD COLUMN topics_enabled INTEGER NOT NULL DEFAULT 0"],
    ["traces", "ALTER TABLE traces ADD COLUMN span_id TEXT"],
    ["traces", "ALTER TABLE traces ADD COLUMN parent_span_id TEXT"],
    ["traces", "ALTER TABLE traces ADD COLUMN started_at INTEGER"],
    ["datasets", "ALTER TABLE datasets ADD COLUMN code_scorers TEXT"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN code_scorers TEXT"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN code_scorer_results TEXT"],
    ["traces", "ALTER TABLE traces ADD COLUMN agent_id TEXT"],
    // Multi-project support (core/project/projects.ts): every project-scoped table gets a
    // project_id column, backfilled to one auto-created "Default" project by
    // backfillDefaultProjectSqlite below - see that function's comment for why portability_models/
    // app_settings are deliberately excluded from this list (they stay instance-wide).
    ["traces", "ALTER TABLE traces ADD COLUMN project_id TEXT"],
    ["agents", "ALTER TABLE agents ADD COLUMN project_id TEXT"],
    ["datasets", "ALTER TABLE datasets ADD COLUMN project_id TEXT"],
    ["evaluation_settings", "ALTER TABLE evaluation_settings ADD COLUMN project_id TEXT"],
    ["evaluation_runs", "ALTER TABLE evaluation_runs ADD COLUMN project_id TEXT"],
    ["evaluation_run_results", "ALTER TABLE evaluation_run_results ADD COLUMN project_id TEXT"],
    ["dataset_versions", "ALTER TABLE dataset_versions ADD COLUMN project_id TEXT"],
    ["evaluation_settings_versions", "ALTER TABLE evaluation_settings_versions ADD COLUMN project_id TEXT"],
    ["playground_runs", "ALTER TABLE playground_runs ADD COLUMN project_id TEXT"],
    // Ties a Playground session back to the prompt it was testing, so a human review left on a
    // cell can become evidence for that prompt's improvement pipeline (core/evaluate/prompts.ts's
    // gatherPlaygroundExamples). Null for a promptless session.
    ["playground_runs", "ALTER TABLE playground_runs ADD COLUMN prompt_id TEXT"],
    ["monitor_patterns", "ALTER TABLE monitor_patterns ADD COLUMN project_id TEXT"],
    ["monitor_profiles", "ALTER TABLE monitor_profiles ADD COLUMN project_id TEXT"],
    ["monitor_signals", "ALTER TABLE monitor_signals ADD COLUMN project_id TEXT"],
    ["monitor_signal_feedback", "ALTER TABLE monitor_signal_feedback ADD COLUMN project_id TEXT"],
    ["monitor_events", "ALTER TABLE monitor_events ADD COLUMN project_id TEXT"],
    ["monitor_classifications", "ALTER TABLE monitor_classifications ADD COLUMN project_id TEXT"],
    // Topics "Map" view (core/monitor/topics.ts's getTopicsMap) - a JSON-encoded embedding vector
    // per classification, used for UMAP projection. Null for rows classified before this existed.
    ["monitor_classifications", "ALTER TABLE monitor_classifications ADD COLUMN embedding TEXT"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN project_id TEXT"],
    ["prompts", "ALTER TABLE prompts ADD COLUMN project_id TEXT"],
    ["prompt_versions", "ALTER TABLE prompt_versions ADD COLUMN project_id TEXT"],
    ["evaluation_analyses", "ALTER TABLE evaluation_analyses ADD COLUMN project_id TEXT"],
    ["projects", "ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0"],
    ["projects", "ALTER TABLE projects ADD COLUMN coverage_mode TEXT NOT NULL DEFAULT 'all'"],
    ["projects", "ALTER TABLE projects ADD COLUMN sample_rate REAL NOT NULL DEFAULT 1"],
    ["projects", "ALTER TABLE projects ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30"],
    ["projects", "ALTER TABLE projects ADD COLUMN latency_threshold_ms INTEGER NOT NULL DEFAULT 20000"],
    // Prompt-caching token counts (core/trace/ingest.ts's ingestTraceSchema) - subsets of
    // input_tokens, priced separately by estimateCostUSD when configured.
    ["traces", "ALTER TABLE traces ADD COLUMN cache_read_tokens INTEGER"],
    ["traces", "ALTER TABLE traces ADD COLUMN cache_write_tokens INTEGER"],
    // Per-model cache-token pricing (core/evaluate/models.ts's estimateCostUSD) - null means "not
    // configured," falls back to price_per_m_input_tokens for that token type.
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN price_per_m_cache_read_tokens REAL"],
    ["portability_models", "ALTER TABLE portability_models ADD COLUMN price_per_m_cache_write_tokens REAL"],
    ["app_settings", "ALTER TABLE app_settings ADD COLUMN gemini_api_key TEXT"],
    ["outcome_reports", "ALTER TABLE outcome_reports ADD COLUMN is_negative INTEGER NOT NULL DEFAULT 0"],
    ["projects", "ALTER TABLE projects ADD COLUMN topics_enabled INTEGER NOT NULL DEFAULT 0"],
    ["projects", "ALTER TABLE projects ADD COLUMN coherence_sweep_enabled INTEGER NOT NULL DEFAULT 1"],
    ["projects", "ALTER TABLE projects ADD COLUMN disabled_builtin_patterns TEXT"],
    // Scorer opt-in flip: built-ins used to be on-by-default with a disabled list; now nothing
    // runs unless listed here. The old column is left in place (ignored) rather than migrated -
    // "everything starts off" is the intended posture for existing installs too.
    ["projects", "ALTER TABLE projects ADD COLUMN enabled_builtin_patterns TEXT"],
    // Code scorers: a second custom-scorer kind (user script run in-engine) next to the original
    // HTTP-endpoint kind, now called "external".
    ["custom_evaluators", "ALTER TABLE custom_evaluators ADD COLUMN kind TEXT NOT NULL DEFAULT 'external'"],
    ["custom_evaluators", "ALTER TABLE custom_evaluators ADD COLUMN language TEXT"],
    ["custom_evaluators", "ALTER TABLE custom_evaluators ADD COLUMN script TEXT"],
    ["custom_evaluators", "ALTER TABLE custom_evaluators ADD COLUMN alert_below REAL"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN scope TEXT NOT NULL DEFAULT 'trace'"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN idle_seconds INTEGER NOT NULL DEFAULT 120"],
    ["monitor_online_evaluators", "ALTER TABLE monitor_online_evaluators ADD COLUMN builtin_key TEXT"],
    ["session_scores", "ALTER TABLE session_scores ADD COLUMN findings TEXT"],
    ["projects", "ALTER TABLE projects ADD COLUMN organization_id TEXT"],
    ["app_settings", "ALTER TABLE app_settings ADD COLUMN auth_secret TEXT"],
    ["app_settings", "ALTER TABLE app_settings ADD COLUMN metric_pack_seeded_at INTEGER"],
    ["app_settings", "ALTER TABLE app_settings ADD COLUMN metric_pack_version INTEGER"],
    ["tool_schemas", "ALTER TABLE tool_schemas ADD COLUMN test_endpoint_url TEXT"],
    ["tool_schemas", "ALTER TABLE tool_schemas ADD COLUMN resolved_evidence TEXT"],
    ["playground_runs", "ALTER TABLE playground_runs ADD COLUMN kind TEXT"],
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

  ensureTraceSpanIdUnique(statement => sqlite.exec(statement));
  ensureVersionUnique(statement => sqlite.exec(statement));
  sqlite.exec(BACKFILL_AUTH_ACCOUNT_ISSUER);

  migrateOnlineEvaluatorsToConfigsSqlite(sqlite);
  backfillAgentsSqlite(sqlite);
  backfillDefaultProjectSqlite(sqlite);

  // One-way Topics migration: the toggle moved from per-agent monitor_profiles.topics_enabled to
  // project-level projects.topics_enabled. Copy "any agent had it on" up to the project, then
  // clear the profile flags so this can safely run every boot: without the clear, a user turning
  // the project-level toggle OFF would have it silently re-enabled on the next restart by the
  // same stale profile rows.
  sqlite.exec(`
    UPDATE projects SET topics_enabled = 1 WHERE id IN (
      SELECT DISTINCT project_id FROM monitor_profiles WHERE topics_enabled = 1 AND project_id IS NOT NULL
    );
    UPDATE monitor_profiles SET topics_enabled = 0 WHERE topics_enabled = 1;
  `);

  ensureProjectScopedUniqueIndexes(statement => sqlite.exec(statement));
}

// prompt_versions has had this index since it shipped; tool_schema_versions never got the
// matching one. Version numbers on both are derived (read currentVersion, add one), so two
// publishes racing produce the same number - and without the index the tool-schema history just
// ends up with two different definitions both calling themselves v4, silently.
const TOOL_SCHEMA_VERSION_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS tool_schema_versions_tool_schema_id_version ON tool_schema_versions (project_id, tool_schema_id, version)`;

// Same posture as the traces index above: an install that already collected duplicates keeps
// booting, with the query to find them.
function warnVersionIndexFailed(err: unknown): void {
  console.warn(
    `Could not create the tool_schema_versions(project_id, tool_schema_id, version) unique index: ${err instanceof Error ? err.message : String(err)}\n` +
      `  This usually means duplicate version numbers already exist. Find them with:\n` +
      `    SELECT project_id, tool_schema_id, version, count(*) FROM tool_schema_versions\n` +
      `    GROUP BY project_id, tool_schema_id, version HAVING count(*) > 1;`
  );
}

function ensureVersionUnique(exec: (statement: string) => void): void {
  try {
    exec(TOOL_SCHEMA_VERSION_INDEX);
  } catch (err) {
    warnVersionIndexFailed(err);
  }
}

async function ensureVersionUniqueAsync(exec: (statement: string) => Promise<void>): Promise<void> {
  try {
    await exec(TOOL_SCHEMA_VERSION_INDEX);
  } catch (err) {
    warnVersionIndexFailed(err);
  }
}

// Accounts written before better-auth 1.7 have no issuer, and 1.7 looks accounts up scoped by it -
// so without this an existing user's password silently stops working on upgrade. Every account
// here is local email/password, which better-auth spells "local:<providerId>".
const BACKFILL_AUTH_ACCOUNT_ISSUER = `UPDATE auth_account SET issuer = 'local:' || provider_id WHERE issuer IS NULL`;

// ingestTrace has always assumed span_id is unique within a project - it just never said so to
// the database. That held on SQLite by accident (better-sqlite3 is synchronous, so its existence
// check and INSERT never interleave); on Postgres ten concurrent replays of one span all passed
// the check and all inserted, billing ten sets of monitor and judge calls for one interaction.
// NULL span_ids - most traces - are exempt for free: NULL never equals NULL in a unique index.
const TRACE_SPAN_ID_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS traces_project_id_span_id ON traces (project_id, span_id)`;

// An install that already accumulated duplicates cannot create the index until they are cleaned
// up. That is the operator's data, so warn with the query rather than deleting rows for them.
function warnTraceSpanIdIndexFailed(err: unknown): void {
  console.warn(
    `Could not create the traces(project_id, span_id) unique index: ${err instanceof Error ? err.message : String(err)}\n` +
      `  This usually means duplicate spans already exist. Find them with:\n` +
      `    SELECT project_id, span_id, count(*) FROM traces WHERE span_id IS NOT NULL\n` +
      `    GROUP BY project_id, span_id HAVING count(*) > 1;\n` +
      `  Ingestion still works; concurrent replays of the same span may duplicate until it is resolved.`
  );
}

function ensureTraceSpanIdUnique(exec: (statement: string) => void): void {
  try {
    exec(TRACE_SPAN_ID_INDEX);
  } catch (err) {
    warnTraceSpanIdIndexFailed(err);
  }
}

async function ensureTraceSpanIdUniqueAsync(exec: (statement: string) => Promise<void>): Promise<void> {
  try {
    await exec(TRACE_SPAN_ID_INDEX);
  } catch (err) {
    warnTraceSpanIdIndexFailed(err);
  }
}

// One-time backfill: online evaluators used to store their own acceptance_criteria/
// rejection_criteria/evaluation_criteria/judge_prompt/judge_model instead of referencing an
// evaluation_settings row (see schema.sqlite.ts's monitorOnlineEvaluators comment). Every row
// created before this migration has evaluation_settings_id NULL but still has its legacy columns
// physically present (added above via columnMigrations, never dropped until this function drops
// them at the end) - read them once, materialize a real evaluation_settings row per evaluator (so
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
    // Legacy columns already dropped by a previous run of this migration - nothing left to do.
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

// One-time backfill for self-host's real agent registry (core/monitor/agents.ts): before this,
// "agentId" everywhere (monitor_profiles/signals/events/classifications.agent_id,
// monitor_patterns/monitor_online_evaluators.agent_ids) was literally the trace's `name` string -
// there was no agents table. This seeds one `agents` row per distinct historical trace name
// (skipped if a row with that name already exists, so a second run adds nothing new), backfills
// the brand-new `traces.agent_id` column (guarded by `agent_id IS NULL`, a clean "not yet
// migrated" signal since the column didn't exist before), then rewrites every other table's
// agentId value(s) from the raw name string to that agent's real id - but only when the stored
// value still matches a known *name*; a value that doesn't match any name is either already a
// real id from a prior run of this migration or an orphaned reference, left untouched either way.
// Nanoid-generated ids and human-typed names essentially never collide, so that check is a safe,
// idempotent proxy for "already migrated" without needing a separate migration-version marker.
function backfillAgentsSqlite(sqlite: SqliteHandle): void {
  // Root spans only, both here and in the pending-traces backfill below: a child span's name is a
  // STEP label ("LLM Call 1", "search_orders"), not an agent identity - seeding agents from child
  // names polluted the registry, and because ingestTrace deliberately leaves child spans'
  // agent_id NULL, every boot re-interpreted those NULLs as "not yet migrated" and stamped them
  // with the fake agents. The corrective UPDATE un-stamps rows previous boots already polluted.
  sqlite.exec(`UPDATE traces SET agent_id = NULL WHERE parent_span_id IS NOT NULL AND agent_id IS NOT NULL`);
  // GC the registry rows this bug created: an "agent" whose name only ever appears as a CHILD
  // span name (never a root), with nothing referencing it - real agents (including explicitly
  // registered idle ones, which have no trace rows at all) can't match this shape.
  sqlite.exec(`DELETE FROM agents WHERE
    EXISTS (SELECT 1 FROM traces t WHERE t.name = agents.name AND t.parent_span_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM traces t WHERE t.name = agents.name AND t.parent_span_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM monitor_profiles mp WHERE mp.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_signals ms WHERE ms.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_events me WHERE me.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_classifications mc WHERE mc.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_patterns pat WHERE pat.agent_ids LIKE '%' || agents.id || '%')
    AND NOT EXISTS (SELECT 1 FROM monitor_online_evaluators ev WHERE ev.agent_ids LIKE '%' || agents.id || '%')`);
  const distinctNames = sqlite
    .prepare(`SELECT DISTINCT name FROM traces WHERE parent_span_id IS NULL`)
    .all() as { name: string }[];

  const nameToId = new Map<string, string>();
  for (const existing of sqlite.prepare(`SELECT id, name FROM agents`).all() as { id: string; name: string }[]) {
    if (!nameToId.has(existing.name)) {
      nameToId.set(existing.name, existing.id);
    }
  }

  const now = Date.now();
  for (const { name } of distinctNames) {
    if (nameToId.has(name)) {
      continue;
    }
    const id = nanoid();
    sqlite.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, now);
    nameToId.set(name, id);
  }

  if (nameToId.size === 0) {
    return;
  }

  const pendingTraces = sqlite
    .prepare(`SELECT id, name FROM traces WHERE agent_id IS NULL AND parent_span_id IS NULL`)
    .all() as {
    id: string;
    name: string;
  }[];
  for (const trace of pendingTraces) {
    const agentId = nameToId.get(trace.name);
    if (agentId) {
      sqlite.prepare(`UPDATE traces SET agent_id = ? WHERE id = ?`).run(agentId, trace.id);
    }
  }

  const singleValueTargets: Array<[string, string]> = [
    ["monitor_profiles", "agent_id"],
    ["monitor_signals", "agent_id"],
    ["monitor_events", "agent_id"],
    ["monitor_classifications", "agent_id"],
  ];
  for (const [table, column] of singleValueTargets) {
    const rows = sqlite.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as {
      id: string;
      value: string;
    }[];
    for (const row of rows) {
      const agentId = nameToId.get(row.value);
      if (agentId) {
        sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(agentId, row.id);
      }
    }
  }

  const arrayTargets: Array<[string, string]> = [
    ["monitor_patterns", "agent_ids"],
    ["monitor_online_evaluators", "agent_ids"],
  ];
  for (const [table, column] of arrayTargets) {
    const rows = sqlite.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as {
      id: string;
      value: string;
    }[];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) {
        continue;
      }
      const rewritten = parsed.map(entry => (typeof entry === "string" ? (nameToId.get(entry) ?? entry) : entry));
      sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(rewritten), row.id);
    }
  }
}

// Postgres mirror of bootstrapSqlite above: same tables, same idempotent "IF NOT EXISTS"
// approach, Postgres column types (JSONB instead of TEXT-as-JSON, TIMESTAMP instead of an
// INTEGER epoch, BOOLEAN instead of INTEGER 0/1, DOUBLE PRECISION instead of REAL) matching
// schema.pg.ts. Replace with real drizzle-kit migrations once the schema stabilizes, see plan
// task #107 (same note as bootstrapSqlite).
async function bootstrapPostgres(pool: Pool): Promise<void> {
  // See bootstrapSqlite's identical comment: CREATE UNIQUE INDEX IF NOT EXISTS only checks the
  // index name, so a pre-existing install's old (pre-multi-project) column set would otherwise
  // silently survive. Drop first so the recreation below actually picks up project_id.
  await pool.query(`
    DROP INDEX IF EXISTS monitor_profiles_agent_id;
    DROP INDEX IF EXISTS monitor_signals_pattern_key_agent_id;
    DROP INDEX IF EXISTS prompt_versions_prompt_id_version;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      latency_threshold_ms INTEGER NOT NULL DEFAULT 20000,
      created_at TIMESTAMP NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_api_key ON projects (api_key);

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
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      span_id TEXT,
      parent_span_id TEXT,
      started_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL,
      agent_id TEXT,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS agents_name ON agents (name);

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      number_of_requests INTEGER NOT NULL DEFAULT 1,
      similarity_config JSONB,
      code_scorers JSONB,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      questions JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      number_of_requests INTEGER NOT NULL DEFAULT 1,
      similarity_config JSONB,
      code_scorers JSONB,
      acceptance_criteria TEXT,
      rejection_criteria TEXT,
      evaluation_criteria TEXT,
      judge_prompt TEXT,
      judge_model TEXT,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      evaluation_settings_id TEXT,
      evaluation_subject JSONB,
      version TEXT,
      run_source TEXT,
      sdk_info JSONB,
      smoke_test_variants JSONB,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
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
      trace_id TEXT,
      is_smoke_test_variant BOOLEAN NOT NULL DEFAULT FALSE,
      smoke_test_variant_text TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      vector_similarity DOUBLE PRECISION,
      jaccard_similarity DOUBLE PRECISION,
      bleu_score DOUBLE PRECISION,
      rouge_score DOUBLE PRECISION,
      code_scorer_results JSONB,
      rating DOUBLE PRECISION,
      justification TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS evaluation_run_results_run_id_idempotency_key
      ON evaluation_run_results (run_id, idempotency_key);

    CREATE TABLE IF NOT EXISTS dataset_versions (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      change_summary TEXT,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_settings_versions (
      id TEXT PRIMARY KEY,
      evaluation_settings_id TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      change_summary TEXT,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS playground_runs (
      id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      results JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      project_id TEXT,
      prompt_id TEXT
    );

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
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_profiles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      failure_detection_enabled BOOLEAN NOT NULL DEFAULT true,
      info_detection_enabled BOOLEAN NOT NULL DEFAULT true,
      topics_enabled BOOLEAN NOT NULL DEFAULT false,
      coverage_mode TEXT NOT NULL DEFAULT 'all',
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      threshold_overrides JSONB,
      approval_policy JSONB,
      channels JSONB,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

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
      last_seen_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_signal_feedback (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      event_id TEXT,
      metric TEXT NOT NULL,
      original_score DOUBLE PRECISION,
      corrected_score DOUBLE PRECISION,
      rationale TEXT NOT NULL,
      queued_for_autotune BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      project_id TEXT
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
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE INDEX IF NOT EXISTS monitor_events_agent_id_created_at ON monitor_events (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS monitor_events_created_at ON monitor_events (created_at);

    CREATE TABLE IF NOT EXISTS monitor_classifications (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      agent_id TEXT,
      intent TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT,
      embedding JSONB
    );

    CREATE INDEX IF NOT EXISTS monitor_classifications_created_at ON monitor_classifications (created_at);

    CREATE TABLE IF NOT EXISTS monitor_online_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      evaluation_settings_id TEXT,
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids JSONB,
      enabled BOOLEAN NOT NULL DEFAULT true,
      alert_threshold DOUBLE PRECISION DEFAULT 5,
      severity TEXT NOT NULL DEFAULT 'medium',
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS custom_evaluators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      sample_rate DOUBLE PRECISION NOT NULL DEFAULT 0.1,
      scope_mode TEXT NOT NULL DEFAULT 'all',
      agent_ids JSONB,
      enabled BOOLEAN NOT NULL DEFAULT true,
      invert_match BOOLEAN NOT NULL DEFAULT false,
      severity TEXT NOT NULL DEFAULT 'medium',
      kind TEXT NOT NULL DEFAULT 'external',
      language TEXT,
      script TEXT,
      alert_below DOUBLE PRECISION,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      headers JSONB,
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS outcome_reports (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      evaluation_run_result_id TEXT,
      outcome TEXT NOT NULL,
      is_negative BOOLEAN NOT NULL,
      reason TEXT,
      reported_by TEXT,
      reported_at TIMESTAMP NOT NULL,
      project_id TEXT
    );


    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      rating TEXT NOT NULL,
      comment TEXT,
      end_user_id TEXT,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );


    CREATE TABLE IF NOT EXISTS improvement_proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      current_text TEXT NOT NULL,
      proposal JSONB NOT NULL,
      validation JSONB,
      created_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      model TEXT,
      organization_id TEXT,
      project_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_events_created_at ON usage_events (created_at);

    CREATE TABLE IF NOT EXISTS gate_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL,
      passed BOOLEAN NOT NULL,
      average_rating DOUBLE PRECISION,
      baseline_run_id TEXT,
      baseline_average DOUBLE PRECISION,
      checks JSONB,
      caller TEXT,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS session_scores (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      rating DOUBLE PRECISION,
      justification TEXT,
      drift_span_id TEXT,
      span_count INTEGER NOT NULL,
      judge_model TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sweep_leases (
      name TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      summary JSONB,
      ip TEXT,
      project_id TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events (created_at);

    CREATE TABLE IF NOT EXISTS tool_schemas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_schema_versions (
      id TEXT PRIMARY KEY,
      tool_schema_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      reasoning TEXT,
      based_on_version INTEGER,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS portability_models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      price_per_m_input_tokens DOUBLE PRECISION NOT NULL,
      price_per_m_output_tokens DOUBLE PRECISION NOT NULL,
      price_per_m_cache_read_tokens DOUBLE PRECISION,
      price_per_m_cache_write_tokens DOUBLE PRECISION,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      base_url TEXT,
      api_key TEXT,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evaluation_analyses (
      evaluation_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      judge_model TEXT NOT NULL,
      judge_models JSONB,
      analysis JSONB,
      statistics JSONB,
      judge_evidence JSONB,
      error TEXT,
      created_at TIMESTAMP NOT NULL,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      openai_api_key TEXT,
      anthropic_api_key TEXT,
      gemini_api_key TEXT,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      image TEXT,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_session (
      id TEXT PRIMARY KEY,
      expires_at TIMESTAMP NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL,
      active_organization_id TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_account (
      id TEXT PRIMARY KEY,
      issuer TEXT,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at TIMESTAMP,
      refresh_token_expires_at TIMESTAMP,
      scope TEXT,
      password TEXT,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP,
      updated_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      logo TEXT,
      created_at TIMESTAMP NOT NULL,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_member (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_invitation (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP,
      inviter_id TEXT NOT NULL
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
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS custom_evaluator_id TEXT;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS matched BOOLEAN;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS session_id TEXT;
    ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS version TEXT;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS evaluation_settings_id TEXT;
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS alert_threshold DOUBLE PRECISION DEFAULT 5;
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium';
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS trace_id TEXT;
    ALTER TABLE datasets ADD COLUMN IF NOT EXISTS number_of_requests INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS number_of_requests INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS smoke_test_variants JSONB;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS is_smoke_test_variant BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS smoke_test_variant_text TEXT;
    ALTER TABLE datasets ADD COLUMN IF NOT EXISTS similarity_config JSONB;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS similarity_config JSONB;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS vector_similarity DOUBLE PRECISION;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS jaccard_similarity DOUBLE PRECISION;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS bleu_score DOUBLE PRECISION;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS rouge_score DOUBLE PRECISION;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS base_url TEXT;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS api_key TEXT;
    ALTER TABLE evaluation_analyses ADD COLUMN IF NOT EXISTS judge_models JSONB;
    ALTER TABLE monitor_signal_feedback ADD COLUMN IF NOT EXISTS event_id TEXT;
    ALTER TABLE monitor_profiles ADD COLUMN IF NOT EXISTS topics_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS span_id TEXT;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS parent_span_id TEXT;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS started_at TIMESTAMP;
    ALTER TABLE datasets ADD COLUMN IF NOT EXISTS code_scorers JSONB;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS code_scorers JSONB;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS code_scorer_results JSONB;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE datasets ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE evaluation_settings ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE evaluation_run_results ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE dataset_versions ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE evaluation_settings_versions ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE playground_runs ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE playground_runs ADD COLUMN IF NOT EXISTS prompt_id TEXT;
    ALTER TABLE monitor_patterns ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_profiles ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_signals ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_signal_feedback ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_events ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_classifications ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE monitor_classifications ADD COLUMN IF NOT EXISTS embedding JSONB;
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE prompt_versions ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE evaluation_analyses ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS coverage_mode TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS latency_threshold_ms INTEGER NOT NULL DEFAULT 20000;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
    ALTER TABLE traces ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS price_per_m_cache_read_tokens DOUBLE PRECISION;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS price_per_m_cache_write_tokens DOUBLE PRECISION;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;
    ALTER TABLE outcome_reports ADD COLUMN IF NOT EXISTS is_negative BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS topics_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS coherence_sweep_enabled BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS disabled_builtin_patterns JSONB;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled_builtin_patterns JSONB;
    ALTER TABLE custom_evaluators ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'external';
    ALTER TABLE custom_evaluators ADD COLUMN IF NOT EXISTS language TEXT;
    ALTER TABLE custom_evaluators ADD COLUMN IF NOT EXISTS script TEXT;
    ALTER TABLE custom_evaluators ADD COLUMN IF NOT EXISTS alert_below DOUBLE PRECISION;
    ALTER TABLE portability_models ADD COLUMN IF NOT EXISTS organization_id TEXT;
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'trace';
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS idle_seconds INTEGER NOT NULL DEFAULT 120;
    ALTER TABLE monitor_online_evaluators ADD COLUMN IF NOT EXISTS builtin_key TEXT;
    ALTER TABLE session_scores ADD COLUMN IF NOT EXISTS findings JSONB;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id TEXT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS auth_secret TEXT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS metric_pack_seeded_at TIMESTAMP;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS metric_pack_version INTEGER;
    ALTER TABLE tool_schemas ADD COLUMN IF NOT EXISTS test_endpoint_url TEXT;
    ALTER TABLE tool_schemas ADD COLUMN IF NOT EXISTS resolved_evidence JSONB;
    ALTER TABLE playground_runs ADD COLUMN IF NOT EXISTS kind TEXT;

    -- One-way Topics migration, see bootstrapSqlite's equivalent for the full comment (copy any
    -- enabled per-agent flag up to the project once, then clear the profile flags so a later
    -- project-level "off" isn't silently re-enabled on the next boot).
    UPDATE projects SET topics_enabled = true WHERE id IN (
      SELECT DISTINCT project_id FROM monitor_profiles WHERE topics_enabled = true AND project_id IS NOT NULL
    );
    UPDATE monitor_profiles SET topics_enabled = false WHERE topics_enabled = true;
  `);

  await ensureTraceSpanIdUniqueAsync(statement => pool.query(statement).then(() => undefined));
  await ensureVersionUniqueAsync(statement => pool.query(statement).then(() => undefined));
  await pool.query(BACKFILL_AUTH_ACCOUNT_ISSUER);

  await migrateOnlineEvaluatorsToConfigsPostgres(pool);
  await backfillAgentsPostgres(pool);
  await backfillDefaultProjectPostgres(pool);

  for (const statement of PROJECT_SCOPED_UNIQUE_INDEXES) {
    try {
      await pool.query(statement);
    } catch (err) {
      console.warn(
        `Could not create the unique index from \`${statement}\`: ${err instanceof Error ? err.message : String(err)}\n` +
          `  This usually means duplicate rows already exist for that key.`
      );
    }
  }
}

// Postgres mirror of migrateOnlineEvaluatorsToConfigsSqlite above - see that function's comment
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

// Postgres mirror of backfillAgentsSqlite above - see that function's comment for the full
// rationale (name-vs-real-id idempotency check, why traces.agent_id is the one clean NULL-guarded
// signal). $1/$2 placeholders instead of ? throughout, otherwise identical logic.
async function backfillAgentsPostgres(pool: Pool): Promise<void> {
  // Root spans only + corrective un-stamp - see backfillAgentsSqlite's comment.
  await pool.query(`UPDATE traces SET agent_id = NULL WHERE parent_span_id IS NOT NULL AND agent_id IS NOT NULL`);
  await pool.query(`DELETE FROM agents WHERE
    EXISTS (SELECT 1 FROM traces t WHERE t.name = agents.name AND t.parent_span_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM traces t WHERE t.name = agents.name AND t.parent_span_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM monitor_profiles mp WHERE mp.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_signals ms WHERE ms.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_events me WHERE me.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_classifications mc WHERE mc.agent_id = agents.id)
    AND NOT EXISTS (SELECT 1 FROM monitor_patterns pat WHERE pat.agent_ids::text LIKE '%' || agents.id || '%')
    AND NOT EXISTS (SELECT 1 FROM monitor_online_evaluators ev WHERE ev.agent_ids::text LIKE '%' || agents.id || '%')`);
  const { rows: distinctNames } = await pool.query<{ name: string }>(
    `SELECT DISTINCT name FROM traces WHERE parent_span_id IS NULL`
  );

  const nameToId = new Map<string, string>();
  const { rows: existingAgents } = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM agents`);
  for (const existing of existingAgents) {
    if (!nameToId.has(existing.name)) {
      nameToId.set(existing.name, existing.id);
    }
  }

  for (const { name } of distinctNames) {
    if (nameToId.has(name)) {
      continue;
    }
    const id = nanoid();
    await pool.query(`INSERT INTO agents (id, name, created_at) VALUES ($1, $2, NOW())`, [id, name]);
    nameToId.set(name, id);
  }

  if (nameToId.size === 0) {
    return;
  }

  const { rows: pendingTraces } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM traces WHERE agent_id IS NULL AND parent_span_id IS NULL`
  );
  for (const trace of pendingTraces) {
    const agentId = nameToId.get(trace.name);
    if (agentId) {
      await pool.query(`UPDATE traces SET agent_id = $1 WHERE id = $2`, [agentId, trace.id]);
    }
  }

  const singleValueTargets: Array<[string, string]> = [
    ["monitor_profiles", "agent_id"],
    ["monitor_signals", "agent_id"],
    ["monitor_events", "agent_id"],
    ["monitor_classifications", "agent_id"],
  ];
  for (const [table, column] of singleValueTargets) {
    const { rows } = await pool.query<{ id: string; value: string }>(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`
    );
    for (const row of rows) {
      const agentId = nameToId.get(row.value);
      if (agentId) {
        await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [agentId, row.id]);
      }
    }
  }

  const arrayTargets: Array<[string, string]> = [
    ["monitor_patterns", "agent_ids"],
    ["monitor_online_evaluators", "agent_ids"],
  ];
  for (const [table, column] of arrayTargets) {
    const { rows } = await pool.query<{ id: string; value: unknown }>(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`
    );
    for (const row of rows) {
      if (!Array.isArray(row.value)) {
        continue;
      }
      const rewritten = row.value.map(entry => (typeof entry === "string" ? (nameToId.get(entry) ?? entry) : entry));
      await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [JSON.stringify(rewritten), row.id]);
    }
  }
}

// Every table below (all except portability_models/app_settings - deliberately instance-wide, see
// their own schema.sqlite.ts comments) needs a project_id. Listed once here, shared by both
// dialects' backfill functions below.
const PROJECT_SCOPED_TABLES = [
  "traces",
  "agents",
  "datasets",
  "evaluation_settings",
  "evaluation_runs",
  "evaluation_run_results",
  "dataset_versions",
  "evaluation_settings_versions",
  "playground_runs",
  "monitor_patterns",
  "monitor_profiles",
  "monitor_signals",
  "monitor_signal_feedback",
  "monitor_events",
  "monitor_classifications",
  "monitor_online_evaluators",
  "prompts",
  "prompt_versions",
  "evaluation_analyses",
];

// Read directly (not via auth/apiKey.ts) to avoid a circular import: db.ts already owns
// AGENTX_HOME and apiKey.ts already depends on db.ts for it, not the reverse - apiKey.ts will
// additionally depend on db.ts's getDb() once it resolves projects by key (core/project/
// projects.ts), so db.ts must not depend back on apiKey.ts. ensureLocalApiKey() (index.ts's
// main(), called before initDb()) guarantees config.json already exists with a real key by the
// time this runs; the fallback below only matters if that ordering ever changes.
function readExistingLocalApiKey(): string | null {
  try {
    const raw = fs.readFileSync(path.join(AGENTX_HOME, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : null;
  } catch {
    return null;
  }
}

// Multi-project support (core/project/projects.ts): every existing self-host install becomes one
// "Default" project on upgrade, whose apiKey is whatever's *already* in config.json - not a freshly
// generated one - so every already-configured SDK script and the dashboard itself keep working
// with the exact key they already have; nothing about the upgrade is visible unless you explicitly
// register a second project afterward. Safe to re-run: only creates a project if none exist yet
// (an already-migrated install just reuses the existing Default project's id), and only backfills
// rows still NULL.
function backfillDefaultProjectSqlite(sqlite: SqliteHandle): void {
  const existing = sqlite.prepare(`SELECT id FROM projects ORDER BY created_at ASC LIMIT 1`).all() as {
    id: string;
  }[];
  let defaultProjectId: string;
  if (existing.length > 0) {
    defaultProjectId = existing[0]!.id;
  } else {
    defaultProjectId = nanoid();
    const apiKey = readExistingLocalApiKey() ?? `agtx_local_${randomBytes(24).toString("hex")}`;
    sqlite
      .prepare(`INSERT INTO projects (id, name, api_key, is_default, created_at) VALUES (?, ?, ?, 1, ?)`)
      .run(defaultProjectId, "Default", apiKey, Date.now());
  }

  // Idempotent fixup for a project row created before is_default existed (or any other reason
  // nothing is currently marked default) - the oldest project becomes it. No-op once one already is.
  const anyDefault = sqlite.prepare(`SELECT id FROM projects WHERE is_default = 1 LIMIT 1`).all() as { id: string }[];
  if (anyDefault.length === 0) {
    sqlite.prepare(`UPDATE projects SET is_default = 1 WHERE id = ?`).run(defaultProjectId);
  }

  for (const table of PROJECT_SCOPED_TABLES) {
    sqlite.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id IS NULL`).run(defaultProjectId);
  }
}

// Postgres mirror of backfillDefaultProjectSqlite above - see that function's comment for the
// full rationale.
async function backfillDefaultProjectPostgres(pool: Pool): Promise<void> {
  const { rows: existing } = await pool.query<{ id: string }>(`SELECT id FROM projects ORDER BY created_at ASC LIMIT 1`);
  let defaultProjectId: string;
  if (existing.length > 0) {
    defaultProjectId = existing[0]!.id;
  } else {
    defaultProjectId = nanoid();
    const apiKey = readExistingLocalApiKey() ?? `agtx_local_${randomBytes(24).toString("hex")}`;
    await pool.query(`INSERT INTO projects (id, name, api_key, is_default, created_at) VALUES ($1, $2, $3, TRUE, NOW())`, [
      defaultProjectId,
      "Default",
      apiKey,
    ]);
  }

  const { rows: anyDefault } = await pool.query<{ id: string }>(`SELECT id FROM projects WHERE is_default = TRUE LIMIT 1`);
  if (anyDefault.length === 0) {
    await pool.query(`UPDATE projects SET is_default = TRUE WHERE id = $1`, [defaultProjectId]);
  }

  for (const table of PROJECT_SCOPED_TABLES) {
    await pool.query(`UPDATE ${table} SET project_id = $1 WHERE project_id IS NULL`, [defaultProjectId]);
  }
}
