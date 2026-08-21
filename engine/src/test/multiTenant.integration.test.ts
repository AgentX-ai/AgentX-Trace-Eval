import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// The cloud posture: AGENTX_AUTH=enabled + AGENTX_MULTI_TENANT=true. The question this suite
// answers is the one that matters for eval.agentx.so: can two strangers who sign up ever see
// each other's anything - projects, data, LLM keys, pricing catalog - and does the invitation
// flow remain the only door between organizations.

let engine: TestEngine;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(";")[0]).join("; ");
}

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await engine.request("/api/v1/auth/sign-up/email", { ...json({ email, password, name }), apiKey: null });
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

// engine.json types body as unknown; these tests assert deep into responses, so one loose
// cast at the access site keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: { body: unknown }): any => res.body;

const asUser = (cookie: string, init: RequestInit = {}): RequestInit & { apiKey: null } => ({
  ...init,
  apiKey: null,
  headers: { ...(init.headers as Record<string, string> | undefined), cookie },
});

let aliceCookie = "";
let bobCookie = "";
let aliceKey = "";
let bobKey = "";
let aliceOrgId = "";

beforeAll(async () => {
  engine = await startEngine({ AGENTX_AUTH: "enabled", AGENTX_MULTI_TENANT: "true" });
  aliceCookie = await signUp("alice@tenant-a.test", "correct-horse-battery", "Alice");
  bobCookie = await signUp("bob@tenant-b.test", "correct-horse-battery", "Bob");
}, 120_000);

afterAll(async () => {
  await engine?.stop();
});

describe("multi-tenant signup", () => {
  it("gives each signup its own organization and seeded default project", async () => {
    const aliceProjects = await engine.json("/api/v1/projects", asUser(aliceCookie));
    const bobProjects = await engine.json("/api/v1/projects", asUser(bobCookie));
    expect(aliceProjects.status).toBe(200);
    expect(bobProjects.status).toBe(200);
    expect(bodyOf(aliceProjects).projects).toHaveLength(1);
    expect(bodyOf(bobProjects).projects).toHaveLength(1);
    aliceKey = bodyOf(aliceProjects).projects[0].apiKey;
    bobKey = bodyOf(bobProjects).projects[0].apiKey;
    expect(aliceKey).not.toBe(bobKey);
    expect(bodyOf(aliceProjects).projects[0]._id).not.toBe(bodyOf(bobProjects).projects[0]._id);

    const orgs = await engine.json("/api/v1/auth-org/organizations", asUser(aliceCookie));
    expect(orgs.status).toBe(200);
    expect(bodyOf(orgs).organizations).toHaveLength(1);
    expect(bodyOf(orgs).organizations[0].role).toBe("owner");
    expect(bodyOf(orgs).organizations[0].name).toContain("Alice");
    aliceOrgId = bodyOf(orgs).organizations[0]._id;

    const bobOrgs = await engine.json("/api/v1/auth-org/organizations", asUser(bobCookie));
    expect(bodyOf(bobOrgs).organizations[0]._id).not.toBe(aliceOrgId);
  });

  it("seeds each tenant's project with starter content", async () => {
    const configs = await engine.json("/api/v1/evaluate/evaluationSettings?kind=config", { apiKey: aliceKey });
    expect(configs.status).toBe(200);
    // Example judge + Session Baseline Judge + the RAG metric pack.
    expect(bodyOf(configs).evaluationSettings.length).toBeGreaterThanOrEqual(6);
  });
});

describe("data isolation", () => {
  it("keeps traces invisible across tenants", async () => {
    const ingest = await engine.json("/api/v1/ingest/traces", {
      ...json({ name: "alice-agent", input: "hi", output: "hello from alice's tenant" }),
      apiKey: aliceKey,
    });
    expect(ingest.status).toBe(200);

    const aliceView = await engine.json("/api/v1/ingest/traces?limit=10", { apiKey: aliceKey });
    const bobView = await engine.json("/api/v1/ingest/traces?limit=10", { apiKey: bobKey });
    expect(bodyOf(aliceView).traces.some((t: { name: string }) => t.name === "alice-agent")).toBe(true);
    expect(bodyOf(bobView).traces.some((t: { name: string }) => t.name === "alice-agent")).toBe(false);
  });

  it("keeps LLM provider keys per-organization", async () => {
    const set = await engine.request("/api/v1/agent-monitoring/settings/llm-keys", {
      method: "PUT",
      body: JSON.stringify({ openaiApiKey: "sk-alice-secret" }),
      headers: { "content-type": "application/json" },
      apiKey: aliceKey,
    });
    expect(set.status).toBe(200);

    const aliceSettings = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: aliceKey });
    const bobSettings = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: bobKey });
    // Masked on the wire - configured presence is what's being asserted.
    expect(bodyOf(aliceSettings).llm.openai.configured).toBe(true);
    expect(bodyOf(bobSettings).llm.openai.configured).toBe(false);
  });

  it("keeps pricing-catalog additions per-organization, globals read-only", async () => {
    const create = await engine.json("/api/v1/agent-monitoring/portability/models", {
      ...json({ id: "alice-custom-model", provider: "custom", label: "Alice vLLM", pricePerMInputTokens: 1, pricePerMOutputTokens: 2, baseUrl: "http://localhost:9" }),
      apiKey: aliceKey,
    });
    expect(create.status).toBe(201);

    const bobList = await engine.json("/api/v1/agent-monitoring/portability/models", { apiKey: bobKey });
    const bobIds = bodyOf(bobList).models.map((m: { _id: string }) => m._id);
    expect(bobIds).not.toContain("alice-custom-model");
    // Globals are visible to everyone...
    expect(bobIds.length).toBeGreaterThan(0);
    // ...but not editable by a tenant.
    const globalId = bobIds[0];
    const del = await engine.request(`/api/v1/agent-monitoring/portability/models/${globalId}`, {
      method: "DELETE",
      apiKey: bobKey,
    });
    expect(del.status).toBe(404);
  });
});

describe("invitations", () => {
  it("is the only door into another org: invite, accept, shared visibility", async () => {
    // Bob cannot list Alice's members before joining.
    const before = await engine.json(`/api/v1/auth-org/organizations/${aliceOrgId}/members`, asUser(bobCookie));
    expect(before.status).toBe(403);

    const invite = await engine.json(`/api/v1/auth-org/organizations/${aliceOrgId}/invitations`, {
      ...asUser(aliceCookie, json({ email: "bob@tenant-b.test", role: "member" })),
    });
    expect(invite.status).toBe(201);
    const token = bodyOf(invite).invitation._id;

    // A third party with a different email cannot accept Bob's invite.
    const malloryCookie = await signUp("mallory@tenant-c.test", "correct-horse-battery", "Mallory");
    const stolen = await engine.json(`/api/v1/auth-org/invitations/${token}/accept`, asUser(malloryCookie, { method: "POST" }));
    expect(stolen.status).toBe(403);

    const accept = await engine.json(`/api/v1/auth-org/invitations/${token}/accept`, asUser(bobCookie, { method: "POST" }));
    expect(accept.status).toBe(200);

    // Bob now sees both his own project and Alice's org's project.
    const bobProjects = await engine.json("/api/v1/projects", asUser(bobCookie));
    expect(bodyOf(bobProjects).projects.length).toBe(2);

    // Re-using the invitation fails.
    const reuse = await engine.json(`/api/v1/auth-org/invitations/${token}/accept`, asUser(bobCookie, { method: "POST" }));
    expect(reuse.status).toBe(404);
  });

  it("only owners/admins can invite or remove; the owner cannot be removed", async () => {
    const bobInvites = await engine.json(`/api/v1/auth-org/organizations/${aliceOrgId}/invitations`, {
      ...asUser(bobCookie, json({ email: "mallory@tenant-c.test" })),
    });
    expect(bobInvites.status).toBe(403);

    const members = await engine.json(`/api/v1/auth-org/organizations/${aliceOrgId}/members`, asUser(aliceCookie));
    expect(members.status).toBe(200);
    const owner = bodyOf(members).members.find((m: { role: string }) => m.role === "owner");
    const bobMember = bodyOf(members).members.find((m: { email: string }) => m.email === "bob@tenant-b.test");
    expect(owner).toBeTruthy();
    expect(bobMember).toBeTruthy();

    const removeOwner = await engine.request(`/api/v1/auth-org/organizations/${aliceOrgId}/members/${owner._id}`, {
      method: "DELETE",
      ...asUser(aliceCookie),
    });
    expect(removeOwner.status).toBe(400);

    const removeBob = await engine.request(`/api/v1/auth-org/organizations/${aliceOrgId}/members/${bobMember._id}`, {
      method: "DELETE",
      ...asUser(aliceCookie),
    });
    expect(removeBob.status).toBe(200);

    const bobProjects = await engine.json("/api/v1/projects", asUser(bobCookie));
    expect(bodyOf(bobProjects).projects.length).toBe(1);
  });
});
