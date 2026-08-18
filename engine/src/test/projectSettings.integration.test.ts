import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// The project API key is the entire data-plane credential. Rotating it has one job: the old one
// must stop working immediately - and "the old key still works" looks like success to the caller.

let engine: TestEngine;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

async function newProject(name: string): Promise<{ id: string; apiKey: string }> {
  const res = await engine.json("/api/v1/projects", post({ name }, null));
  expect(res.status).toBe(201);
  const project = (res.body as { project: { _id?: string; id?: string; apiKey: string } }).project;
  return { id: project._id ?? (project as { id: string }).id, apiKey: project.apiKey };
}

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("API key rotation", () => {
  it("issues a new key and immediately stops accepting the old one", async () => {
    const project = await newProject("Rotating project");
    expect((await engine.json("/api/v1/ingest/traces", { apiKey: project.apiKey })).status).toBe(200);

    const rotated = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", {
      method: "POST",
      apiKey: project.apiKey,
    });
    expect(rotated.status).toBe(200);
    const newKey = (rotated.body as { apiKey: string }).apiKey;
    expect(newKey).toBeTruthy();
    expect(newKey).not.toBe(project.apiKey);

    // No grace period, no cache: the old key is dead on the very next request.
    const withOld = await engine.request("/api/v1/ingest/traces", { apiKey: project.apiKey });
    expect(withOld.status, "the revoked key still worked").toBe(401);
    await withOld.text();

    const withNew = await engine.json("/api/v1/ingest/traces", { apiKey: newKey });
    expect(withNew.status).toBe(200);
  });

  it("rotates only the calling project's key", async () => {
    const [a, b] = [await newProject("Rotation A"), await newProject("Rotation B")];
    const rotated = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", { method: "POST", apiKey: a.apiKey });
    expect(rotated.status).toBe(200);

    // B is untouched...
    expect((await engine.json("/api/v1/ingest/traces", { apiKey: b.apiKey })).status).toBe(200);
    // ...and A's new key is not B's.
    expect((rotated.body as { apiKey: string }).apiKey).not.toBe(b.apiKey);
  });

  it("keeps the project's data reachable through the new key", async () => {
    const project = await newProject("Rotation keeps data");
    const ingested = await engine.json("/api/v1/ingest/traces", post({ name: "pre-rotation-agent", input: "q", output: "a" }, project.apiKey));
    const traceId = (ingested.body as { trace_id: string }).trace_id;

    const rotated = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", { method: "POST", apiKey: project.apiKey });
    const newKey = (rotated.body as { apiKey: string }).apiKey;

    const detail = await engine.json(`/api/v1/ingest/traces/${traceId}`, { apiKey: newKey });
    expect(detail.status, "rotating the key orphaned the project's data").toBe(200);
    expect(JSON.stringify(detail.body)).toContain("pre-rotation-agent");
  });

  it("survives a restart with the rotated key, not the original", async () => {
    const project = await newProject("Rotation across restart");
    const rotated = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", { method: "POST", apiKey: project.apiKey });
    const newKey = (rotated.body as { apiKey: string }).apiKey;

    const home = engine.home;
    await engine.stop({ keepHome: true });
    engine = await startEngine({}, { home });

    expect((await engine.json("/api/v1/ingest/traces", { apiKey: newKey })).status).toBe(200);
    const withOld = await engine.request("/api/v1/ingest/traces", { apiKey: project.apiKey });
    expect(withOld.status, "a revoked key came back to life after a restart").toBe(401);
    await withOld.text();
  }, 120_000);
});

describe("project monitoring settings", () => {
  it("serves defaults and accepts an update, scoped to the project", async () => {
    const [a, b] = [await newProject("Settings A"), await newProject("Settings B")];

    const before = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: a.apiKey });
    expect(before.status).toBe(200);

    const updated = await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      ...post({ latencyThresholdMs: 1234, retentionDays: 7, sampleRate: 1, coverageMode: "all" }, a.apiKey),
      method: "PUT",
    });
    expect(updated.status, JSON.stringify(updated.body)).toBeLessThan(300);

    const afterA = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: a.apiKey });
    expect(JSON.stringify(afterA.body)).toContain("1234");

    const afterB = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: b.apiKey });
    expect(JSON.stringify(afterB.body), "one project's settings leaked into another").not.toContain("1234");
  });

  it("applies the project's own latency threshold when detecting a slow response", async () => {
    const project = await newProject("Latency threshold project");
    await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      ...post({ latencyThresholdMs: 500 }, project.apiKey),
      method: "PUT",
    });

    await engine.json("/api/v1/ingest/traces", post({ name: "slow-agent", input: "q", output: "an answer", latency_ms: 900 }, project.apiKey));

    const deadline = Date.now() + 15_000;
    let signal: unknown;
    while (Date.now() < deadline && !signal) {
      const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: project.apiKey });
      signal = ((res.body as { signals?: { patternKey?: string }[] }).signals ?? []).find(s => s.patternKey === "latency-regression");
      if (!signal) await new Promise(r => setTimeout(r, 150));
    }
    expect(signal, "a 900ms response did not trip a 500ms threshold").toBeTruthy();
  }, 40_000);

  it("does not flag a response that sits under the project's threshold", async () => {
    const project = await newProject("Fast enough project");
    await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      ...post({ latencyThresholdMs: 5_000 }, project.apiKey),
      method: "PUT",
    });
    await engine.json("/api/v1/ingest/traces", post({ name: "brisk-agent", input: "q", output: "an answer", latency_ms: 900 }, project.apiKey));
    await new Promise(r => setTimeout(r, 1_500));

    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: project.apiKey });
    const flagged = ((res.body as { signals?: { patternKey?: string }[] }).signals ?? []).filter(s => s.patternKey === "latency-regression");
    expect(flagged).toEqual([]);
  }, 40_000);
});
