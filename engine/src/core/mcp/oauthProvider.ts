import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { getDb } from "../../storage/db.js";
import { authMode } from "../../auth/mode.js";
import { getSessionUser, getUserOrganizationIds, resolveAuthSecret } from "../../auth/betterAuth.js";
import { getProjectRow, listProjectsWireForOrgs, resolveProjectByApiKey } from "../project/projects.js";
import { logger } from "../../log.js";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZE_REQUEST_TTL_MS,
  MCP_READ_SCOPE,
  MCP_SCOPES_SUPPORTED,
  REFRESH_TOKEN_TTL_MS,
  redirectUriAllowed,
  resourceMatches,
} from "./config.js";
import {
  deleteCode,
  getClient,
  getCode,
  getToken,
  hashSecret,
  insertClient,
  insertCode,
  insertTokens,
  newAccessToken,
  newAuthorizationCode,
  newRefreshToken,
  pruneExpired,
  retireForRotation,
  revokeGrant,
  touchClient,
  touchToken,
  type TokenRow,
} from "./oauthStore.js";
import { renderAuthorizePage, renderMessagePage, type AuthorizeField } from "./authorizePage.js";

// The engine as an OAuth 2.1 authorization server for its own /mcp endpoint. The SDK's
// mcpAuthRouter owns the wire protocol (metadata documents, PKCE verification, dynamic client
// registration parsing, token endpoint grammar); this class owns storage and the one thing the
// protocol cannot know: who the resource owner is on THIS instance and which project they are
// granting. That step follows the instance's auth mode -
//
//   AGENTX_AUTH=enabled   the dashboard session identifies the user; they pick a project of
//                         their organization on the consent page.
//   AGENTX_AUTH=disabled  there are no users. The consent page asks for the project API key,
//                         which is the same credential the instance already hands to anything
//                         that can reach its port - the flow adds a real browser-mediated grant
//                         (claude.ai can only do OAuth) without inventing a second identity.
//
// A minted access token is therefore a short-lived, audience-bound stand-in for a project API
// key, and requireMcpAuth (routes/mcp.ts) treats it as exactly that.

type Bundle = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string;
  resource: string;
  exp: string;
};

const BUNDLE_FIELDS: (keyof Bundle)[] = ["client_id", "redirect_uri", "code_challenge", "state", "scope", "resource", "exp"];

// The consent form carries the authorization request back as hidden fields signed with the
// instance secret (the same one better-auth sessions use, generated and persisted on first use
// in both auth modes), so a multi-replica deployment needs no shared pending-request table and a
// tampered form is rejected before any principal check runs.
let secretCache: string | null = null;
async function bundleSecret(): Promise<string> {
  if (!secretCache) secretCache = await resolveAuthSecret(getDb());
  return secretCache;
}

function bundleSignature(bundle: Bundle, secret: string): string {
  const canonical = BUNDLE_FIELDS.map(field => bundle[field]).join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function normalizeScopes(requested: string[] | undefined): string[] {
  if (!requested || requested.length === 0) return [MCP_READ_SCOPE];
  const unknown = requested.filter(scope => !MCP_SCOPES_SUPPORTED.includes(scope));
  if (unknown.length > 0) {
    throw new InvalidScopeError(`Unknown scope(s): ${unknown.join(", ")}. Supported: ${MCP_SCOPES_SUPPORTED.join(", ")}`);
  }
  return [...new Set(requested)];
}

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  res.redirect(302, url.href);
}

// Registered client metadata is attacker-supplied (anyone can call /register), and HTML escaping
// does not neutralize a `javascript:` href - only an http(s) client_uri becomes a link.
function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function pageHeaders(res: Response): string {
  const nonce = randomBytes(16).toString("base64");
  res.set("Cache-Control", "no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.type("html");
  return nonce;
}

export class EngineOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly resource: URL,
    private readonly dashboardUrl: string
  ) {
    this.clientsStore = {
      getClient: clientId => getClient(getDb(), clientId),
      registerClient: async client => {
        if (client.redirect_uris.length === 0) {
          throw new InvalidClientMetadataError("At least one redirect_uri is required");
        }
        for (const uri of client.redirect_uris) {
          if (!redirectUriAllowed(uri)) {
            throw new InvalidClientMetadataError(
              `redirect_uri ${uri} is not allowed on this instance (set AGENTX_MCP_REDIRECT_ALLOWLIST to add it)`
            );
          }
        }
        // The SDK generates the id before calling this (clientIdGeneration defaults to true);
        // the fallback only guards a future option change.
        const withId = client as OAuthClientInformationFull;
        const info: OAuthClientInformationFull = {
          ...withId,
          client_id: withId.client_id || randomUUID(),
          client_id_issued_at: withId.client_id_issued_at ?? Math.floor(Date.now() / 1000),
        };
        await insertClient(getDb(), info);
        logger.info({ clientId: info.client_id, clientName: info.client_name ?? null }, "MCP OAuth client registered");
        return info;
      },
    };
  }

  // GET /authorize after the SDK validated client_id, redirect_uri, PKCE method and response_type.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !resourceMatches(params.resource, this.resource)) {
      throw new InvalidTargetError(`This MCP server's resource identifier is ${this.resource.href}`);
    }
    const scopes = normalizeScopes(params.scopes);
    const bundle: Bundle = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state ?? "",
      scope: scopes.join(" "),
      resource: params.resource?.href ?? "",
      exp: String(Date.now() + AUTHORIZE_REQUEST_TTL_MS),
    };
    await this.renderConsent(res.req as Request, res, client, bundle, null, 200);
  }

  private async renderConsent(
    req: Request,
    res: Response,
    client: OAuthClientInformationFull,
    bundle: Bundle,
    error: string | null,
    status: number
  ): Promise<void> {
    const sig = bundleSignature(bundle, await bundleSecret());
    const hidden: AuthorizeField[] = [...BUNDLE_FIELDS.map(name => ({ name, value: bundle[name] })), { name: "sig", value: sig }];
    let mode: Parameters<typeof renderAuthorizePage>[0]["mode"];
    if (authMode() === "enabled") {
      const user = await getSessionUser(req);
      if (!user) {
        mode = { kind: "enabled", signedIn: false };
      } else {
        const projects = await listProjectsWireForOrgs(getDb(), await getUserOrganizationIds(user.id));
        mode = {
          kind: "enabled",
          signedIn: true,
          email: user.email,
          projects: projects.map(p => ({ id: p._id, name: p.name })),
        };
      }
    } else {
      mode = { kind: "disabled" };
    }
    const nonce = pageHeaders(res);
    res.status(status).send(
      renderAuthorizePage(
        {
          clientName: client.client_name ?? client.client_id,
          clientUri: httpUrlOrNull(client.client_uri),
          scopes: bundle.scope.split(" ").filter(Boolean),
          redirectHost: new URL(bundle.redirect_uri).host,
          hidden,
          mode,
          error,
          dashboardUrl: this.dashboardUrl,
        },
        nonce
      )
    );
  }

  // POST /authorize/decision - the consent form. Verifies the signed bundle, identifies the
  // resource owner per auth mode, mints a single-use code, and redirects back to the client.
  async decision(req: Request, res: Response): Promise<void> {
    // A cross-site form post cannot be a consent click. Browsers that send the header make this
    // exact; the session cookie's SameSite=Lax covers the ones that do not.
    const site = req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      res.status(403).send(renderMessagePage("Request refused", "The consent form must be submitted from this site.", pageHeaders(res)));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    const bundle = Object.fromEntries(BUNDLE_FIELDS.map(name => [name, field(name)])) as Bundle;
    const expected = bundleSignature(bundle, await bundleSecret());
    const provided = field("sig");
    const signatureOk =
      provided.length === expected.length && timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
    if (!signatureOk || !Number.isFinite(Number(bundle.exp)) || Number(bundle.exp) < Date.now()) {
      res
        .status(400)
        .send(renderMessagePage("Authorization request expired", "Start the connection again from your MCP client.", pageHeaders(res)));
      return;
    }
    const client = await getClient(getDb(), bundle.client_id);
    if (!client || !client.redirect_uris.some(registered => redirectUriMatches(bundle.redirect_uri, registered))) {
      res.status(400).send(renderMessagePage("Unknown client", "This client is not registered with this instance.", pageHeaders(res)));
      return;
    }
    if (field("action") !== "approve") {
      redirectWith(res, bundle.redirect_uri, { error: "access_denied", error_description: "The user declined", state: bundle.state });
      return;
    }

    // Who is granting, and for which project.
    let projectId: string;
    let organizationId: string | null = null;
    let userId: string | null = null;
    if (authMode() === "enabled") {
      const user = await getSessionUser(req);
      if (!user) {
        await this.renderConsent(req, res, client, bundle, "Sign in to approve this connection.", 401);
        return;
      }
      const orgs = await getUserOrganizationIds(user.id);
      const requested = field("project_id");
      const project = requested ? await getProjectRow(getDb(), requested) : null;
      if (!project || !project.organizationId || !orgs.includes(project.organizationId)) {
        await this.renderConsent(req, res, client, bundle, "Pick a project you are a member of.", 403);
        return;
      }
      projectId = project.id;
      organizationId = project.organizationId;
      userId = user.id;
    } else {
      const project = await resolveProjectByApiKey(getDb(), field("api_key"));
      if (!project) {
        await this.renderConsent(req, res, client, bundle, "That project API key was not recognized.", 401);
        return;
      }
      projectId = project.id;
      organizationId = project.organizationId ?? null;
    }

    const code = newAuthorizationCode();
    const now = new Date();
    await insertCode(getDb(), {
      codeHash: hashSecret(code),
      clientId: client.client_id,
      projectId,
      organizationId,
      userId,
      scopes: bundle.scope.split(" ").filter(Boolean),
      codeChallenge: bundle.code_challenge,
      redirectUri: bundle.redirect_uri,
      resource: bundle.resource || null,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
      createdAt: now,
    });
    logger.info({ clientId: client.client_id, projectId, userId }, "MCP OAuth grant approved");
    redirectWith(res, bundle.redirect_uri, { code, state: bundle.state });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await getCode(getDb(), hashSecret(authorizationCode));
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const db = getDb();
    const codeHash = hashSecret(authorizationCode);
    const row = await getCode(db, codeHash);
    // Consumed on first sight, valid or not: a replayed code must fail even if this exchange does.
    if (row) await deleteCode(db, codeHash);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError("Authorization code has expired");
    }
    if (redirectUri && !redirectUriMatches(redirectUri, row.redirectUri)) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !resourceMatches(resource, this.resource)) {
      throw new InvalidTargetError(`This MCP server's resource identifier is ${this.resource.href}`);
    }
    void pruneExpired(db).catch((err: unknown) => logger.warn({ err }, "MCP OAuth prune failed"));
    void touchClient(db, client.client_id).catch(() => undefined);
    return this.mint({
      grantId: nanoid(),
      clientId: client.client_id,
      projectId: row.projectId,
      organizationId: row.organizationId,
      userId: row.userId,
      scopes: row.scopes,
      resource: row.resource ?? resource?.href ?? null,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const db = getDb();
    const row = await getToken(db, hashSecret(refreshToken));
    if (!row || row.kind !== "refresh" || row.clientId !== client.client_id || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (scopes && scopes.some(scope => !row.scopes.includes(scope))) {
      throw new InvalidScopeError("Requested scope exceeds the original grant");
    }
    if (resource && !resourceMatches(resource, this.resource)) {
      throw new InvalidTargetError(`This MCP server's resource identifier is ${this.resource.href}`);
    }
    // Rotation (OAuth 2.1 for public clients): the presented refresh token and every access
    // token under the grant are retired before the replacement pair is written.
    await retireForRotation(db, row.grantId);
    void touchClient(db, client.client_id).catch(() => undefined);
    return this.mint({
      grantId: row.grantId,
      clientId: row.clientId,
      projectId: row.projectId,
      organizationId: row.organizationId,
      userId: row.userId,
      scopes: scopes && scopes.length > 0 ? scopes : row.scopes,
      resource: row.resource,
    });
  }

  private async mint(grant: {
    grantId: string;
    clientId: string;
    projectId: string;
    organizationId: string | null;
    userId: string | null;
    scopes: string[];
    resource: string | null;
  }): Promise<OAuthTokens> {
    const accessToken = newAccessToken();
    const refreshToken = newRefreshToken();
    const now = new Date();
    const base = {
      grantId: grant.grantId,
      clientId: grant.clientId,
      projectId: grant.projectId,
      organizationId: grant.organizationId,
      userId: grant.userId,
      scopes: grant.scopes,
      resource: grant.resource,
      revokedAt: null,
      createdAt: now,
      lastUsedAt: null,
    };
    const rows: TokenRow[] = [
      { ...base, tokenHash: hashSecret(accessToken), kind: "access", expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS) },
      { ...base, tokenHash: hashSecret(refreshToken), kind: "refresh", expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS) },
    ];
    await insertTokens(getDb(), rows);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  // Resource-server side: every /mcp request with an OAuth bearer lands here (via the SDK's
  // requireBearerAuth). Audience, expiry, revocation and the project's continued existence are
  // all checked per request - there is no cached verdict to go stale.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const db = getDb();
    const row = await getToken(db, hashSecret(token));
    if (!row || row.kind !== "access" || row.revokedAt) {
      throw new InvalidTokenError("Invalid access token");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new InvalidTokenError("Access token has expired");
    }
    if (!resourceMatches(row.resource, this.resource)) {
      throw new InvalidTokenError("Access token was not issued for this resource");
    }
    if (!(await getProjectRow(db, row.projectId))) {
      throw new InvalidTokenError("The project this token was issued for no longer exists");
    }
    void touchToken(db, row.tokenHash).catch(() => undefined);
    return {
      token,
      clientId: row.clientId,
      scopes: row.scopes,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: {
        projectId: row.projectId,
        organizationId: row.organizationId,
        userId: row.userId,
        grantId: row.grantId,
      },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = await getToken(getDb(), hashSecret(request.token));
    // Unknown or foreign tokens are a silent no-op per RFC 7009 - the response must not reveal
    // whether the token ever existed.
    if (!row || row.clientId !== client.client_id) return;
    await revokeGrant(getDb(), row.grantId);
  }
}
