import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// Version numbers are derived (read currentVersion, add one) - the same read-then-write shape
// that broke span dedup - and a lost or reused number here is a silently corrupted history.

let engine: TestEngine;
let key: string;

const body = (payload: unknown, method = "POST"): RequestInit & { apiKey?: string | null } => ({
  method,
  body: JSON.stringify(payload),
  headers: { "content-type": "application/json" },
  apiKey: key,
});

const get = (): RequestInit & { apiKey?: string | null } => ({ apiKey: key });

beforeAll(async () => {
  engine = await startEngine();
  const project = await engine.json("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Registry project" }),
    headers: { "content-type": "application/json" },
    apiKey: null,
  });
  expect(project.status).toBe(201);
  key = (project.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

async function createPrompt(name: string, text = "You are a helpful support agent.") {
  const res = await engine.json("/api/v1/evaluate/prompts", body({ name, text, description: "d" }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { _id?: string; id?: string; currentVersion: number; name: string };
}

const idOf = (record: { _id?: string; id?: string }) => record._id ?? (record as { id: string }).id;

describe("prompt registry", () => {
  it("creates a prompt at version 1 and lists it", async () => {
    const prompt = await createPrompt("support-prompt");
    expect(prompt.currentVersion).toBe(1);

    const list = await engine.json("/api/v1/evaluate/prompts", get());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain("support-prompt");
  });

  it("requires both a name and text", async () => {
    expect((await engine.json("/api/v1/evaluate/prompts", body({ text: "t" }))).status).toBe(400);
    expect((await engine.json("/api/v1/evaluate/prompts", body({ name: "n" }))).status).toBe(400);
    expect((await engine.json("/api/v1/evaluate/prompts", body({ name: "  ", text: "  " }))).status).toBe(400);
  });

  it("increments the version on every publish and keeps the history", async () => {
    const prompt = await createPrompt("versioned-prompt");
    const id = idOf(prompt);

    for (const [index, text] of ["second draft", "third draft"].entries()) {
      const published = await engine.json(`/api/v1/evaluate/prompts/${id}/versions`, body({ text, source: "manual" }));
      expect(published.status, JSON.stringify(published.body)).toBe(201);
      expect((published.body as { version: number }).version).toBe(index + 2);
    }

    const detail = await engine.json(`/api/v1/evaluate/prompts/${id}`, get());
    expect(detail.status).toBe(200);
    expect((detail.body as { currentVersion: number }).currentVersion).toBe(3);
    const serialized = JSON.stringify(detail.body);
    expect(serialized).toContain("second draft");
    expect(serialized).toContain("third draft");
    // The original is still there - a version history that drops v1 is not a history.
    expect(serialized).toContain("You are a helpful support agent.");
  });

  it("records where a version came from", async () => {
    const id = idOf(await createPrompt("sourced-prompt"));
    await engine.json(
      `/api/v1/evaluate/prompts/${id}/versions`,
      body({ text: "improved by the sweep", source: "proposed", reasoning: "worst-rated cases mentioned tone", basedOnVersion: 1 })
    );
    const detail = await engine.json(`/api/v1/evaluate/prompts/${id}`, get());
    const serialized = JSON.stringify(detail.body);
    expect(serialized).toContain("proposed");
    expect(serialized).toContain("worst-rated cases mentioned tone");
  });

  it("treats an unrecognised source as a manual edit rather than trusting it", async () => {
    const id = idOf(await createPrompt("source-guard-prompt"));
    const published = await engine.json(`/api/v1/evaluate/prompts/${id}/versions`, body({ text: "x", source: "auto-approved" }));
    expect(published.status).toBe(201);
    const detail = await engine.json(`/api/v1/evaluate/prompts/${id}`, get());
    expect(JSON.stringify(detail.body)).not.toContain("auto-approved");
  });

  it("rejects an empty version body and an unknown prompt", async () => {
    const id = idOf(await createPrompt("guarded-prompt"));
    expect((await engine.json(`/api/v1/evaluate/prompts/${id}/versions`, body({ text: "   " }))).status).toBe(400);
    expect((await engine.json("/api/v1/evaluate/prompts/nope/versions", body({ text: "t" }))).status).toBe(404);
    expect((await engine.json("/api/v1/evaluate/prompts/nope", get())).status).toBe(404);
  });

  it("never issues the same version number twice, even for simultaneous publishes", async () => {
    const id = idOf(await createPrompt("raced-prompt"));

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => engine.json(`/api/v1/evaluate/prompts/${id}/versions`, body({ text: `concurrent ${i}` })))
    );

    const succeeded = responses.filter(r => r.status === 201);
    const versions = succeeded.map(r => (r.body as { version: number }).version);
    expect(new Set(versions).size, `duplicate version numbers issued: ${versions.join(", ")}`).toBe(versions.length);

    // Whatever did not make it must have been refused cleanly, not with a raw database error.
    for (const failed of responses.filter(r => r.status !== 201)) {
      expect(failed.status, JSON.stringify(failed.body)).toBeLessThan(500);
    }

    // And the record's currentVersion must match the history rather than drifting behind it.
    const detail = await engine.json(`/api/v1/evaluate/prompts/${id}`, get());
    const record = detail.body as { currentVersion: number; versions?: { version: number }[] };
    const historyMax = Math.max(...(record.versions ?? []).map(v => v.version), 1);
    expect(record.currentVersion).toBe(historyMax);
  }, 60_000);

  it("deletes a prompt along with its versions", async () => {
    const id = idOf(await createPrompt("doomed-prompt"));
    await engine.json(`/api/v1/evaluate/prompts/${id}/versions`, body({ text: "v2" }));

    const deleted = await engine.json(`/api/v1/evaluate/prompts/${id}`, { method: "DELETE", apiKey: key });
    expect(deleted.status).toBeLessThan(300);
    expect((await engine.json(`/api/v1/evaluate/prompts/${id}`, get())).status).toBe(404);
    expect((await engine.json(`/api/v1/evaluate/prompts/${id}`, { method: "DELETE", apiKey: key })).status).toBe(404);
  });

  it("keeps prompts scoped to their project", async () => {
    const other = await engine.json("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Other registry project" }),
      headers: { "content-type": "application/json" },
      apiKey: null,
    });
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;

    const prompt = await createPrompt("private-prompt");
    const id = idOf(prompt);
    expect((await engine.json(`/api/v1/evaluate/prompts/${id}`, { apiKey: otherKey })).status).toBe(404);
    const list = await engine.json("/api/v1/evaluate/prompts", { apiKey: otherKey });
    expect(JSON.stringify(list.body)).not.toContain("private-prompt");
  });
});

describe("tool schema registry", () => {
  // `definition` is the JSON-schema text as a string, not a nested object - the registry stores
  // exactly what a provider would be sent.
  const definitionFor = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name,
      description: "Look up an order by id",
      parameters: { type: "object", properties: { orderId: { type: "string" }, ...extra }, required: ["orderId"] },
    });

  async function createToolSchema(name: string) {
    const res = await engine.json("/api/v1/evaluate/tool-schemas", body({ name, definition: definitionFor(name), description: "d" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { _id?: string; id?: string; currentVersion: number };
  }

  it("creates a tool schema at version 1 and serves it back", async () => {
    const tool = await createToolSchema("lookup_order");
    expect(tool.currentVersion).toBe(1);
    const detail = await engine.json(`/api/v1/evaluate/tool-schemas/${idOf(tool)}`, get());
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain("orderId");
  });

  it("increments the version on publish and keeps the earlier schema", async () => {
    const tool = await createToolSchema("cancel_order");
    const id = idOf(tool);
    const next = definitionFor("cancel_order", { reason: { type: "string" } });
    const published = await engine.json(`/api/v1/evaluate/tool-schemas/${id}/versions`, body({ definition: next, source: "manual" }));
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    const detail = await engine.json(`/api/v1/evaluate/tool-schemas/${id}`, get());
    expect((detail.body as { currentVersion: number }).currentVersion).toBe(2);
    expect(JSON.stringify(detail.body)).toContain("reason");
  });

  it("never issues the same version number twice under simultaneous publishes", async () => {
    const id = idOf(await createToolSchema("raced_tool"));
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        engine.json(
          `/api/v1/evaluate/tool-schemas/${id}/versions`,
          body({ definition: definitionFor("raced_tool", { [`field${i}`]: { type: "string" } }) })
        )
      )
    );
    const versions = responses.filter(r => r.status === 201).map(r => (r.body as { version?: number }).version);
    const numbered = versions.filter((v): v is number => typeof v === "number");
    expect(new Set(numbered).size, `duplicate version numbers: ${numbered.join(", ")}`).toBe(numbered.length);
    for (const failed of responses.filter(r => r.status !== 201)) {
      expect(failed.status, JSON.stringify(failed.body)).toBeLessThan(500);
    }
  }, 60_000);

  it("requires both a name and a definition", async () => {
    expect((await engine.json("/api/v1/evaluate/tool-schemas", body({ definition: definitionFor("x") }))).status).toBe(400);
    expect((await engine.json("/api/v1/evaluate/tool-schemas", body({ name: "x" }))).status).toBe(400);
    expect((await engine.json("/api/v1/evaluate/tool-schemas", body({ name: "x", definition: "  " }))).status).toBe(400);
  });

  it("rejects a non-http test endpoint", async () => {
    const res = await engine.json(
      "/api/v1/evaluate/tool-schemas",
      body({ name: "bad_endpoint", definition: definitionFor("bad_endpoint"), testEndpointUrl: "file:///etc/passwd" })
    );
    expect(res.status).toBe(400);
  });

  it("404s an unknown tool schema on read, publish and delete", async () => {
    expect((await engine.json("/api/v1/evaluate/tool-schemas/nope", get())).status).toBe(404);
    expect((await engine.json("/api/v1/evaluate/tool-schemas/nope/versions", body({ definition: definitionFor("x") }))).status).toBe(404);
    expect((await engine.json("/api/v1/evaluate/tool-schemas/nope", { method: "DELETE", apiKey: key })).status).toBe(404);
  });

  it("keeps tool schemas scoped to their project", async () => {
    const other = await engine.json("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Other tool project" }),
      headers: { "content-type": "application/json" },
      apiKey: null,
    });
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const tool = await createToolSchema("private_tool");
    expect((await engine.json(`/api/v1/evaluate/tool-schemas/${idOf(tool)}`, { apiKey: otherKey })).status).toBe(404);
  });
});
