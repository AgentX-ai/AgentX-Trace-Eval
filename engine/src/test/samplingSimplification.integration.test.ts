import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// The sampling simplification (vendor-consensus model): detection runs on ALL ingested traffic,
// sampling lives only on the scorers that spend LLM money. The legacy Settings coverage pair
// (coverageMode/sampleRate) stays writable for old clients but gates nothing - previously
// "All traffic" mode with a stale stored rate silently dropped monitoring. Topics gets its own
// topicsSampleRate, backfilled once from the legacy rate for projects that had sampled coverage.

let engine: TestEngine;
const engines: TestEngine[] = [];

const post = (body: unknown, apiKey: string | null, method = "POST"): RequestInit & { apiKey: string | null } => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  apiKey,
});

async function newProject(name: string): Promise<string> {
  const res = await engine.json("/api/v1/projects", post({ name }, null));
  expect(res.status).toBe(201);
  return (res.body as { project: { apiKey: string } }).project.apiKey;
}

beforeAll(async () => {
  engine = await startEngine();
  engines.push(engine);
}, 90_000);

afterAll(async () => {
  for (const e of engines) await e?.stop();
});

describe("sampling simplification", () => {
  it("detection ignores the legacy coverage rate: rate 0 no longer suppresses signals", async () => {
    const key = await newProject("legacy-rate-zero");
    // The old trap at its worst: stored rate 0 under sampled coverage used to silently skip
    // every runMonitorCheck.
    const put = await engine.json(
      "/api/v1/agent-monitoring/settings/monitoring-defaults",
      post({ coverageMode: "sampled", sampleRate: 0, enabledBuiltinPatterns: ["secrets-in-response"] }, key, "PUT")
    );
    expect(put.status).toBe(200);
    const ingest = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "leaky-agent", input: "q", output: "key: sk-proj-Abc123def456ghi789jkl012", span_id: "s-1" }, key)
    );
    expect(ingest.status).toBe(200);
    const deadline = Date.now() + 12_000;
    let keys: string[] = [];
    while (Date.now() < deadline) {
      const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: key });
      keys = ((res.body as { signals?: { patternKey?: string }[] }).signals ?? []).map(s => s.patternKey ?? "");
      if (keys.length > 0) break;
      await new Promise(r => setTimeout(r, 150));
    }
    expect(keys).toContain("secrets-in-response");
  });

  it("topicsSampleRate is its own validated field, independent of the legacy pair", async () => {
    const key = await newProject("topics-rate");
    const bad = await engine.json(
      "/api/v1/agent-monitoring/settings/monitoring-defaults",
      post({ topicsSampleRate: 2 }, key, "PUT")
    );
    expect(bad.status).toBe(400);
    const ok = await engine.json(
      "/api/v1/agent-monitoring/settings/monitoring-defaults",
      post({ topicsSampleRate: 0.25 }, key, "PUT")
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { monitoringDefaults: { topicsSampleRate: number } }).monitoringDefaults.topicsSampleRate).toBe(
      0.25
    );
    // Writing the legacy pair afterwards does not disturb the Topics rate.
    await engine.json(
      "/api/v1/agent-monitoring/settings/monitoring-defaults",
      post({ coverageMode: "sampled", sampleRate: 0.9 }, key, "PUT")
    );
    const read = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: key });
    expect(
      (read.body as { monitoringDefaults: { topicsSampleRate: number } }).monitoringDefaults.topicsSampleRate
    ).toBe(0.25);
  });

  it("upgrade backfills topicsSampleRate from a sampled legacy rate exactly once", async () => {
    const first = await startEngine();
    const home = first.home;
    const created = await first.json("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "pre-upgrade" }),
      headers: { "content-type": "application/json" },
      apiKey: null,
    });
    const apiKey = (created.body as { project: { apiKey: string } }).project.apiKey;
    await first.signal("SIGTERM");
    expect(await first.waitForExit()).toBe(0);

    // Rewind to the pre-simplification shape: sampled coverage at 0.3, and no
    // topics_sample_rate column (the upgrade being tested introduces it).
    const db = new Database(path.join(home, "agentx.db"));
    db.exec(`
      UPDATE projects SET coverage_mode = 'sampled', sample_rate = 0.3;
      ALTER TABLE projects DROP COLUMN topics_sample_rate;
    `);
    db.close();

    const upgraded = await startEngine({}, { home });
    engines.push(upgraded);
    const read = await upgraded.json("/api/v1/agent-monitoring/settings", { apiKey });
    expect((read.body as { monitoringDefaults: { topicsSampleRate: number } }).monitoringDefaults.topicsSampleRate).toBe(
      0.3
    );

    // Second boot must not re-backfill: the user's own later value wins.
    await upgraded.json(
      "/api/v1/agent-monitoring/settings/monitoring-defaults",
      post({ topicsSampleRate: 1 }, apiKey, "PUT")
    );
    await upgraded.signal("SIGTERM");
    expect(await upgraded.waitForExit()).toBe(0);
    const again = await startEngine({}, { home });
    engines.push(again);
    const reread = await again.json("/api/v1/agent-monitoring/settings", { apiKey });
    expect(
      (reread.body as { monitoringDefaults: { topicsSampleRate: number } }).monitoringDefaults.topicsSampleRate
    ).toBe(1);
  }, 180_000);
});
