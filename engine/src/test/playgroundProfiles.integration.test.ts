import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Saved Playground workbenches. The bug this closes: "Save as prompt" stored the prompt text and
// nothing else, so the tools and MCP servers someone had just wired up were gone on reload.
// Pinned here - the whole setup round-trips, an MCP OAuth session handle is never stored even
// when a client sends one, and a saved workbench survives a backup.

let engine: TestEngine;
let key: string;
let profileId: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const config = () => ({
  messages: [{ role: "system", content: "You are a careful support agent." }],
  tools: [
    {
      name: "check_order_status",
      description: "Look up an order",
      parametersText: '{"type":"object","properties":{"orderId":{"type":"string"}}}',
      endpointUrl: "https://tools.example.com/orders",
    },
    {
      name: "stripe_lookup",
      parametersText: "{}",
      endpointUrl: "https://mcp.example.com/sse",
      mcpServer: "https://mcp.example.com/sse",
    },
  ],
  models: { ids: ["gpt-5.6-luna", "claude-x"], settings: { "gpt-5.6-luna": { temperature: "0.2" } } },
  scorers: { evaluationSettingsId: null, patternIds: ["pii-in-response"], onlineEvaluatorIds: ["oe-1"] },
  testInput: { mode: "query" as const, questionIndexes: [], query: "where is my order?" },
});

type ProfileWire = {
  _id: string;
  name: string;
  promptId: string | null;
  config: ReturnType<typeof config>;
};

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "profiles" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("playground profiles", () => {
  it("saves the whole workbench, not just the prompt", async () => {
    const created = await api("/evaluate/playground/profiles", postJson({ name: "Support agent v3", config: config() }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const profile = (created.body as { profile: ProfileWire }).profile;
    profileId = profile._id;

    // The thing that was being lost: tools and their MCP servers.
    expect(profile.config.tools).toHaveLength(2);
    expect(profile.config.tools[0]!.name).toBe("check_order_status");
    expect(profile.config.tools[1]!.mcpServer).toBe("https://mcp.example.com/sse");
    // ...alongside everything else that makes a run reproducible.
    expect(profile.config.models.ids).toEqual(["gpt-5.6-luna", "claude-x"]);
    expect(profile.config.scorers.patternIds).toEqual(["pii-in-response"]);
    expect(profile.config.testInput.query).toBe("where is my order?");
    expect(profile.config.messages[0]!.content).toContain("careful support agent");
  });

  it("never stores an MCP OAuth session handle, even when one is sent", async () => {
    const withSession = {
      ...config(),
      tools: [{ name: "stripe_lookup", endpointUrl: "https://mcp.example.com/sse", mcpSessionId: "sess-secret-123" }],
    };
    const created = await api("/evaluate/playground/profiles", postJson({ name: "leaky", config: withSession }));
    expect(created.status).toBe(201);
    const stored = (created.body as { profile: ProfileWire }).profile;
    expect(JSON.stringify(stored)).not.toContain("sess-secret-123");
    // The tool itself is kept - only the credential is dropped, so the row still reconnects.
    expect(stored.config.tools[0]!.endpointUrl).toBe("https://mcp.example.com/sse");

    // ...and it does not sneak in through an update either.
    const updated = await api(`/evaluate/playground/profiles/${stored._id}`, put({ config: withSession }));
    expect(JSON.stringify(updated.body)).not.toContain("sess-secret-123");

    const read = await api(`/evaluate/playground/profiles/${stored._id}`);
    expect(JSON.stringify(read.body)).not.toContain("sess-secret-123");
  });

  it("reads a saved workbench back unchanged", async () => {
    const read = await api(`/evaluate/playground/profiles/${profileId}`);
    expect(read.status).toBe(200);
    const profile = (read.body as { profile: ProfileWire }).profile;
    expect(profile.config).toEqual(config());
  });

  it("lists profiles, most recently updated first", async () => {
    const listed = (await api("/evaluate/playground/profiles")).body as { profiles: ProfileWire[] };
    expect(listed.profiles.length).toBeGreaterThanOrEqual(2);
    // "leaky" was written after "Support agent v3", so it leads.
    expect(listed.profiles[0]!.name).toBe("leaky");
  });

  it("updates one section without discarding the rest", async () => {
    const nextConfig = { ...config(), tools: [] };
    const updated = await api(`/evaluate/playground/profiles/${profileId}`, put({ config: nextConfig }));
    expect(updated.status).toBe(200);
    const profile = (updated.body as { profile: ProfileWire }).profile;
    expect(profile.config.tools).toEqual([]);
    // Name was not part of the patch and must survive it.
    expect(profile.name).toBe("Support agent v3");
    expect(profile.config.models.ids).toEqual(["gpt-5.6-luna", "claude-x"]);
  });

  it("refuses a nameless or malformed profile instead of storing a broken one", async () => {
    expect((await api("/evaluate/playground/profiles", postJson({ config: config() }))).status).toBe(400);
    expect((await api("/evaluate/playground/profiles", postJson({ name: "x" }))).status).toBe(400);
    const badMode = { ...config(), testInput: { mode: "telepathy", questionIndexes: [] } };
    expect((await api("/evaluate/playground/profiles", postJson({ name: "x", config: badMode }))).status).toBe(400);
  });

  it("404s an unknown profile on read, update and delete", async () => {
    expect((await api("/evaluate/playground/profiles/nope")).status).toBe(404);
    expect((await api("/evaluate/playground/profiles/nope", put({ name: "x" }))).status).toBe(404);
    expect((await api("/evaluate/playground/profiles/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("deletes a profile", async () => {
    const deleted = await api(`/evaluate/playground/profiles/${profileId}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await api(`/evaluate/playground/profiles/${profileId}`)).status).toBe(404);
  });

  it("saved workbenches are backed up", async () => {
    const manifest = await api("/export");
    const entry = (manifest.body as { entities: { entity: string; rows: number }[] }).entities.find(
      e => e.entity === "playground-profiles"
    );
    expect(entry?.rows).toBeGreaterThan(0);
  });
});
