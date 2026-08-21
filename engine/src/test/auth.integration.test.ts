import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { postgresAvailable, startEngine, type TestEngine } from "./server.js";

// A whole second posture for the engine, and it changes who can obtain a project API key. The
// question is not "does login work" but "does enabling it close the door the default mode leaves
// open", and "does the SDK path keep working" - ingest must never do a login flow.

let engine: TestEngine;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const put = (body: unknown): RequestInit => ({ ...json(body), method: "PUT" });

/** better-auth hands back its session in a Set-Cookie; this replays it like a browser would. */
function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(";")[0]).join("; ");
}

async function signUp(target: TestEngine, email: string, password: string, name: string) {
  const res = await target.request("/api/v1/auth/sign-up/email", { ...json({ email, password, name }), apiKey: null });
  const body = await res.text();
  return { status: res.status, cookie: cookieHeader(res), body };
}

async function signIn(target: TestEngine, email: string, password: string) {
  const res = await target.request("/api/v1/auth/sign-in/email", { ...json({ email, password }), apiKey: null });
  const body = await res.text();
  return { status: res.status, cookie: cookieHeader(res), body };
}

const asUser = (cookie: string, init: RequestInit = {}): RequestInit & { apiKey: null } => ({
  ...init,
  apiKey: null,
  headers: { ...(init.headers as Record<string, string> | undefined), cookie },
});

type WireProject = { _id: string; name: string; apiKey: string };

async function projectsOf(target: TestEngine, cookie: string): Promise<WireProject[]> {
  const res = await target.json("/api/v1/projects", asUser(cookie));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { projects: WireProject[] }).projects;
}

let ownerCookie = "";
let memberCookie = "";
// The owner's own project key, reused by the cross-tenant checks below.
let ownerProjectKey = "";

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
    expect(config.body).toEqual({ mode: "enabled", needsSetup: true, tenancy: "isolated" });
  });

  it("has no anonymous API-key handout at all", async () => {
    // /dev/bootstrap used to return the default project's key to any caller. It is gone rather
    // than merely guarded, so this pins its absence - a reintroduction would be a silent regression
    // in exactly the mode that exists to stop it.
    const bootstrap = await engine.json("/api/v1/dev/bootstrap", { apiKey: null });
    expect(bootstrap.status).toBe(404);
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

  it("prints no project API key in the boot banner", async () => {
    // Disabled mode prints the default project's key for the operator to copy. Here the log is not
    // a private channel - `docker logs`, a pod log, or a log shipper would hand a working
    // data-plane credential for the instance owner's project to anyone who can read it.
    expect(engine.log()).not.toMatch(/agtx_local_/);
  });

  it("makes the first signup the owner and hands it the pre-existing project", async () => {
    const result = await signUp(engine, "owner@example.com", "correct-horse-battery", "Owner");
    expect(result.status, result.body).toBeLessThan(300);
    expect(result.cookie, "no session cookie returned").toBeTruthy();
    ownerCookie = result.cookie;

    const config = await engine.json("/api/v1/auth/config", { apiKey: null });
    expect(config.body).toEqual({ mode: "enabled", needsSetup: false, tenancy: "isolated" });

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
    ownerProjectKey = key;

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

  // The bug this suite previously PINNED as correct behaviour: every signup joined the first
  // user's organization, so a second person on the same instance saw the first person's projects
  // and, because the project list carries each project's key, could take over their data plane
  // outright. Isolation is now the default, and these are the assertions that stop it regressing.
  it("gives a later signup its own organization and none of the owner's projects", async () => {
    const result = await signUp(engine, "member@example.com", "correct-horse-battery", "Member");
    expect(result.status, result.body).toBeLessThan(300);
    memberCookie = result.cookie;

    const ownerProjects = await projectsOf(engine, ownerCookie);
    const memberProjects = await projectsOf(engine, memberCookie);

    // An org that owns nothing has no API key and nothing to do, so a fresh tenant is given a
    // starter project of its own rather than an empty dashboard.
    expect(memberProjects.length, "a new tenant got no starter project").toBeGreaterThan(0);

    const ownerIds = new Set(ownerProjects.map(p => p._id));
    const ownerKeys = new Set(ownerProjects.map(p => p.apiKey));
    expect(memberProjects.filter(p => ownerIds.has(p._id))).toEqual([]);
    expect(memberProjects.filter(p => ownerKeys.has(p.apiKey))).toEqual([]);

    // ...and the reverse direction: the pre-existing project stays with the first signup only.
    const memberIds = new Set(memberProjects.map(p => p._id));
    expect(ownerProjects.filter(p => memberIds.has(p._id))).toEqual([]);
    expect(ownerProjects.some(p => p.name === "Default")).toBe(true);
  });

  it("does not show one tenant another tenant's traces", async () => {
    const memberKey = (await projectsOf(engine, memberCookie))[0]!.apiKey;
    const listed = await engine.json("/api/v1/ingest/traces", { apiKey: memberKey });
    expect(listed.status).toBe(200);
    // "auth-mode-agent" was ingested above with the owner's key.
    expect(JSON.stringify(listed.body)).not.toContain("auth-mode-agent");
  });

  it("lets only the instance owner rewrite the instance-wide provider keys", async () => {
    const memberKey = (await projectsOf(engine, memberCookie))[0]!.apiKey;
    const settingsPath = "/api/v1/agent-monitoring/settings/llm-keys";

    // One shared app_settings row funds every tenant's judge calls, and this route authenticates
    // with a project key rather than a session - so a second tenant holding a valid key of its own
    // must still not be able to swap the credential out from under the first.
    const denied = await engine.json(settingsPath, { ...put({ openaiApiKey: "sk-tenant-b" }), apiKey: memberKey });
    expect(denied.status).toBe(403);

    const allowed = await engine.json(settingsPath, { ...put({ openaiApiKey: "sk-instance-owner" }), apiKey: ownerProjectKey });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    // Leave the instance as we found it - a configured key changes what later boots try to call.
    const cleared = await engine.json(settingsPath, { ...put({ openaiApiKey: "" }), apiKey: ownerProjectKey });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { llm: { openai: { configured: boolean } } }).llm.openai.configured).toBe(false);
  });

  it("refuses a non-owner tenant's write to the shared model catalog", async () => {
    const memberKey = (await projectsOf(engine, memberCookie))[0]!.apiKey;
    const catalog = "/api/v1/agent-monitoring/portability/models";

    const models = await engine.json(catalog, { apiKey: memberKey });
    expect(models.status).toBe(200);
    const target = (models.body as { models: { id: string; label: string }[] }).models[0]!;
    expect(target, "no seeded portability models to test against").toBeTruthy();
    const row = `${catalog}/${encodeURIComponent(target.id)}`;

    // The catalog is instance-wide, and Model Portability replays a trace's input against whatever
    // baseUrl a row names - so a second tenant rewriting one would exfiltrate the first tenant's
    // captured prompts to an endpoint of its own choosing.
    const hijack = await engine.json(row, {
      ...put({
        provider: "custom",
        label: target.label,
        pricePerMInputTokens: 0,
        pricePerMOutputTokens: 0,
        baseUrl: "http://attacker.invalid/v1",
      }),
      apiKey: memberKey,
    });
    expect(hijack.status).toBe(403);
    expect((await engine.json(row, { method: "DELETE", apiKey: memberKey })).status).toBe(403);

    // Nothing about the row moved.
    const after = await engine.json(catalog, { apiKey: ownerProjectKey });
    const survivor = (after.body as { models: { id: string; baseUrl: string | null }[] }).models.find(m => m.id === target.id);
    expect(survivor).toBeTruthy();
    expect(survivor!.baseUrl).toBeNull();
  });

  it("rejects a signed-out or forged cookie", async () => {
    expect((await engine.json("/api/v1/projects", asUser("better-auth.session_token=forged"))).status).toBe(401);
    expect((await engine.json("/api/v1/projects", asUser(""))).status).toBe(401);
  });

  it("signs in an existing user and issues a working session", async () => {
    const failed = await signIn(engine, "owner@example.com", "wrong-password");
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const ok = await signIn(engine, "owner@example.com", "correct-horse-battery");
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

    const ok = await signIn(engine, "owner@example.com", "correct-horse-battery");
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

// The team-server posture, now something an operator asks for by name. Worth its own engine
// because the two modes differ only in what the SECOND signup means, and that is exactly the kind
// of branch that rots once the default stops exercising it.
describe("AGENTX_AUTH=enabled with AGENTX_TENANCY=shared", () => {
  let shared: TestEngine;

  beforeAll(async () => {
    shared = await startEngine({ AGENTX_AUTH: "enabled", AGENTX_TENANCY: "shared" });
  }, 90_000);

  afterAll(async () => {
    await shared?.stop();
  });

  it("advertises the mode so the sign-up screen can describe what an account gets", async () => {
    const config = await shared.json("/api/v1/auth/config", { apiKey: null });
    expect(config.body).toEqual({ mode: "enabled", needsSetup: true, tenancy: "shared" });
  });

  it("joins a later signup to the first user's organization and its projects", async () => {
    const first = await signUp(shared, "team-owner@example.com", "correct-horse-battery", "Team Owner");
    expect(first.status, first.body).toBeLessThan(300);
    const second = await signUp(shared, "team-mate@example.com", "correct-horse-battery", "Team Mate");
    expect(second.status, second.body).toBeLessThan(300);

    const ownerProjects = await projectsOf(shared, first.cookie);
    const mateProjects = await projectsOf(shared, second.cookie);
    const ids = (list: WireProject[]) => list.map(p => p._id).sort();
    expect(ids(mateProjects)).toEqual(ids(ownerProjects));
    expect(ownerProjects.some(p => p.name === "Default")).toBe(true);
  }, 60_000);
});

// The auth tables live in both schema files and better-auth is handed a different adapter provider
// per dialect, so "sign-up works" is a per-backend claim, not a global one.
describe.skipIf(!postgresAvailable)("AGENTX_AUTH=enabled on Postgres", () => {
  let pgEngine: TestEngine;
  let pgOwnerCookie = "";

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

    pgOwnerCookie = cookie;

    const projects = await pgEngine.json("/api/v1/projects", { apiKey: null, headers: { cookie } });
    expect(projects.status).toBe(200);
    expect((projects.body as { projects: unknown[] }).projects.length).toBeGreaterThan(0);
  }, 60_000);

  // The isolated path writes more per signup than the shared one does - a new organization, a
  // member row, a project and its seeded evaluators - so "it works" is a per-dialect claim here
  // for the same reason sign-up itself is.
  it("gives a later signup its own organization and projects", async () => {
    const res = await pgEngine.request("/api/v1/auth/sign-up/email", {
      ...json({ email: "pg-second@example.com", password: "correct-horse-battery", name: "PG Second" }),
      apiKey: null,
    });
    const body = await res.text();
    expect(res.status, body).toBeLessThan(300);

    const owner = await projectsOf(pgEngine, pgOwnerCookie);
    const second = await projectsOf(pgEngine, cookieHeader(res));
    expect(second.length).toBeGreaterThan(0);
    const ownerIds = new Set(owner.map(p => p._id));
    expect(second.filter(p => ownerIds.has(p._id))).toEqual([]);
  }, 60_000);

  it("still refuses anonymous access to keys", async () => {
    expect((await pgEngine.json("/api/v1/dev/bootstrap", { apiKey: null })).status).toBe(404);
    expect((await pgEngine.json("/api/v1/projects", { apiKey: null })).status).toBe(401);
  });
});
