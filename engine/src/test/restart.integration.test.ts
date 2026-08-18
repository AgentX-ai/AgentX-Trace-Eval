import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { startEngine, type TestEngine } from "./server.js";

// Everything below runs against a database that already has rows in it. Every migration in
// storage/db.ts is written to be idempotent, and the "Default" project is created by a one-time
// migration whose API key existing SDK installs already hold - a second boot that re-runs either
// of those differently is how a working install breaks on upgrade.

let home: string | undefined;
const engines: TestEngine[] = [];

afterAll(async () => {
  for (const engine of engines) {
    await engine.stop({ keepHome: true });
  }
  if (home) {
    fs.rmSync(home, { recursive: true, force: true });
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

  it("boots a third time without error", async () => {
    const third = await startEngine({}, { home });
    engines.push(third);
    expect(third.alive()).toBe(true);
    expect((await third.json("/api/v1/ingest/traces")).status).toBe(200);
    expect(third.log()).not.toContain("Unhandled promise rejection");
  }, 120_000);
});
