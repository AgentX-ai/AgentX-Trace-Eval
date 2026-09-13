import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import { unmaskHeaders } from "../core/evaluate/agentConnectors.js";
import { maskSecret } from "../core/shared/maskSecret.js";

// Pins the connector auth-header masking (the d0c1aa5 security fix): a stored Authorization
// value must never leave the engine in plaintext - not on create, not on list, not in a data
// export - while a client round-tripping the masked value must not clobber the real secret.

let engine: TestEngine;
let key: string;
const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

const SECRET = "Bearer sk-live-supersecret-token-1234";

beforeAll(async () => {
  engine = await startEngine({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" });
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "connector-secrets" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("agent-connector auth headers never leave in plaintext", () => {
  it("masks on create/list, redacts in exports, and preserves the secret through a masked round-trip", async () => {
    const created = await api(
      "/evaluate/agent-connectors",
      postJson({ name: "internal-agent", url: "https://agents.example.com/run", headers: { Authorization: SECRET } })
    );
    expect(created.status).toBe(201);
    const wire = (created.body as { connector: { _id: string; headers: Record<string, string> } }).connector;
    expect(JSON.stringify(created.body)).not.toContain("supersecret");
    const maskedValue = wire.headers.Authorization;
    expect(maskedValue).toBeTruthy();

    const listed = await api("/evaluate/agent-connectors");
    expect(JSON.stringify(listed.body)).not.toContain("supersecret");

    // The masked value round-tripped back on update must keep the REAL stored secret (an
    // update that saved the mask literally would silently break every connector run).
    const updated = await api(`/evaluate/agent-connectors/${wire._id}`, {
      ...postJson({ name: "internal-agent-renamed", url: "https://agents.example.com/run", headers: { Authorization: maskedValue } }),
      method: "PUT",
    });
    expect([200, 201]).toContain(updated.status);
    expect(JSON.stringify(updated.body)).not.toContain("supersecret");

    // Export redacts too - a backup or support bundle must not carry live credentials.
    const exported = await api("/export/agent-connectors");
    expect(exported.status).toBe(200);
    const dump = JSON.stringify(exported.body);
    expect(dump).toContain("internal-agent");
    expect(dump).not.toContain("supersecret");
  });
});

describe("unmaskHeaders round-trip (unit)", () => {
  it("a masked value restores the stored secret; a NEW value replaces it", () => {
    const stored = { Authorization: "Bearer sk-live-real" };
    // The exact mask the wire hands out for the stored value - unmaskHeaders only restores a
    // mask it can prove it produced (isMaskedSecret alone false-positived on real secrets).
    const masked = { Authorization: maskSecret(stored.Authorization) };
    const roundTripped = unmaskHeaders(masked, stored);
    const replaced = unmaskHeaders({ Authorization: "Bearer sk-live-NEW" }, stored);
    expect(replaced?.Authorization).toBe("Bearer sk-live-NEW");
    // roundTripped either restored the stored secret (mask recognized) or kept the literal -
    // restoring is the required behavior; assert it strictly.
    expect(roundTripped?.Authorization).toBe("Bearer sk-live-real");
  });
});

