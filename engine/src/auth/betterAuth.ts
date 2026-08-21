import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { eq, isNull } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { withProjectId, type Db } from "../storage/db.js";
import { createProject, getDefaultProject, getProjectRow } from "../core/project/projects.js";
import { ensureSessionBaselineJudge } from "../core/monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs } from "../core/evaluate/metricPack.js";

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

// What a *second* signup means on the same instance - the one decision that separates "a team
// server" from "a place several unrelated people happen to share", and the reason the original
// enabled-mode implementation leaked: it only ever had the team answer.
//
//   isolated (default): every signup gets its own organization and its own starter project.
//     Nobody sees, or can obtain a key for, anybody else's projects - which is what both cloud
//     and a self-host instance that strangers can sign up on need.
//   shared: every signup joins the first user's organization as a member, sharing its projects.
//     The small-team server posture (the previous, and now opt-in, behaviour).
//
// Deliberately independent of AGENTX_AUTH so the two questions stay separate: AGENTX_AUTH decides
// whether there are users at all, AGENTX_TENANCY decides what a user owns. Meaningless (and
// ignored) in disabled mode, which has no users to isolate.
export type TenancyMode = "isolated" | "shared";

export function tenancyMode(): TenancyMode {
  return process.env.AGENTX_TENANCY?.trim().toLowerCase() === "shared" ? "shared" : "isolated";
}

// Typed off the concrete builder below (the generic Auth<BetterAuthOptions> and the inferred
// instance type aren't mutually assignable in better-auth's typings).
let authInstance: BetterAuthInstance | null = null;
let authDb: Db | null = null;

type NewUser = { id: string; name?: string | null; email?: string | null };

async function anyMemberRow(db: Db): Promise<{ organizationId: string } | undefined> {
  const row =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).limit(1).all()[0]
      : (await db.db.select().from(db.schema.authMembers).limit(1))[0];
  return row as { organizationId: string } | undefined;
}

async function insertOrganization(db: Db, org: { id: string; name: string; slug: string }, now: Date): Promise<void> {
  const orgRow = { id: org.id, name: org.name, slug: org.slug, logo: null, createdAt: now, metadata: null };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.authOrganizations).values(orgRow);
  } else {
    await db.db.insert(db.schema.authOrganizations).values(orgRow);
  }
}

async function insertMember(db: Db, organizationId: string, userId: string, role: string, now: Date): Promise<void> {
  const memberRow = { id: nanoid(), organizationId, userId, role, createdAt: now };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.authMembers).values(memberRow);
  } else {
    await db.db.insert(db.schema.authMembers).values(memberRow);
  }
}

// Everything on the instance that no organization owns yet, handed to the first signup - see
// onUserCreated's comment for why that is the first user rather than nobody.
async function claimOrphanProjects(db: Db, organizationId: string): Promise<void> {
  if (db.kind === "sqlite") {
    await db.db
      .update(db.schema.projects)
      .set({ organizationId })
      .where(isNull(db.schema.projects.organizationId));
  } else {
    await db.db
      .update(db.schema.projects)
      .set({ organizationId })
      .where(isNull(db.schema.projects.organizationId));
  }
}

// A brand-new organization owns nothing, and a project is the only thing that carries an API key -
// so without this an isolated-tenancy signup lands on an empty dashboard with no credential and no
// obvious next step. Seeded exactly like POST /projects does (system evaluators + metric packs),
// because a project that skipped those behaves subtly differently from every other one.
async function createStarterProject(db: Db, organizationId: string): Promise<void> {
  const project = await createProject(db, "Default", organizationId);
  await ensureSessionBaselineJudge(withProjectId(db, project._id));
  await ensureMetricPackConfigs(withProjectId(db, project._id));
}

function organizationNameFor(user: NewUser): string {
  const label = user.name?.trim() || user.email?.trim().split("@")[0] || "";
  return label ? `${label}'s Organization` : "Organization";
}

// Who owns what, at the one moment it is decided. Two rules, in this order:
//
// 1. The FIRST signup always becomes an owner and CLAIMS every orgless project - including the
//    default project an existing install migrated in with. That is what makes enabling auth on a
//    populated instance hand its data to the person who runs the setup screen rather than
//    stranding it (or handing it to whoever signs up second). True in both tenancy modes.
// 2. Every LATER signup depends on tenancyMode():
//    - isolated (default): its own organization, as owner, with its own starter project. It can
//      never see or obtain a key for anything the first user owns.
//    - shared: joins the first user's organization as a member, and sees its projects. The old
//      behaviour, now something an operator opts into rather than the only option.
//
// Note that rule 1 is deliberately not "the first user owns the instance forever": it only decides
// the pre-existing rows. In isolated mode the first user's org keeps exactly one extra power over
// later ones - it owns the default project, which is what marks it as the instance operator for
// instance-wide settings (see instanceOwnerOrganizationId below).
async function onUserCreated(db: Db, user: NewUser): Promise<void> {
  const now = new Date();
  const existingMember = await anyMemberRow(db);

  if (!existingMember) {
    const orgId = nanoid();
    await insertOrganization(db, { id: orgId, name: "Default Organization", slug: "default" }, now);
    await insertMember(db, orgId, user.id, "owner", now);
    await claimOrphanProjects(db, orgId);
    return;
  }

  if (tenancyMode() === "shared") {
    await insertMember(db, existingMember.organizationId, user.id, "member", now);
    return;
  }

  const orgId = nanoid();
  // Slug is UNIQUE across the table, so it cannot be derived from a name two people can both pick.
  await insertOrganization(db, { id: orgId, name: organizationNameFor(user), slug: `org-${orgId}` }, now);
  await insertMember(db, orgId, user.id, "owner", now);
  await createStarterProject(db, orgId);
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
            await onUserCreated(db, user);
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

// Which organization a signed-in user's NEW projects belong to. Deterministic on purpose: the
// better-auth organization plugin lets a user create further organizations of their own, so
// "whichever membership row the database happened to return first" would quietly scatter their
// projects across them. The signup organization wins - the oldest membership, which is the one
// onUserCreated made - with ownership as the tiebreak.
export async function getPrimaryOrganizationId(userId: string): Promise<string | null> {
  const db = authDb;
  if (!db) return null;
  const cond = eq(db.schema.authMembers.userId, userId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).where(cond).all()
      : await db.db.select().from(db.schema.authMembers).where(cond);
  const memberships = (rows as { organizationId: string; role: string; createdAt: Date }[]).slice().sort((a, b) => {
    const byAge = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byAge !== 0) return byAge;
    return Number(b.role === "owner") - Number(a.role === "owner");
  });
  return memberships[0]?.organizationId ?? null;
}

// The organization that owns the instance's default project - i.e. whoever ran the setup screen
// first. Deliberately derived rather than stored on a new column: the default project is already
// the one row the first signup is guaranteed to claim (claimOrphanProjects above), so there is no
// second source of truth to keep in sync and an install that predates this code needs no migration
// to acquire one.
export async function instanceOwnerOrganizationId(db: Db): Promise<string | null> {
  const project = await getDefaultProject(db);
  return project?.organizationId ?? null;
}

// Instance-wide settings (app_settings' provider keys) are a single row every tenant on the box
// shares, and the route that writes them authenticates with a PROJECT key rather than a session -
// so with isolated tenancy any signup could otherwise swap the credential every other tenant's
// judges spend money on. Writes are therefore limited to the instance operator's own projects;
// everyone else keeps the masked read. Always allowed when auth is off (single tenant by
// definition), in shared tenancy (one org owns every project anyway), and before the first signup
// has claimed anything - there is nothing to protect yet.
export async function canWriteInstanceSettings(db: Db, projectId: string): Promise<boolean> {
  if (authMode() !== "enabled") return true;
  const ownerOrganizationId = await instanceOwnerOrganizationId(db);
  if (!ownerOrganizationId) return true;
  const project = await getProjectRow(db, projectId);
  return project?.organizationId === ownerOrganizationId;
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
