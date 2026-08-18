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
import { listSignalRows } from "./signals.js";
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

// Signals dedupe per (patternKey, agentId), so occurrenceCount is "how many traces got monitored".
async function monitoredCount(patternKey: string, agentId: string | null): Promise<number> {
  const rows = await listSignalRows(db);
  return rows
    .filter(row => row.patternKey === patternKey && row.agentId === agentId)
    .reduce((total, row) => total + row.occurrenceCount, 0);
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

describe("runMonitorCheck - project-level sample rate", () => {
  // The regression this suite exists for: the gate read `profile && !passesSampleRate(...)`, and
  // only an explicit profile PUT or the seed ever writes a profile row, so this count was N.
  it("samples an agent that has no monitor_profiles row", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0.5 });
    const agent = await createAgent(db, "sampling-no-profile");
    seedRng();

    await runN(N, FAILING_TRACE, { agentId: agent._id });

    const monitored = await monitoredCount("empty-agent-response", agent._id);
    expect(monitored).toBeGreaterThan(N * 0.35);
    expect(monitored).toBeLessThan(N * 0.65);
  });

  it("samples an agent that does have a profile row", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0.5 });
    const agent = await createAgent(db, "sampling-with-profile");
    await updateProfile(db, agent._id, { enabled: true });
    seedRng();

    await runN(N, FAILING_TRACE, { agentId: agent._id });

    const monitored = await monitoredCount("empty-agent-response", agent._id);
    expect(monitored).toBeGreaterThan(N * 0.35);
    expect(monitored).toBeLessThan(N * 0.65);
  });

  // An agent-less trace can never have a profile row - the other half of the same hole.
  it("samples traces that carry no agentId", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0.5 });
    seedRng();

    await runN(N, FAILING_TRACE, { agentId: null });

    const monitored = await monitoredCount("empty-agent-response", null);
    expect(monitored).toBeGreaterThan(N * 0.35);
    expect(monitored).toBeLessThan(N * 0.65);
  });

  it("monitors every trace at the default sample rate of 1", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 1 });
    const agent = await createAgent(db, "sampling-default");

    await runN(N, FAILING_TRACE, { agentId: agent._id });

    expect(await monitoredCount("empty-agent-response", agent._id)).toBe(N);
  });

  it("monitors nothing at sample rate 0, with or without a profile row", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 0 });
    const profileless = await createAgent(db, "sampling-zero-no-profile");
    const profiled = await createAgent(db, "sampling-zero-with-profile");
    await updateProfile(db, profiled._id, { enabled: true });

    await runN(20, FAILING_TRACE, { agentId: profileless._id });
    await runN(20, FAILING_TRACE, { agentId: profiled._id });

    expect(await monitoredCount("empty-agent-response", profileless._id)).toBe(0);
    expect(await monitoredCount("empty-agent-response", profiled._id)).toBe(0);
  });

  // Unchanged by the fix: the `profile &&` prefix stays on the enabled check.
  it("skips an explicitly disabled profile even at sample rate 1", async () => {
    await updateMonitoringDefaults(db, { sampleRate: 1 });
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

  it("still honors the project sample rate for a pattern of its own sampled at 1", async () => {
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

    const matched = await monitoredCount(pattern.key, agent._id);
    expect(matched).toBeGreaterThan(N * 0.35);
    expect(matched).toBeLessThan(N * 0.65);
  });
});
