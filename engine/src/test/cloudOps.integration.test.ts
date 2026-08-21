import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { startEngine, type TestEngine } from "./server.js";

// Phase 2/3 of the cloud posture: mail delivery (via the file-debug transport), daily quotas,
// the operator admin surface, and full organization deletion.

let engine: TestEngine;
let mailDir: string;

const ADMIN_TOKEN = "test-admin-token";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(";")[0]).join("; ");
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await engine.request("/api/v1/auth/sign-up/email", {
    ...json({ email, password: "correct-horse-battery", name }),
    apiKey: null,
  });
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

const asUser = (cookie: string, init: RequestInit = {}): RequestInit & { apiKey: null } => ({
  ...init,
  apiKey: null,
  headers: { ...(init.headers as Record<string, string> | undefined), cookie },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: { body: unknown }): any => res.body;

let carolCookie = "";
let carolKey = "";
let carolOrgId = "";

beforeAll(async () => {
  mailDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentx-mail-"));
  engine = await startEngine({
    AGENTX_AUTH: "enabled",
    AGENTX_MULTI_TENANT: "true",
    AGENTX_ADMIN_TOKEN: ADMIN_TOKEN,
    AGENTX_EMAIL_DEBUG_DIR: mailDir,
    AGENTX_QUOTA_TRACES_PER_DAY: "6",
    AGENTX_QUOTA_JUDGE_CALLS_PER_DAY: "1",
  });
  carolCookie = await signUp("carol@tenant.test", "Carol");
  const projects = await engine.json("/api/v1/projects", asUser(carolCookie));
  carolKey = bodyOf(projects).projects[0].apiKey;
  const orgs = await engine.json("/api/v1/auth-org/organizations", asUser(carolCookie));
  carolOrgId = bodyOf(orgs).organizations[0]._id;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  await fs.rm(mailDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("mailer", () => {
  it("reports email capability in the auth config", async () => {
    const config = await engine.json("/api/v1/auth/config", { apiKey: null });
    expect(bodyOf(config).emailEnabled).toBe(true);
    expect(bodyOf(config).socialProviders).toEqual([]);
    expect(bodyOf(config).verificationRequired).toBe(false);
  });

  it("sends the invitation email through the configured transport", async () => {
    const invite = await engine.json(`/api/v1/auth-org/organizations/${carolOrgId}/invitations`, {
      ...asUser(carolCookie, json({ email: "dave@tenant.test" })),
    });
    expect(invite.status).toBe(201);
    // The transport is fire-and-forget; give it a beat.
    await new Promise(r => setTimeout(r, 300));
    const files = await fs.readdir(mailDir);
    expect(files.length).toBeGreaterThan(0);
    const mail = JSON.parse(await fs.readFile(path.join(mailDir, files[0]!), "utf8"));
    expect(mail.to).toBe("dave@tenant.test");
    expect(mail.text).toContain("/accept-invite?token=");
  });
});

describe("quotas", () => {
  it("caps daily root-trace ingest per project, children ride free", async () => {
    // The tenant's seeded example project already ingested 3 starter traces - quota 6 leaves
    // room for exactly 3 more.
    for (let i = 0; i < 3; i++) {
      const ok = await engine.json("/api/v1/ingest/traces", {
        ...json({ name: "quota-agent", input: `q${i}`, output: "a" }),
        apiKey: carolKey,
      });
      expect(ok.status).toBe(200);
    }
    const over = await engine.json("/api/v1/ingest/traces", {
      ...json({ name: "quota-agent", input: "q4", output: "a" }),
      apiKey: carolKey,
    });
    expect(over.status).toBe(429);
    expect(bodyOf(over).error).toContain("quota");

    // A child span of an existing interaction is not a new interaction.
    const child = await engine.json("/api/v1/ingest/traces", {
      ...json({ name: "child", output: "x", session_id: "s1", span_id: "c1", parent_span_id: "r1" }),
      apiKey: carolKey,
    });
    expect(child.status).toBe(200);
  });

  it("caps judge calls per organization and names the quota in the error", async () => {
    // Quota is 1: the first judge attempt records usage (then fails on the missing LLM key -
    // fine, spend was committed either way); the second must be refused by the quota itself.
    await engine.json("/api/v1/agent-monitoring/patterns/generate-regex", {
      ...json({ description: "mentions a refund" }),
      apiKey: carolKey,
    });
    const second = await engine.json("/api/v1/agent-monitoring/patterns/generate-regex", {
      ...json({ description: "mentions a refund" }),
      apiKey: carolKey,
    });
    expect(JSON.stringify(second.body)).toContain("quota");
  });
});

describe("admin surface", () => {
  it("requires the operator token", async () => {
    const anonymous = await engine.json("/api/v1/admin/overview", { apiKey: null });
    expect(anonymous.status).toBe(401);
  });

  it("reports per-org usage", async () => {
    const overview = await engine.json("/api/v1/admin/overview", {
      apiKey: null,
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(overview.status).toBe(200);
    const carol = bodyOf(overview).organizations.find((o: { name: string }) => o.name.includes("Carol"));
    expect(carol).toBeTruthy();
    expect(carol.members).toBe(1);
    expect(carol.projects).toBe(1);
    expect(carol.traces24h).toBeGreaterThanOrEqual(3);
    expect(carol.judgeCalls24h).toBeGreaterThanOrEqual(1);
  });
});

describe("organization deletion", () => {
  it("is owner-only, name-confirmed, and takes all tenant data with it", async () => {
    const orgs = await engine.json("/api/v1/auth-org/organizations", asUser(carolCookie));
    const orgName = bodyOf(orgs).organizations[0].name;

    const wrongName = await engine.request(`/api/v1/auth-org/organizations/${carolOrgId}`, {
      ...asUser(carolCookie, { ...json({ confirmName: "nope" }), method: "DELETE" }),
    });
    expect(wrongName.status).toBe(400);

    const deleted = await engine.json(`/api/v1/auth-org/organizations/${carolOrgId}`, {
      ...asUser(carolCookie, { ...json({ confirmName: orgName }), method: "DELETE" }),
    });
    expect(deleted.status).toBe(200);
    expect(bodyOf(deleted).projectsDeleted).toBe(1);

    // The key is dead, the projects are gone, and the admin overview no longer lists the org.
    const keyUse = await engine.json("/api/v1/ingest/traces?limit=1", { apiKey: carolKey });
    expect(keyUse.status).toBe(401);
    const projects = await engine.json("/api/v1/projects", asUser(carolCookie));
    expect(bodyOf(projects).projects).toHaveLength(0);
    const overview = await engine.json("/api/v1/admin/overview", {
      apiKey: null,
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(bodyOf(overview).organizations.some((o: { _id: string }) => o._id === carolOrgId)).toBe(false);
  });
});
