import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, withProjectId, type Db } from "../../storage/db.js";
import { getDefaultProject, updateMonitoringDefaults } from "../project/projects.js";
import { createAgent } from "./agents.js";
import { createPattern } from "./patterns.js";
import { updateProfile } from "./profiles.js";
import { runMonitorCheck } from "./detect.js";
import { listEventsSince } from "./events.js";
import type { PatternCondition } from "./conditions.js";

// Real (temporary) SQLite rather than mocks: what's under test is which rows the detection path
// reads before it decides to sample. AGENTX_DB_URL is read inside initDb(), so setting it in
// beforeAll keeps every write in the temp directory.
let db: Db;
let tmpDir: string;

// Same deterministic RNG as routing.test.ts.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedRng(seed = 42): void {
  vi.spyOn(Math, "random").mockImplementation(seededRandom(seed));
}

// Trips the built-in empty-response check: no judge call, no API key.
const FAILING_TRACE = { input: "hi", output: "", error: null, toolCalls: null, latencyMs: 10 };
// Matches a custom pattern while tripping no built-in (built-ins run first and short-circuit).
const REFUND_TRACE = { input: "where is my money", output: "the refund was denied", error: null, toolCalls: null, latencyMs: 10 };

const N = 200;

// One KPI event is recorded per monitored trace (operational classification raises no Signal),
// so counting event rows counts "how many traces got monitored".
async function monitoredCount(patternKey: string, agentId: string | null): Promise<number> {
  const rows = await listEventsSince(db, new Date(0));
  return rows.filter(row => row.patternKey === patternKey && row.agentId === agentId).length;
}

async function runN(n: number, trace: typeof FAILING_TRACE, ctx: { agentId: string | null; patternIds?: string[] }): Promise<void> {
  for (let i = 0; i < n; i++) {
    await runMonitorCheck(db, trace, { ...ctx, traceId: `trace-${i}` });
  }
}

function phraseCondition(value: string): PatternCondition {
  return { connector: "and", negate: false, sources: ["response"], detector: "phrase", value, caseSensitive: false };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentx-detect-test-"));
  process.env.AGENTX_HOME = tmpDir;
  process.env.AGENTX_DB_URL = `sqlite:${path.join(tmpDir, "test.db")}`;
  const base = await initDb();
  const project = await getDefaultProject(base);
  db = withProjectId(base, project!.id);
});

afterAll(async () => {
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runMonitorCheck - legacy coverage rate is inert", () => {
  // Sampling simplification: detection is cheap text checks and runs on ALL ingested traffic.
  // The legacy project-level coverage sampleRate is stored for old clients but gates nothing -
  // it used to silently drop monitoring when "All traffic" mode kept a stale stored rate.
  it("monitors every trace even with a legacy rate of 0.5 stored", async () => {
    await updateMonitoringDefaults(db, { coverageMode: "sampled", sampleRate: 0.5 });
    const agent = await createAgent(db, "legacy-rate-half");
    seedRng();

    await runN(N, FAILING_TRACE, { agentId: agent._id });

    expect(await monitoredCount("empty-agent-response", agent._id)).toBe(N);
  });

  it("monitors every trace even with a legacy rate of 0 stored, profile or not", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0 });
    const profileless = await createAgent(db, "legacy-zero-no-profile");
    const profiled = await createAgent(db, "legacy-zero-with-profile");
    await updateProfile(db, profiled._id, { enabled: true });

    await runN(20, FAILING_TRACE, { agentId: profileless._id });
    await runN(20, FAILING_TRACE, { agentId: profiled._id });

    expect(await monitoredCount("empty-agent-response", profileless._id)).toBe(20);
    expect(await monitoredCount("empty-agent-response", profiled._id)).toBe(20);
  });

  it("monitors agent-less traces unconditionally too", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0 });
    seedRng();

    await runN(20, FAILING_TRACE, { agentId: null });

    expect(await monitoredCount("empty-agent-response", null)).toBe(20);
  });

  // Unchanged: the `profile &&` prefix stays on the enabled check - an explicitly disabled
  // profile still opts its agent out entirely.
  it("skips an explicitly disabled profile", async () => {
    const agent = await createAgent(db, "sampling-disabled-profile");
    await updateProfile(db, agent._id, { enabled: false });

    await runN(20, FAILING_TRACE, { agentId: agent._id });

    expect(await monitoredCount("empty-agent-response", agent._id)).toBe(0);
  });
});

// Patterns are project-wide and these tests share one database, so each is scoped to its own agent.
describe("runMonitorCheck - per-pattern sample rate", () => {
  it("applies each pattern's own sample rate on the implicit sweep path", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 1 });
    const agent = await createAgent(db, "pattern-sampled");
    const pattern = await createPattern(db, {
      name: "half sampled refunds",
      conditions: [phraseCondition("refund")],
      sampleRate: 0.5,
      scopeMode: "selected",
      agentIds: [agent._id],
    });
    seedRng();

    await runN(N, REFUND_TRACE, { agentId: agent._id });

    const matched = await monitoredCount(pattern.key, agent._id);
    expect(matched).toBeGreaterThan(N * 0.35);
    expect(matched).toBeLessThan(N * 0.65);
  });

  it("never matches a pattern sampled at 0 on the implicit sweep path", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 1 });
    const agent = await createAgent(db, "pattern-sampled-zero");
    const pattern = await createPattern(db, {
      name: "never sampled refunds",
      conditions: [phraseCondition("refund")],
      sampleRate: 0,
      scopeMode: "selected",
      agentIds: [agent._id],
    });

    await runN(20, REFUND_TRACE, { agentId: agent._id });

    expect(await monitoredCount(pattern.key, agent._id)).toBe(0);
  });

  // Naming a pattern by id asks "does this match right now", so it skips the rate (see routing.ts).
  it("bypasses pattern sampling when the caller names pattern_ids explicitly", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 1 });
    const agent = await createAgent(db, "pattern-explicit");
    const pattern = await createPattern(db, {
      name: "explicitly requested refunds",
      conditions: [phraseCondition("refund")],
      sampleRate: 0,
      scopeMode: "selected",
      agentIds: [agent._id],
    });

    await runN(10, REFUND_TRACE, { agentId: agent._id, patternIds: [pattern._id] });

    expect(await monitoredCount(pattern.key, agent._id)).toBe(10);
  });

  // Sampling simplification: the pattern's own rate is the ONLY sampling applied - the legacy
  // project coverage rate no longer multiplies in (it used to make effective rates an opaque
  // product of two knobs).
  it("ignores the legacy project rate: a pattern sampled at 1 matches every trace", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0.5 });
    const agent = await createAgent(db, "pattern-project-rate");
    const pattern = await createPattern(db, {
      name: "unsampled refunds",
      conditions: [phraseCondition("refund")],
      sampleRate: 1,
      scopeMode: "selected",
      agentIds: [agent._id],
    });
    seedRng();

    await runN(N, REFUND_TRACE, { agentId: agent._id });

    expect(await monitoredCount(pattern.key, agent._id)).toBe(N);
  });
});
