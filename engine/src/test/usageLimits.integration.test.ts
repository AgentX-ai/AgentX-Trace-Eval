import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// The read-only "Usage & limits" wire: today's spend against each daily cap, served by the
// same counters the enforcement paths seed from. Caps come from env at engine start.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine({
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    AGENTX_QUOTA_TRACES_PER_DAY: "100",
    AGENTX_QUOTA_ONLINE_JUDGE_CALLS_PER_DAY: "50",
  });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "usage-limits" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("GET /agent-monitoring/usage", () => {
  it("reports today's usage against the env-configured caps, and unlimited as null", async () => {
    const before = (await api("/agent-monitoring/usage")).body as {
      day: string;
      resetsAt: string;
      traces: { used: number; limit: number | null };
      onlineJudgeCalls: { used: number; limit: number | null };
      judgeCalls: { used: number; limit: number | null };
    };
    expect(before.traces).toEqual({ used: 0, limit: 100 });
    expect(before.onlineJudgeCalls.limit).toBe(50);
    // AGENTX_QUOTA_JUDGE_CALLS_PER_DAY unset = unlimited = null, never 0.
    expect(before.judgeCalls.limit).toBeNull();
    expect(before.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Resets at the NEXT midnight UTC - the same boundary every cap uses.
    expect(new Date(before.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(before.resetsAt.endsWith("T00:00:00.000Z")).toBe(true);

    const ingested = await api(
      "/ingest/traces",
      postJson({ name: "usage-agent", span_id: "u-1", input: "q", output: "a" })
    );
    expect(ingested.status).toBe(200);

    const after = (await api("/agent-monitoring/usage")).body as { traces: { used: number } };
    expect(after.traces.used).toBe(1);
  });
});
