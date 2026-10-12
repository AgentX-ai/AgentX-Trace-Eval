import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, notInArray } from "drizzle-orm";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../../storage/db.js";

// Persistence for the MCP OAuth provider (oauthProvider.ts): registered clients, pending
// authorization codes, and issued tokens. Every function takes the UNSCOPED Db - these rows are
// instance-wide (a client registers once, a grant names its project explicitly), the same
// posture as core/project/projects.ts. Per-dialect select branches per CONTRIBUTING.md.

export type TokenKind = "access" | "refresh";

export type TokenRow = {
  tokenHash: string;
  kind: TokenKind;
  grantId: string;
  clientId: string;
  projectId: string;
  organizationId: string | null;
  userId: string | null;
  scopes: string[];
  resource: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export type CodeRow = {
  codeHash: string;
  clientId: string;
  projectId: string;
  organizationId: string | null;
  userId: string | null;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  expiresAt: Date;
  createdAt: Date;
};

type ClientRow = {
  id: string;
  clientSecret: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastUsedAt: Date | null;
};

// Tokens and codes are looked up by the hash of the secret the client holds, never by the
// secret itself: a read of this table yields nothing presentable to /mcp.
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Prefixed so requireMcpAuth can tell an OAuth access token from a project API key without a
// database round trip, and so a token pasted into the wrong place is recognizable in a log.
export function newAccessToken(): string {
  return `agtx_mcp_at_${randomBytes(32).toString("hex")}`;
}

export function newRefreshToken(): string {
  return `agtx_mcp_rt_${randomBytes(32).toString("hex")}`;
}

export function newAuthorizationCode(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function clientToInfo(row: ClientRow): OAuthClientInformationFull {
  return {
    ...(row.metadata as Omit<OAuthClientInformationFull, "client_id" | "client_secret">),
    client_id: row.id,
    ...(row.clientSecret ? { client_secret: row.clientSecret } : {}),
  } as OAuthClientInformationFull;
}

export async function insertClient(db: Db, info: OAuthClientInformationFull): Promise<void> {
  const { client_id, client_secret, ...metadata } = info;
  const row: ClientRow = {
    id: client_id,
    clientSecret: client_secret ?? null,
    metadata: metadata as Record<string, unknown>,
    createdAt: new Date(),
    lastUsedAt: null,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.mcpOauthClients).values(row);
  } else {
    await db.db.insert(db.schema.mcpOauthClients).values(row);
  }
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const cond = eq(db.schema.mcpOauthClients.id, clientId);
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.mcpOauthClients).where(cond).all()[0] as ClientRow | undefined)
      : ((await db.db.select().from(db.schema.mcpOauthClients).where(cond))[0] as ClientRow | undefined);
  return row ? clientToInfo(row) : undefined;
}

export async function touchClient(db: Db, clientId: string): Promise<void> {
  const cond = eq(db.schema.mcpOauthClients.id, clientId);
  const values = { lastUsedAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.mcpOauthClients).set(values).where(cond);
  } else {
    await db.db.update(db.schema.mcpOauthClients).set(values).where(cond);
  }
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function insertCode(db: Db, row: CodeRow): Promise<void> {
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.mcpOauthCodes).values(row);
  } else {
    await db.db.insert(db.schema.mcpOauthCodes).values(row);
  }
}

export async function getCode(db: Db, codeHash: string): Promise<CodeRow | undefined> {
  const cond = eq(db.schema.mcpOauthCodes.codeHash, codeHash);
  const row =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.mcpOauthCodes).where(cond).all()[0]
      : (await db.db.select().from(db.schema.mcpOauthCodes).where(cond))[0];
  return row ? normalizeCode(row as Record<string, unknown>) : undefined;
}

// Single use, atomically: DELETE ... RETURNING hands the row to exactly one caller, so two
// exchanges racing on the same code (a client retrying after a timeout) cannot both mint. The
// row is gone whether or not the exchange then succeeds - a replayed code fails as unknown.
export async function claimCode(db: Db, codeHash: string): Promise<CodeRow | undefined> {
  const cond = eq(db.schema.mcpOauthCodes.codeHash, codeHash);
  const deleted =
    db.kind === "sqlite"
      ? db.db.delete(db.schema.mcpOauthCodes).where(cond).returning().all()
      : await db.db.delete(db.schema.mcpOauthCodes).where(cond).returning();
  return deleted[0] ? normalizeCode(deleted[0] as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function insertTokens(db: Db, rows: TokenRow[]): Promise<void> {
  if (rows.length === 0) return;
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.mcpOauthTokens).values(rows);
  } else {
    await db.db.insert(db.schema.mcpOauthTokens).values(rows);
  }
}

export async function getToken(db: Db, tokenHash: string): Promise<TokenRow | undefined> {
  const cond = eq(db.schema.mcpOauthTokens.tokenHash, tokenHash);
  const row =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.mcpOauthTokens).where(cond).all()[0]
      : (await db.db.select().from(db.schema.mcpOauthTokens).where(cond))[0];
  return row ? normalizeToken(row as Record<string, unknown>) : undefined;
}

export async function touchToken(db: Db, tokenHash: string): Promise<void> {
  const cond = eq(db.schema.mcpOauthTokens.tokenHash, tokenHash);
  const values = { lastUsedAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.mcpOauthTokens).set(values).where(cond);
  } else {
    await db.db.update(db.schema.mcpOauthTokens).set(values).where(cond);
  }
}

// Revoking any token of a grant revokes the whole grant: the refresh chain and every access
// token minted from it. That is what a user means by "disconnect", and it is what OAuth 2.1
// requires when a refresh token is revoked.
export async function revokeGrant(db: Db, grantId: string): Promise<void> {
  const cond = and(eq(db.schema.mcpOauthTokens.grantId, grantId), isNull(db.schema.mcpOauthTokens.revokedAt));
  const values = { revokedAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.mcpOauthTokens).set(values).where(cond);
  } else {
    await db.db.update(db.schema.mcpOauthTokens).set(values).where(cond);
  }
}

// Refresh rotation, run AFTER the replacement pair is written so a failed insert leaves the old
// tokens usable: every other live access token under the grant is revoked, and the presented
// refresh token is marked rotated (not revoked) so a retry inside REFRESH_ROTATION_GRACE_MS can
// be recognized as such by the provider.
export async function retireForRotation(db: Db, grantId: string, presentedHash: string, keepHashes: string[]): Promise<void> {
  const others = and(
    eq(db.schema.mcpOauthTokens.grantId, grantId),
    eq(db.schema.mcpOauthTokens.kind, "access"),
    isNull(db.schema.mcpOauthTokens.revokedAt),
    notInArray(db.schema.mcpOauthTokens.tokenHash, keepHashes)
  );
  const presented = and(eq(db.schema.mcpOauthTokens.tokenHash, presentedHash), isNull(db.schema.mcpOauthTokens.rotatedAt));
  const now = new Date();
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.mcpOauthTokens).set({ revokedAt: now }).where(others);
    await db.db.update(db.schema.mcpOauthTokens).set({ rotatedAt: now }).where(presented);
  } else {
    await db.db.update(db.schema.mcpOauthTokens).set({ revokedAt: now }).where(others);
    await db.db.update(db.schema.mcpOauthTokens).set({ rotatedAt: now }).where(presented);
  }
}

// Every live grant on a project - the "connected apps" list, and the cascade when the project's
// API key is regenerated (an MCP token is a stand-in for that key, so it dies with it).
export async function revokeProjectGrants(db: Db, projectId: string): Promise<number> {
  const grants = await listGrants(db, projectId);
  for (const grant of grants) {
    await revokeGrant(db, grant.grantId);
  }
  return grants.length;
}

export type GrantSummary = {
  grantId: string;
  clientId: string;
  clientName: string | null;
  userId: string | null;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
};

export async function listGrants(db: Db, projectId: string): Promise<GrantSummary[]> {
  const cond = and(
    eq(db.schema.mcpOauthTokens.projectId, projectId),
    eq(db.schema.mcpOauthTokens.kind, "refresh"),
    isNull(db.schema.mcpOauthTokens.revokedAt),
    isNull(db.schema.mcpOauthTokens.rotatedAt)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.mcpOauthTokens).where(cond).all()
      : await db.db.select().from(db.schema.mcpOauthTokens).where(cond)
  ).map(row => normalizeToken(row as Record<string, unknown>));
  const now = Date.now();
  const live = rows.filter(row => row.expiresAt.getTime() > now);
  const byGrant = new Map<string, TokenRow>();
  for (const row of live) {
    const existing = byGrant.get(row.grantId);
    if (!existing || existing.createdAt < row.createdAt) byGrant.set(row.grantId, row);
  }
  const clientNames = new Map<string, string | null>();
  const result: GrantSummary[] = [];
  for (const row of byGrant.values()) {
    if (!clientNames.has(row.clientId)) {
      const client = await getClient(db, row.clientId);
      clientNames.set(row.clientId, client?.client_name ?? null);
    }
    result.push({
      grantId: row.grantId,
      clientId: row.clientId,
      clientName: clientNames.get(row.clientId) ?? null,
      userId: row.userId,
      scopes: row.scopes,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
    });
  }
  result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return result;
}

// Housekeeping run opportunistically from the token endpoint: expired codes go immediately,
// tokens a week past expiry go too (kept a little so a "connected app" that just expired still
// shows why it stopped working). Never fails the request that triggered it.
export async function pruneExpired(db: Db): Promise<void> {
  const now = new Date();
  const tokenCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.mcpOauthCodes).where(lt(db.schema.mcpOauthCodes.expiresAt, now));
    await db.db.delete(db.schema.mcpOauthTokens).where(lt(db.schema.mcpOauthTokens.expiresAt, tokenCutoff));
  } else {
    await db.db.delete(db.schema.mcpOauthCodes).where(lt(db.schema.mcpOauthCodes.expiresAt, now));
    await db.db.delete(db.schema.mcpOauthTokens).where(lt(db.schema.mcpOauthTokens.expiresAt, tokenCutoff));
  }
}

// ---------------------------------------------------------------------------
// Row normalization - both dialects hand back parsed JSON for the json columns, but the shape of
// a json column is `unknown` to drizzle; this is the one place that trusts it.
// ---------------------------------------------------------------------------

function scopesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

function normalizeToken(row: Record<string, unknown>): TokenRow {
  return {
    tokenHash: row.tokenHash as string,
    kind: row.kind as TokenKind,
    grantId: row.grantId as string,
    clientId: row.clientId as string,
    projectId: row.projectId as string,
    organizationId: (row.organizationId as string | null) ?? null,
    userId: (row.userId as string | null) ?? null,
    scopes: scopesOf(row.scopes),
    resource: (row.resource as string | null) ?? null,
    expiresAt: row.expiresAt as Date,
    revokedAt: (row.revokedAt as Date | null) ?? null,
    rotatedAt: (row.rotatedAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
    lastUsedAt: (row.lastUsedAt as Date | null) ?? null,
  };
}

function normalizeCode(row: Record<string, unknown>): CodeRow {
  return {
    codeHash: row.codeHash as string,
    clientId: row.clientId as string,
    projectId: row.projectId as string,
    organizationId: (row.organizationId as string | null) ?? null,
    userId: (row.userId as string | null) ?? null,
    scopes: scopesOf(row.scopes),
    codeChallenge: row.codeChallenge as string,
    redirectUri: row.redirectUri as string,
    resource: (row.resource as string | null) ?? null,
    expiresAt: row.expiresAt as Date,
    createdAt: row.createdAt as Date,
  };
}
