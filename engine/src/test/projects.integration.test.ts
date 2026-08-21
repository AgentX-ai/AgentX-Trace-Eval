import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { startEngine, type TestEngine } from "./server.js";

// Self-host went from one API key per instance to one key per project, and the key alone is what
// selects the project (auth/apiKey.ts). That makes every read path a potential cross-project
// leak: nothing in a request names the project, so a query that forgets its projectId filter
// looks completely normal and returns another project's traffic.

let engine: TestEngine;
let keyA: string;
let keyB: string;

const post = (body: unknown, apiKey?: string | null): RequestInit & { apiKey?: string | null } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  ...(apiKey === undefined ? {} : { apiKey }),
});

beforeAll(async () => {
  engine = await startEngine();
  keyA = engine.apiKey;
  const created = await engine.json("/api/v1/projects", post({ name: "Second project" }, null));
  expect(created.status).toBe(201);
  keyB = (created.body as { project: { apiKey: string } }).project.apiKey;
  expect(keyB).toBeTruthy();
  expect(keyB).not.toBe(keyA);
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("project isolation", () => {
  it("keeps ingested traces out of another project's trace list", async () => {
    const ingested = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "project-a-agent", input: "secret question", output: "secret answer" }, keyA)
    );
    expect(ingested.status).toBe(200);
    const traceId = (ingested.body as { trace_id: string }).trace_id;

    const listA = await engine.json("/api/v1/ingest/traces", { apiKey: keyA });
    const listB = await engine.json("/api/v1/ingest/traces", { apiKey: keyB });
    const idsOf = (body: unknown) => ((body as { traces?: { _id: string }[] }).traces ?? []).map(t => t._id);

    expect(idsOf(listA.body)).toContain(traceId);
    expect(idsOf(listB.body)).not.toContain(traceId);
    expect(JSON.stringify(listB.body)).not.toContain("secret answer");
  });

  it("404s a direct fetch of another project's trace by id", async () => {
    const ingested = await engine.json("/api/v1/ingest/traces", post({ name: "a", input: "q", output: "a" }, keyA));
    const traceId = (ingested.body as { trace_id: string }).trace_id;

    expect((await engine.json(`/api/v1/ingest/traces/${traceId}`, { apiKey: keyA })).status).toBe(200);
    expect((await engine.json(`/api/v1/ingest/traces/${traceId}`, { apiKey: keyB })).status).toBe(404);
  });

  it("keeps session spans out of another project's session view", async () => {
    await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "a", session_id: "shared-session-id", span_id: "a-span", input: "q", output: "a" }, keyA)
    );
    const spansB = await engine.json("/api/v1/ingest/sessions/shared-session-id/spans", { apiKey: keyB });
    expect(spansB.status).toBe(200);
    expect((spansB.body as { spans: unknown[] }).spans).toEqual([]);
  });

  it("scopes span-id deduplication per project", async () => {
    // The same OTel span id can legitimately appear in two projects; deduplication must not make
    // the second project's ingest silently resolve to the first project's row.
    const body = { name: "dup", span_id: "identical-span-id", input: "q", output: "a" };
    const inA = await engine.json("/api/v1/ingest/traces", post(body, keyA));
    const inB = await engine.json("/api/v1/ingest/traces", post(body, keyB));
    expect(inA.status).toBe(200);
    expect(inB.status).toBe(200);
    expect((inB.body as { trace_id: string }).trace_id).not.toBe((inA.body as { trace_id: string }).trace_id);

    // ...but a replay within one project still dedupes to the same row.
    const replay = await engine.json("/api/v1/ingest/traces", post(body, keyA));
    expect((replay.body as { trace_id: string }).trace_id).toBe((inA.body as { trace_id: string }).trace_id);
  });

  it("keeps agents registered by one project out of the other's agent list", async () => {
    await engine.json("/api/v1/ingest/traces", post({ name: "project-a-only-agent", input: "q", output: "a" }, keyA));
    const agentsB = await engine.json("/api/v1/agents", { apiKey: keyB });
    expect(agentsB.status).toBe(200);
    expect(JSON.stringify(agentsB.body)).not.toContain("project-a-only-agent");
  });

  it("keeps monitor patterns out of another project's pattern list", async () => {
    const created = await engine.json(
      "/api/v1/agent-monitoring/patterns",
      post({ name: "project-a-pattern", severity: "high", conditions: [{ connector: "and", negate: false, sources: ["response"], detector: "phrase", value: "zzz", caseSensitive: false }] }, keyA)
    );
    expect(created.status).toBeLessThan(300);
    const listB = await engine.json("/api/v1/agent-monitoring/patterns", { apiKey: keyB });
    expect(JSON.stringify(listB.body)).not.toContain("project-a-pattern");
  });

  it("keeps datasets out of another project's dataset list", async () => {
    const created = await engine.json(
      "/api/v1/custom-agent-evaluations/datasets",
      post({ name: "project-a-dataset", cases: [{ input: "q", expectedResults: "a" }] }, keyA)
    );
    expect(created.status).toBeLessThan(300);
    const listB = await engine.json("/api/v1/custom-agent-evaluations/datasets", { apiKey: keyB });
    expect(JSON.stringify(listB.body)).not.toContain("project-a-dataset");
  });

  it("rejects an unknown API key everywhere rather than falling back to a default project", async () => {
    for (const path of [
      "/api/v1/ingest/traces",
      "/api/v1/agents",
      "/api/v1/agent-monitoring/signals",
      "/api/v1/evaluate/list",
      "/api/v1/custom-agent-evaluations/datasets",
    ]) {
      const res = await engine.request(path, { apiKey: "agtx_local_not_a_real_key" });
      expect(res.status, `${path} accepted a bogus key`).toBe(401);
      await res.text();
    }
  });

  it("rejects a missing API key", async () => {
    const res = await engine.request("/api/v1/ingest/traces", { apiKey: null });
    expect(res.status).toBe(401);
    await res.text();
  });
});

// Deleting a project is the one destructive project operation, and the rows it has to clear are
// only reachable by project id - so a miss is invisible through the API and only shows up as
// storage that never goes away. These assert against the database file, not just the response.
describe("project deletion", () => {
  const projectsDb = () => new Database(path.join(engine.home, "agentx.db"), { readonly: true });

  const createProject = async (name: string) => {
    const created = await engine.json("/api/v1/projects", post({ name }, null));
    expect(created.status).toBe(201);
    return (created.body as { project: { _id: string; apiKey: string } }).project;
  };

  it("removes the project and every row scoped to it", async () => {
    const doomed = await createProject("Doomed project");
    const ingested = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "doomed-agent", input: "q", output: "a" }, doomed.apiKey)
    );
    expect(ingested.status).toBe(200);

    const before = projectsDb();
    const countIn = (db: InstanceType<typeof Database>, table: string) =>
      (db.prepare(`select count(*) as n from ${table} where project_id = ?`).get(doomed._id) as { n: number }).n;
    expect(countIn(before, "traces")).toBeGreaterThan(0);
    // The engine seeds a baseline judge + metric-pack configs on create, so this is non-empty too.
    expect(countIn(before, "evaluation_settings")).toBeGreaterThan(0);
    before.close();

    const deleted = await engine.request(`/api/v1/projects/${doomed._id}`, { method: "DELETE", apiKey: keyA });
    expect(deleted.status).toBe(204);
    await deleted.text();

    const after = projectsDb();
    for (const table of ["traces", "evaluation_settings", "monitor_online_evaluators", "agents"]) {
      expect(countIn(after, table), `${table} kept rows for a deleted project`).toBe(0);
    }
    expect((after.prepare("select count(*) as n from projects where id = ?").get(doomed._id) as { n: number }).n).toBe(
      0
    );
    after.close();
  });

  it("stops accepting the deleted project's API key", async () => {
    const doomed = await createProject("Key revoked on delete");
    expect((await engine.json("/api/v1/ingest/traces", { apiKey: doomed.apiKey })).status).toBe(200);

    const deleted = await engine.request(`/api/v1/projects/${doomed._id}`, { method: "DELETE", apiKey: keyA });
    expect(deleted.status).toBe(204);
    await deleted.text();

    const res = await engine.request("/api/v1/ingest/traces", { apiKey: doomed.apiKey });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("refuses to delete the default project", async () => {
    const list = await engine.json("/api/v1/projects", { apiKey: keyA });
    const projects = (list.body as { projects: { _id: string; isDefault?: boolean }[] }).projects;
    const fallback = projects.find(p => p.isDefault);
    expect(fallback, "no default project to test against").toBeTruthy();

    const res = await engine.json(`/api/v1/projects/${fallback!._id}`, { method: "DELETE", apiKey: keyA });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("default project");

    const still = await engine.json("/api/v1/projects", { apiKey: keyA });
    expect((still.body as { projects: { _id: string }[] }).projects.map(p => p._id)).toContain(fallback!._id);
  });

  it("404s an unknown project id", async () => {
    const res = await engine.json("/api/v1/projects/not-a-real-project", { method: "DELETE", apiKey: keyA });
    expect(res.status).toBe(404);
  });

  it("refuses an unauthenticated delete", async () => {
    const doomed = await createProject("Needs a key to delete");
    const res = await engine.request(`/api/v1/projects/${doomed._id}`, { method: "DELETE", apiKey: null });
    expect(res.status).toBe(401);
    await res.text();

    const list = await engine.json("/api/v1/projects", { apiKey: keyA });
    expect((list.body as { projects: { _id: string }[] }).projects.map(p => p._id)).toContain(doomed._id);
  });
});
