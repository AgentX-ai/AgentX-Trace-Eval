import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { eq, isNull } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, organization } from "better-auth/plugins";
import { mailerConfigured, sendMailInBackground } from "./mailer.js";

// Verification is an explicit opt-in on top of a working mailer.
export function verificationRequired(): boolean {
  return mailerConfigured() && process.env.AGENTX_REQUIRE_EMAIL_VERIFICATION === "true";
}

// Google/GitHub sign-in appear automatically when their credentials are configured - the
// standard SaaS front door, entirely env-driven so the OSS default stays credential-free.
// "oidc" is the generic enterprise SSO door (P2.3): one env trio covers Okta/Entra/Auth0/
// Google Workspace/anything speaking OIDC discovery, without per-vendor engine work. SAML and
// SCIM are deliberately NOT implied by this - they remain unimplemented and documented as such.
export function enabledSocialProviders(): string[] {
  const providers: string[] = [];
  if (process.env.AGENTX_GOOGLE_CLIENT_ID && process.env.AGENTX_GOOGLE_CLIENT_SECRET) providers.push("google");
  if (process.env.AGENTX_GITHUB_CLIENT_ID && process.env.AGENTX_GITHUB_CLIENT_SECRET) providers.push("github");
  if (oidcConfigured()) providers.push("oidc");
  return providers;
}

export function oidcConfigured(): boolean {
  return Boolean(
    process.env.AGENTX_OIDC_ISSUER && process.env.AGENTX_OIDC_CLIENT_ID && process.env.AGENTX_OIDC_CLIENT_SECRET
  );
}

// What the SSO button says, e.g. "Okta" - purely cosmetic, defaults to the neutral "SSO".
export function oidcDisplayName(): string {
  return process.env.AGENTX_OIDC_NAME?.trim() || "SSO";
}

function genericOAuthConfigFromEnv() {
  if (!oidcConfigured()) {
    return [];
  }
  const issuer = process.env.AGENTX_OIDC_ISSUER!.replace(/\/$/, "");
  return [
    {
      providerId: "oidc",
      clientId: process.env.AGENTX_OIDC_CLIENT_ID!,
      clientSecret: process.env.AGENTX_OIDC_CLIENT_SECRET!,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      scopes: ["openid", "profile", "email"],
    },
  ];
}

function socialProvidersFromEnv() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.AGENTX_GOOGLE_CLIENT_ID && process.env.AGENTX_GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.AGENTX_GOOGLE_CLIENT_ID,
      clientSecret: process.env.AGENTX_GOOGLE_CLIENT_SECRET,
    };
  }
  if (process.env.AGENTX_GITHUB_CLIENT_ID && process.env.AGENTX_GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.AGENTX_GITHUB_CLIENT_ID,
      clientSecret: process.env.AGENTX_GITHUB_CLIENT_SECRET,
    };
  }
  return providers;
}
import { isMultiTenant } from "./mode.js";
import { withProjectId } from "../storage/db.js";
import { createProject } from "../core/project/projects.js";
import { ensureSessionBaselineJudge } from "../core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs } from "../core/evaluate/metricPack.js";
import { seedExampleDataIfEmpty } from "../core/seed.js";
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

export type { AuthMode } from "./mode.js";

export { authMode } from "./mode.js";

// Typed off the concrete builder below (the generic Auth<BetterAuthOptions> and the inferred
// instance type aren't mutually assignable in better-auth's typings).
let authInstance: BetterAuthInstance | null = null;
let authDb: Db | null = null;

// Two tenancy models, selected by AGENTX_MULTI_TENANT (auth/mode.ts):
//
// Single-org (default for AGENTX_AUTH=enabled - a self-host team): first-user-becomes-owner
// (the Grafana/n8n/Portainer pattern). The first signup creates the default organization,
// becomes its owner, and CLAIMS every orgless project - including the default project an
// existing install migrated in with, so enabling auth on a populated instance hands its data
// to the person who runs the setup screen, not to whoever signs up second. Later signups join
// that same org as plain members.
//
// Multi-tenant (AGENTX_MULTI_TENANT=true - the cloud/SaaS posture): EVERY signup creates its
// own organization plus a seeded default project. Nobody ever lands in someone else's org by
// signing up; teammates arrive only through invitations (routes/authOrg.ts).
async function onUserCreated(db: Db, userId: string, userName?: string | null): Promise<void> {
  const now = new Date();

  if (isMultiTenant()) {
    const orgId = nanoid();
    const display = (userName ?? "").trim();
    const orgRow = {
      id: orgId,
      name: display ? `${display}'s Workspace` : "My Workspace",
      slug: `ws-${nanoid(10).toLowerCase()}`,
      logo: null,
      createdAt: now,
      metadata: null,
    };
    const memberRow = { id: nanoid(), organizationId: orgId, userId, role: "owner", createdAt: now };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.authOrganizations).values(orgRow);
      await db.db.insert(db.schema.authMembers).values(memberRow);
    } else {
      await db.db.insert(db.schema.authOrganizations).values(orgRow);
      await db.db.insert(db.schema.authMembers).values(memberRow);
    }
    // A tenant's first screen should look like a working product, not four empty tabs: same
    // per-project seeding the POST /projects route does, plus the example starter content
    // (whose per-table "only if empty" checks are project-scoped, so each tenant gets one).
    const project = await createProject(db, "Default", orgId);
    const scoped = withProjectId(db, project._id);
    // Examples first (their only-if-empty checks must see empty tables), then the system
    // evaluators - the same order a fresh instance boots in.
    await seedExampleDataIfEmpty(scoped).catch(() => undefined);
    await ensureSessionBaselineJudge(scoped).catch(() => undefined);
    await ensureMetricPackConfigs(scoped).catch(() => undefined);
    return;
  }
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

  // Security: once the org has any member, signing up grants NO membership - anyone who can
  // reach an exposed port can self-register, and auto-joining them would hand over every
  // project (and each project's API key) to a stranger. Teammates get in by accepting an
  // invitation (routes/authOrg.ts), exactly as this function's header always claimed.
  // AGENTX_OPEN_SIGNUP=true restores the old auto-join for closed-network installs that want
  // zero-friction team joining.
  if (process.env.AGENTX_OPEN_SIGNUP !== "true") {
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
      // Verification only turns on when a mailer exists AND the operator opts in - the
      // open-source default never blocks an install on SMTP setup.
      requireEmailVerification: verificationRequired(),
      sendResetPassword: async ({ user, url }) => {
        sendMailInBackground({
          to: user.email,
          subject: "Reset your AgentX password",
          text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nReset it here: ${url}\n\nIf this wasn't you, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        sendMailInBackground({
          to: user.email,
          subject: "Verify your AgentX email",
          text: `Welcome to AgentX. Confirm this address to activate your account:\n\n${url}`,
        });
      },
      sendOnSignUp: verificationRequired(),
    },
    socialProviders: socialProvidersFromEnv(),
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    databaseHooks: {
      user: {
        create: {
          after: async user => {
            await onUserCreated(db, user.id, (user as { name?: string | null }).name);
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
      // Generic OIDC SSO. Since better-auth 1.7 the provider is a first-class social provider:
      // sign-in goes through POST /auth/sign-in/social with provider "oidc", the IdP callback
      // is <public URL>/api/v1/auth/callback/oidc (the old /auth/oauth2/callback/oidc is gone,
      // so IdP apps registered against it must update their redirect URI), and OIDC discovery
      // runs once here at boot instead of per sign-in. Inert without the env trio.
      genericOAuth({ config: genericOAuthConfigFromEnv() }),
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
