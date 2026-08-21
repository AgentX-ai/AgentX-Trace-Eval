import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Boots the REAL engine the way a user does - `tsx src/index.ts`, its own main(), its own SQLite
// file. The failures worth catching are runtime ones (a rejection that kills the process, a
// migration that only runs on a fresh database), and none reproduce against a hand-built app.

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, "../..");

// tsx lives in engine/node_modules under a plain install and in the workspace root's
// node_modules once yarn/bun hoists it - resolve whichever exists rather than hard-coding one.
function tsxCli(): string {
  const candidates = [
    path.join(engineRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(engineRoot, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`tsx not found - looked in:\n${candidates.join("\n")}`);
  }
  return found;
}

// Postgres suites are opt-in: set AGENTX_TEST_DB_URL to a superuser connection string and they
// run against throwaway databases they create and drop; leave it unset and they skip.
export const TEST_POSTGRES_URL = process.env.AGENTX_TEST_DB_URL ?? "";
export const postgresAvailable = Boolean(TEST_POSTGRES_URL);

let databaseCounter = 0;

async function createThrowawayDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `agentx_test_${process.pid}_${++databaseCounter}`;
  const admin = new pg.Client({ connectionString: TEST_POSTGRES_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: TEST_POSTGRES_URL });
      await cleanup.connect();
      // The engine's pool may not have fully released yet when a suite tears down.
      await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [name]);
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      await cleanup.end();
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

export type TestEngine = {
  baseUrl: string;
  apiKey: string;
  /** The AGENTX_HOME this engine was booted against - pass it back to startEngine to reuse the same database. */
  home: string;
  /** Which storage backend this engine is running on, for test names and dialect-specific assertions. */
  backend: "sqlite" | "postgres";
  /** Everything the engine wrote to stdout/stderr since boot. */
  log(): string;
  /** False once the engine process has exited - i.e. something killed it. */
  alive(): boolean;
  exitCode(): number | null;
  request(pathname: string, init?: RequestInit & { apiKey?: string | null }): Promise<Response>;
  json(pathname: string, init?: RequestInit & { apiKey?: string | null }): Promise<{ status: number; body: unknown }>;
  stop(options?: { keepHome?: boolean }): Promise<void>;
  /** Sends a signal to the engine process - for exercising the graceful-shutdown path. */
  signal(sig: NodeJS.Signals): Promise<void>;
  /** Resolves with the exit code, or null if the process was still running when the wait expired. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
};

export async function startEngine(
  env: Record<string, string> = {},
  options: { home?: string; postgres?: boolean } = {}
): Promise<TestEngine> {
  const port = await freePort();
  const database = options.postgres ? await createThrowawayDatabase() : null;
  // A caller-supplied home boots against an existing database - the upgrade path, not a first run.
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentx-test-"));
  let output = "";
  let exited: number | null = null;

  const child: ChildProcess = spawn(
    process.execPath,
    [tsxCli(), path.join(engineRoot, "src", "index.ts")],
    {
      cwd: engineRoot,
      env: {
        ...process.env,
        AGENTX_HOME: home,
        PORT: String(port),
        // The background sweeps fire timers that call out to LLM providers; a test run has no
        // keys and no need for them, and their logs drown out the failure being investigated.
        AGENTX_SESSION_SWEEP: "false",
        AGENTX_IMPROVEMENT_SWEEP: "false",
        NODE_ENV: "test",
        ...(database ? { AGENTX_DB_URL: database.url } : {}),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // tsx runs the engine in a grandchild, so signalling `child` only removes the wrapper and
      // leaves the engine orphaned on its port. Its own group makes the tree killable in one go.
      detached: true,
    }
  );

  // ESRCH just means the tree is already gone, which is the outcome we wanted anyway.
  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      child.kill(sig);
    }
  };

  child.stdout?.on("data", chunk => (output += String(chunk)));
  child.stderr?.on("data", chunk => (output += String(chunk)));
  child.on("exit", code => (exited = code ?? -1));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`engine exited during boot (code ${exited}):\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!healthy) {
    killTree("SIGKILL");
    throw new Error(`engine never became healthy:\n${output}`);
  }

  // The boot banner prints no key in either mode, so read it where the dashboard does: disabled
  // mode answers GET /api/v1/auth/config with the default project's key for any caller on this
  // port. No polling needed - the route is registered before listen(), so /health answering above
  // already means this one is mounted.
  // AGENTX_AUTH=enabled returns no key there, and that suite signs in instead of using an ambient
  // one.
  const authEnabled = env.AGENTX_AUTH === "enabled";
  let apiKey = "";
  if (!authEnabled) {
    // `connection: close` on purpose. The global fetch pools keep-alive sockets, and an idle one
    // left against the engine delays its server.close() - long enough that the SIGTERM killTree
    // sends to the whole process group takes the tsx wrapper down first, so
    // restart.integration.test.ts reads the wrapper's 143 rather than the engine's own clean 0.
    // That race already exists and loses occasionally under full-suite load; keeping the socket
    // out of the pool is what stops it losing every time.
    const res = await fetch(`${baseUrl}/api/v1/auth/config`, { headers: { connection: "close" } });
    apiKey = res.ok ? ((await res.json()) as { apiKey?: string }).apiKey ?? "" : "";
    if (!apiKey) {
      killTree("SIGKILL");
      throw new Error(`no API key from /api/v1/auth/config (HTTP ${res.status}):\n${output}`);
    }
  }

  const request: TestEngine["request"] = (pathname, init = {}) => {
    const { apiKey: overrideKey, headers, ...rest } = init;
    const key = overrideKey === undefined ? apiKey : overrideKey;
    return fetch(`${baseUrl}${pathname}`, {
      ...rest,
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  };

  return {
    baseUrl,
    apiKey,
    home,
    backend: database ? "postgres" : "sqlite",
    log: () => output,
    alive: () => exited === null,
    exitCode: () => exited,
    request,
    json: async (pathname, init) => {
      const res = await request(pathname, init);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // leave as raw text - a handler returning HTML where JSON was expected is itself a finding
      }
      return { status: res.status, body };
    },
    stop: async ({ keepHome = false }: { keepHome?: boolean } = {}) => {
      if (exited === null) {
        killTree("SIGKILL");
        await new Promise(r => setTimeout(r, 50));
      }
      if (!keepHome) {
        fs.rmSync(home, { recursive: true, force: true });
      }
      if (database) {
        await database.drop();
      }
    },
    signal: async (sig: NodeJS.Signals) => {
      killTree(sig);
    },
    waitForExit: async (timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exited !== null) {
          return exited;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return null;
    },
  };
}

/** POST helper for JSON bodies (the engine's own routes are all JSON in / JSON out). */
export function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}
