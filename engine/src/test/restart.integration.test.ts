import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { startEngine, type TestEngine } from "./server.js";

// Everything below runs against a database that already has rows in it. Every migration in
// storage/db.ts is written to be idempotent, and the "Default" project is created by a one-time
// migration whose API key existing SDK installs already hold - a second boot that re-runs either
// of those differently is how a working install breaks on upgrade.

let home: string | undefined;
let legacyHome: string | undefined;
const engines: TestEngine[] = [];

afterAll(async () => {
  for (const engine of engines) {
    await engine.stop({ keepHome: true });
  }
  for (const dir of [home, legacyHome]) {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("restarting against an existing database", () => {
  it("keeps the same API key and the same data across a restart", async () => {
    const first = await startEngine();
    engines.push(first);
    home = first.home;
    const firstKey = first.apiKey;

    const ingested = await first.json("/api/v1/ingest/traces", {
      method: "POST",
      body: JSON.stringify({ name: "persisted-agent", span_id: "persisted-1", input: "q", output: "a" }),
      headers: { "content-type": "application/json" },
    });
    expect(ingested.status).toBe(200);
    const traceId = (ingested.body as { trace_id: string }).trace_id;

    // Graceful shutdown, the way a container stop or Ctrl+C does it.
    await first.signal("SIGTERM");
    const exitCode = await first.waitForExit();
    expect(exitCode, `engine did not exit on SIGTERM:\n${first.log().slice(-3000)}`).toBe(0);
    expect(first.log()).toContain("Shutdown complete.");

    const second = await startEngine({}, { home });
    engines.push(second);

    // A rotated key would break every SDK install pointed at this engine.
    expect(second.apiKey).toBe(firstKey);

    const detail = await second.json(`/api/v1/ingest/traces/${traceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: "persisted-agent" });

    // The replay guard has to survive the restart too, or an SDK retry after a deploy duplicates.
    const replay = await second.json("/api/v1/ingest/traces", {
      method: "POST",
      body: JSON.stringify({ name: "persisted-agent", span_id: "persisted-1", input: "q", output: "a" }),
      headers: { "content-type": "application/json" },
    });
    expect((replay.body as { trace_id: string }).trace_id).toBe(traceId);

    // Re-running the migrations must not have duplicated the seeded system evaluators or the
    // metric-pack configs (both are "ensure" steps that run on every boot).
    const evaluators = await second.json("/api/v1/agent-monitoring/online-evaluators");
    const names = JSON.stringify(evaluators.body).match(/"name":"[^"]+"/g) ?? [];
    expect(new Set(names).size).toBe(names.length);
  }, 180_000);

  it("creates the traces(project_id, span_id) unique index on an existing database", async () => {
    const db = new Database(path.join(home!, "agentx.db"), { readonly: true });
    const index = db
      .prepare("SELECT name, \"unique\" FROM pragma_index_list('traces') WHERE name = ?")
      .get("traces_project_id_span_id") as { name?: string; unique?: number } | undefined;
    db.close();
    expect(index?.name).toBe("traces_project_id_span_id");
    expect(index?.unique).toBe(1);
  });

  it("still boots, with a warning, when duplicate spans predate the index", async () => {
    // An install that hit the concurrent-replay race before the fix shipped cannot have the index
    // created until an operator cleans up. Refusing to boot over that would be far worse than
    // running without the cross-process guarantee, so this checks the engine degrades rather than
    // dies - and says exactly what is wrong.
    const db = new Database(path.join(home!, "agentx.db"));
    db.exec("DROP INDEX IF EXISTS traces_project_id_span_id");
    const row = db.prepare("SELECT * FROM traces WHERE span_id IS NOT NULL LIMIT 1").get() as Record<string, unknown>;
    expect(row, "the earlier tests should have left a span-bearing trace behind").toBeTruthy();
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO traces (${columns.join(", ")}) VALUES (${columns.map(c => "@" + c).join(", ")})`).run({
      ...row,
      id: "duplicate-span-row",
    });
    db.close();

    const engine = await startEngine({}, { home });
    engines.push(engine);
    expect(engine.alive()).toBe(true);
    expect(engine.log()).toContain("Could not create the traces(project_id, span_id) unique index");
    // And it is still serving, not wedged.
    expect((await engine.json("/api/v1/ingest/traces")).status).toBe(200);
  }, 120_000);

  it("boots a third time without error", async () => {
    const third = await startEngine({}, { home });
    engines.push(third);
    expect(third.alive()).toBe(true);
    expect((await third.json("/api/v1/ingest/traces")).status).toBe(200);
    expect(third.log()).not.toContain("Unhandled promise rejection");
  }, 120_000);

  // Multi-project shipped project_id on these three tables by adding it to their CREATE TABLE
  // statements *and* to columnMigrations. On an install predating it the CREATE TABLE is a no-op,
  // so only the ALTER puts the column there - and the ALTERs run after the whole CREATE TABLE
  // block. Building the indexes inline therefore killed the boot outright with "no such column:
  // project_id" on every upgraded database, while every fresh one was fine.
  it("boots against a database whose tables predate project_id", async () => {
    const first = await startEngine();
    legacyHome = first.home;
    await first.signal("SIGTERM");
    expect(await first.waitForExit()).toBe(0);

    // Rewind those three tables to their pre-multi-project shape: no project_id, and the narrower
    // unique indexes that shipped alongside it.
    const db = new Database(path.join(legacyHome, "agentx.db"));
    db.exec(`
      DROP INDEX IF EXISTS monitor_profiles_agent_id;
      DROP INDEX IF EXISTS monitor_signals_pattern_key_agent_id;
      DROP INDEX IF EXISTS prompt_versions_prompt_id_version;
      ALTER TABLE monitor_profiles DROP COLUMN project_id;
      ALTER TABLE monitor_signals DROP COLUMN project_id;
      ALTER TABLE prompt_versions DROP COLUMN project_id;
      CREATE UNIQUE INDEX monitor_profiles_agent_id ON monitor_profiles (agent_id);
      CREATE UNIQUE INDEX monitor_signals_pattern_key_agent_id ON monitor_signals (pattern_key, agent_id);
      CREATE UNIQUE INDEX prompt_versions_prompt_id_version ON prompt_versions (prompt_id, version);
    `);
    db.close();

    const upgraded = await startEngine({}, { home: legacyHome });
    engines.push(upgraded);
    expect(upgraded.alive(), `engine died on the upgrade path:\n${upgraded.log().slice(-3000)}`).toBe(true);
    expect(upgraded.log()).not.toContain("no such column: project_id");
    expect((await upgraded.json("/api/v1/ingest/traces")).status).toBe(200);

    // And the narrow indexes were actually widened, not left in place by a name-only IF NOT EXISTS.
    const check = new Database(path.join(legacyHome, "agentx.db"), { readonly: true });
    const widened = [
      ["monitor_profiles_agent_id", 2],
      ["monitor_signals_pattern_key_agent_id", 3],
      ["prompt_versions_prompt_id_version", 3],
    ] as const;
    for (const [index, columnCount] of widened) {
      const columns = check.prepare(`SELECT name FROM pragma_index_info(?)`).all(index) as { name: string }[];
      expect(columns.map(c => c.name), index).toContain("project_id");
      expect(columns.length, index).toBe(columnCount);
    }
    check.close();
  }, 180_000);
});
