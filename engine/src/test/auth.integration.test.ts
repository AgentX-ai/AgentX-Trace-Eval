import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { postgresAvailable, startEngine, type TestEngine } from "./server.js";

// AGENTX_AUTH=enabled is a whole second posture for the engine - users, organizations, cookie
// sessions - and it changes who can obtain a project API key, which is the data-plane credential
// for everything else. Nothing exercised it. The interesting question is not "does login work"
// but "does enabling it actually close the door the disabled mode leaves open", and "does the SDK
// path keep working regardless", since ingest must never do a login flow.

let engine: TestEngine;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

/** better-auth hands back its session in a Set-Cookie; this replays it like a browser would. */
function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(";")[0]).join("; ");
}

async function signUp(email: string, password: string, name: string) {
  const res = await engine.request("/api/v1/auth/sign-up/email", { ...json({ email, password, name }), apiKey: null });
  const body = await res.text();
  return { status: res.status, cookie: cookieHeader(res), body };
}

async function signIn(email: string, password: string) {
  const res = await engine.request("/api/v1/auth/sign-in/email", { ...json({ email, password }), apiKey: null });
  const body = await res.text();
  return { status: res.status, cookie: cookieHeader(res), body };
}

const asUser = (cookie: string, init: RequestInit = {}): RequestInit & { apiKey: null } => ({
  ...init,
  apiKey: null,
  headers: { ...(init.headers as Record<string, string> | undefined), cookie },
});

let ownerCookie = "";
let memberCookie = "";

beforeAll(async () => {
  engine = await startEngine({ AGENTX_AUTH: "enabled" });
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("AGENTX_AUTH=enabled", () => {
  it("reports the mode and that setup is still pending", async () => {
    const config = await engine.json("/api/v1/auth/config", { apiKey: null });
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ mode: "enabled", needsSetup: true });
  });

  it("closes the anonymous API-key handout", async () => {
    const bootstrap = await engine.json("/api/v1/dev/bootstrap", { apiKey: null });
    expect(bootstrap.status).toBe(403);
    expect(JSON.stringify(bootstrap.body)).not.toMatch(/agtx_local_/);
  });

  it("refuses to list or create projects without a session", async () => {
    expect((await engine.json("/api/v1/projects", { apiKey: null })).status).toBe(401);
    expect((await engine.json("/api/v1/projects", { ...json({ name: "sneaky" }), apiKey: null })).status).toBe(401);
  });

  it("does not leak an API key to an unauthenticated caller anywhere", async () => {
    for (const path of ["/api/v1/projects", "/api/v1/auth/config", "/api/v1/dev/bootstrap", "/health"]) {
      const res = await engine.json(path, { apiKey: null });
      expect(JSON.stringify(res.body), `${path} leaked a key`).not.toMatch(/agtx_local_/);
    }
  });

  it("makes the first signup the owner and hands it the pre-existing project", async () => {
    const result = await signUp("owner@example.com", "correct-horse-battery", "Owner");
    expect(result.status, result.body).toBeLessThan(300);
    expect(result.cookie, "no session cookie returned").toBeTruthy();
    ownerCookie = result.cookie;

    const config = await engine.json("/api/v1/auth/config", { apiKey: null });
    expect(config.body).toEqual({ mode: "enabled", needsSetup: false });

    // The project that existed before auth was turned on is claimed by the new org, rather than
    // being stranded with no owner and therefore invisible to everyone.
    const projects = await engine.json("/api/v1/projects", asUser(ownerCookie));
    expect(projects.status).toBe(200);
    const list = (projects.body as { projects: { name: string; apiKey: string }[] }).projects;
    expect(list.length).toBeGreaterThan(0);
    expect(list.some(p => p.name === "Default")).toBe(true);
    expect(list[0]!.apiKey).toMatch(/^agtx_local_/);
  });

  it("lets a signed-in user create a project and use its key immediately", async () => {
    const created = await engine.json("/api/v1/projects", asUser(ownerCookie, json({ name: "Team project" })));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = (created.body as { project: { apiKey: string } }).project.apiKey;

    // The data plane never does a login flow - the project key alone is the SDK's credential, in
    // both auth modes.
    const ingested = await engine.json("/api/v1/ingest/traces", {
      ...json({ name: "auth-mode-agent", input: "q", output: "a" }),
      apiKey: key,
    });
    expect(ingested.status).toBe(200);
    const listed = await engine.json("/api/v1/ingest/traces", { apiKey: key });
    expect(JSON.stringify(listed.body)).toContain("auth-mode-agent");
  });

  it("still rejects an invalid API key on the data plane", async () => {
    const res = await engine.request("/api/v1/ingest/traces", { apiKey: "agtx_local_nope" });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("does not accept a session cookie in place of an API key on the data plane", async () => {
    const res = await engine.request("/api/v1/ingest/traces", asUser(ownerCookie));
    expect(res.status).toBe(401);
    await res.text();
  });

  it("joins a later signup to the same organization as a member", async () => {
    const result = await signUp("member@example.com", "correct-horse-battery", "Member");
    expect(result.status, result.body).toBeLessThan(300);
    memberCookie = result.cookie;

    const ownerProjects = await engine.json("/api/v1/projects", asUser(ownerCookie));
    const memberProjects = await engine.json("/api/v1/projects", asUser(memberCookie));
    expect(memberProjects.status).toBe(200);
    const names = (body: unknown) => ((body as { projects: { name: string }[] }).projects ?? []).map(p => p.name).sort();
    expect(names(memberProjects.body)).toEqual(names(ownerProjects.body));
  });

  it("rejects a signed-out or forged cookie", async () => {
    expect((await engine.json("/api/v1/projects", asUser("better-auth.session_token=forged"))).status).toBe(401);
    expect((await engine.json("/api/v1/projects", asUser(""))).status).toBe(401);
  });

  it("signs in an existing user and issues a working session", async () => {
    const failed = await signIn("owner@example.com", "wrong-password");
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const ok = await signIn("owner@example.com", "correct-horse-battery");
    expect(ok.status, ok.body).toBeLessThan(300);
    expect((await engine.json("/api/v1/projects", asUser(ok.cookie))).status).toBe(200);
  });

  it("survives malformed auth requests without dying", async () => {
    for (const body of [{}, { email: "not-an-email", password: "x" }, { email: "a@b.c" }, null]) {
      const res = await engine.request("/api/v1/auth/sign-up/email", { ...json(body), apiKey: null });
      expect(res.status).toBeLessThan(500);
      await res.text();
    }
    expect(engine.alive(), engine.log().slice(-3000)).toBe(true);
  });

  it("backfills an issuer onto accounts written before better-auth required one", async () => {
    // Simulates the pre-1.7 install: the rows are there, the column is not populated. Without the
    // backfill, 1.7's issuer-scoped account lookup does not find them and an existing user's
    // password simply stops working - a silent lockout on upgrade, not an error anyone would see
    // until they tried to log in.
    const home = engine.home;
    await engine.stop({ keepHome: true });

    const db = new Database(path.join(home, "agentx.db"));
    db.exec("UPDATE auth_account SET issuer = NULL");
    expect((db.prepare("SELECT count(*) AS n FROM auth_account WHERE issuer IS NULL").get() as { n: number }).n).toBeGreaterThan(0);
    db.close();

    engine = await startEngine({ AGENTX_AUTH: "enabled" }, { home });

    const check = new Database(path.join(home, "agentx.db"), { readonly: true });
    const rows = check.prepare("SELECT issuer, provider_id FROM auth_account").all() as { issuer: string; provider_id: string }[];
    check.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.issuer).toBe(`local:${row.provider_id}`);
    }

    const ok = await signIn("owner@example.com", "correct-horse-battery");
    expect(ok.status, `existing user could not sign in after the upgrade: ${ok.body}`).toBeLessThan(300);
  }, 120_000);

  it("keeps the session secret across a restart so logins are not silently invalidated", async () => {
    const home = engine.home;
    await engine.stop({ keepHome: true });
    engine = await startEngine({ AGENTX_AUTH: "enabled" }, { home });
    const projects = await engine.json("/api/v1/projects", asUser(ownerCookie));
    expect(projects.status, "the owner's session did not survive a restart").toBe(200);
  }, 120_000);
});

// The auth tables live in both schema files and better-auth is handed a different adapter provider
// per dialect, so "sign-up works" is a per-backend claim, not a global one.
describe.skipIf(!postgresAvailable)("AGENTX_AUTH=enabled on Postgres", () => {
  let pgEngine: TestEngine;

  beforeAll(async () => {
    pgEngine = await startEngine({ AGENTX_AUTH: "enabled" }, { postgres: true });
  }, 120_000);

  afterAll(async () => {
    await pgEngine?.stop();
  });

  it("signs a first user up and hands them the pre-existing project", async () => {
    const res = await pgEngine.request("/api/v1/auth/sign-up/email", {
      ...json({ email: "pg-owner@example.com", password: "correct-horse-battery", name: "PG Owner" }),
      apiKey: null,
    });
    const body = await res.text();
    expect(res.status, body).toBeLessThan(300);
    const cookie = cookieHeader(res);

    const projects = await pgEngine.json("/api/v1/projects", { apiKey: null, headers: { cookie } });
    expect(projects.status).toBe(200);
    expect((projects.body as { projects: unknown[] }).projects.length).toBeGreaterThan(0);
  }, 60_000);

  it("still refuses anonymous access to keys", async () => {
    expect((await pgEngine.json("/api/v1/dev/bootstrap", { apiKey: null })).status).toBe(403);
    expect((await pgEngine.json("/api/v1/projects", { apiKey: null })).status).toBe(401);
  });
});
