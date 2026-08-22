import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type { Db } from "../storage/db.js";

// An in-process database, for core paths no route reaches: retention pruning is a side effect of
// ingest, the sweep lease needs two holders, and backdated rows have to be written at a chosen
// time. storage/db.ts caches one Db per process, so this is one open() per test file.

export type TestDb = {
  db: Db;
  /** A Db scoped to a project created for this test - core functions all take a scoped Db. */
  scoped(projectId: string): Db;
  /** Creates a project and returns its id, so tests never collide with the seeded example data. */
  newProject(name: string): Promise<string>;
  close(): Promise<void>;
};

let opened = false;

export async function openTestDb(options: { postgres?: boolean } = {}): Promise<TestDb> {
  if (opened) {
    throw new Error("openTestDb() already called in this worker - storage/db.ts caches one database per process");
  }
  opened = true;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentx-dbtest-"));
  process.env.AGENTX_HOME = home;

  let dropDatabase: (() => Promise<void>) | null = null;
  if (options.postgres) {
    const adminUrl = process.env.AGENTX_TEST_DB_URL ?? "";
    if (!adminUrl) {
      throw new Error("openTestDb({ postgres: true }) needs AGENTX_TEST_DB_URL");
    }
    const name = `agentx_core_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    process.env.AGENTX_DB_URL = url.toString();
    dropDatabase = async () => {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]);
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      await cleanup.end();
    };
  } else {
    // Point at a temp sqlite file EXPLICITLY rather than deleting AGENTX_DB_URL: storage/db.ts
    // freezes AGENTX_HOME at module-import time, and this harness's callers statically import
    // engine modules (which import db.ts) before openTestDb() runs - so the temp AGENTX_HOME set
    // above arrives too late, and the no-URL fallback would resolve to the REAL ~/.agentx
    // database. That exact leak filled a developer's live DB with "Retention A/B" projects, one
    // pair per suite run. AGENTX_DB_URL is read lazily inside initDb(), so it isolates reliably.
    process.env.AGENTX_DB_URL = `sqlite:${path.join(home, "test.db")}`;
  }

  const storage = await import("../storage/db.js");
  const projects = await import("../core/project/projects.js");
  const db = await storage.initDb();

  return {
    db,
    scoped: (projectId: string) => storage.withProjectId(db, projectId),
    newProject: async (name: string) => (await projects.createProject(db, name, null))._id,
    close: async () => {
      await storage.closeDb();
      fs.rmSync(home, { recursive: true, force: true });
      await dropDatabase?.();
    },
  };
}
