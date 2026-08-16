import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { eq, isNull } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import type { Db } from "../storage/db.js";

// Dashboard identity for AGENTX_AUTH=enabled mode (cloud, or a team self-host): better-auth with
// email/password, cookie sessions, and the organization plugin, persisted through this engine's
// own drizzle handles (both dialects). The tenancy model is Organization -> Project -> API key:
// users belong to orgs, orgs own projects, and the project API key stays the DATA-PLANE
// credential exactly as before - SDK ingest never does login flows, sessions only guard the
// control plane (project listing/creation, which is where API keys are handed out).
//
// Self-host default (AGENTX_AUTH unset/disabled) never touches any of this: initAuth simply
// isn't called, and every route keeps today's "reachable port = trusted" posture.

export type AuthMode = "enabled" | "disabled";

export function authMode(): AuthMode {
  return process.env.AGENTX_AUTH === "enabled" ? "enabled" : "disabled";
}

// Typed off the concrete builder below (the generic Auth<BetterAuthOptions> and the inferred
// instance type aren't mutually assignable in better-auth's typings).
let authInstance: BetterAuthInstance | null = null;
let authDb: Db | null = null;

// First-user-becomes-owner (the Grafana/n8n/Portainer pattern): the first signup creates the
// default organization, becomes its owner, and CLAIMS every orgless project - including the
// default project an existing install migrated in with, so enabling auth on a populated instance
// hands its data to the person who runs the setup screen, not to whoever signs up second. Later
// signups join that same org as plain members (the single-org self-host model; cloud can layer
// org-per-signup on top later).
async function onUserCreated(db: Db, userId: string): Promise<void> {
  const now = new Date();
  const anyMember =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).limit(1).all()[0]
      : (await db.db.select().from(db.schema.authMembers).limit(1))[0];

  if (!anyMember) {
    const orgId = nanoid();
    const orgRow = { id: orgId, name: "Default Organization", slug: "default", logo: null, createdAt: now, metadata: null };
    const memberRow = { id: nanoid(), organizationId: orgId, userId, role: "owner", createdAt: now };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.authOrganizations).values(orgRow);
      await db.db.insert(db.schema.authMembers).values(memberRow);
      await db.db
        .update(db.schema.projects)
        .set({ organizationId: orgId })
        .where(isNull(db.schema.projects.organizationId));
    } else {
      await db.db.insert(db.schema.authOrganizations).values(orgRow);
      await db.db.insert(db.schema.authMembers).values(memberRow);
      await db.db
        .update(db.schema.projects)
        .set({ organizationId: orgId })
        .where(isNull(db.schema.projects.organizationId));
    }
    return;
  }

  const memberRow = { id: nanoid(), organizationId: anyMember.organizationId as string, userId, role: "member", createdAt: now };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.authMembers).values(memberRow);
  } else {
    await db.db.insert(db.schema.authMembers).values(memberRow);
  }
}

type InitAuthOpts = { secret: string; baseURL?: string; trustedOrigins?: string[] };

function buildAuth(db: Db, opts: InitAuthOpts) {
  const schema = {
    auth_user: db.schema.authUsers,
    auth_session: db.schema.authSessions,
    auth_account: db.schema.authAccounts,
    auth_verification: db.schema.authVerifications,
    auth_organization: db.schema.authOrganizations,
    auth_member: db.schema.authMembers,
    auth_invitation: db.schema.authInvitations,
  };
  return betterAuth({
    // drizzle's two dialect instances have different generics; the adapter only needs the runtime
    // query surface, which both share.
    database: drizzleAdapter(db.db as Parameters<typeof drizzleAdapter>[0], {
      provider: db.kind === "sqlite" ? "sqlite" : "pg",
      schema,
    }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: "/api/v1/auth",
    trustedOrigins: opts.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      // Self-host has no mail transport; cloud layers verification on via its own deployment
      // config rather than this open-source default blocking every install on SMTP setup.
      requireEmailVerification: false,
    },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    databaseHooks: {
      user: {
        create: {
          after: async user => {
            await onUserCreated(db, user.id);
          },
        },
      },
    },
    plugins: [
      organization({
        schema: {
          organization: { modelName: "auth_organization" },
          member: { modelName: "auth_member" },
          invitation: { modelName: "auth_invitation" },
        },
      }),
    ],
  });
}

type BetterAuthInstance = ReturnType<typeof buildAuth>;

export function initAuth(db: Db, opts: InitAuthOpts): void {
  authDb = db;
  authInstance = buildAuth(db, opts);
}

export function getAuth(): BetterAuthInstance {
  if (!authInstance) {
    throw new Error("Auth not initialized - initAuth() must run at startup when AGENTX_AUTH=enabled");
  }
  return authInstance;
}

export type SessionUser = { id: string; email: string; name: string };

// Resolves the request's cookie session to a user, or null. Only meaningful in enabled mode -
// disabled mode never calls it.
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  if (!authInstance) return null;
  const session = await authInstance.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

// The org ids a user belongs to - what scopes the project list in enabled mode.
export async function getUserOrganizationIds(userId: string): Promise<string[]> {
  const db = authDb;
  if (!db) return [];
  const cond = eq(db.schema.authMembers.userId, userId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).where(cond).all()
      : await db.db.select().from(db.schema.authMembers).where(cond);
  return (rows as { organizationId: string }[]).map(r => r.organizationId);
}

// True while no user exists yet - drives the frontend's owner-setup screen vs login screen.
export async function needsSetup(db: Db): Promise<boolean> {
  const row =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authUsers).limit(1).all()[0]
      : (await db.db.select().from(db.schema.authUsers).limit(1))[0];
  return !row;
}

// Session-signing secret: explicit env wins; otherwise generated once and persisted in
// app_settings (instance-wide) so sessions survive restarts without any required setup step.
export async function resolveAuthSecret(db: Db): Promise<string> {
  const fromEnv = process.env.AGENTX_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const existing =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.appSettings).limit(1).all()[0]
      : (await db.db.select().from(db.schema.appSettings).limit(1))[0];
  if (existing?.authSecret) return existing.authSecret as string;
  const secret = randomBytes(32).toString("hex");
  if (existing) {
    const cond = eq(db.schema.appSettings.id, existing.id as string);
    if (db.kind === "sqlite") await db.db.update(db.schema.appSettings).set({ authSecret: secret }).where(cond);
    else await db.db.update(db.schema.appSettings).set({ authSecret: secret }).where(cond);
  } else {
    const row = { id: nanoid(), openaiApiKey: null, anthropicApiKey: null, geminiApiKey: null, authSecret: secret, updatedAt: new Date() };
    if (db.kind === "sqlite") await db.db.insert(db.schema.appSettings).values(row);
    else await db.db.insert(db.schema.appSettings).values(row);
  }
  return secret;
}
