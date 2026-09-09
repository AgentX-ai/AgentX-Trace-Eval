// Configuration for the engine's MCP surface (routes/mcp.ts): where the endpoint lives, who the
// OAuth issuer is, which scopes exist, and which redirect URIs a dynamically registered client
// may use. Env-driven and dependency-free so both the route layer and the OAuth provider can
// read it without pulling in each other.

export const MCP_PATH = "/mcp";

// The one scope that exists today: every tool is read-only, so a second scope would be a placebo
// checkbox on the consent page. Add "mcp:write" the day a tool mutates something.
export const MCP_READ_SCOPE = "mcp:read";
export const MCP_SCOPES_SUPPORTED = [MCP_READ_SCOPE];

export function mcpEnabled(): boolean {
  return process.env.AGENTX_MCP !== "disabled";
}

// The OAuth issuer is the instance's public origin. AGENTX_PUBLIC_URL pins it (the same variable
// dashboard auth already uses for callbacks); without it the issuer is the loopback origin on
// the listening port, which is exactly right for a client on the same machine (Claude Code) and
// exactly wrong for anything else - claude.ai cannot reach it, and the spec requires HTTPS for
// any non-loopback issuer, which mcpOauthAvailable() enforces below.
//
// Normalized to the origin: RFC 8414 puts the metadata document at a path derived from the
// issuer, and the SDK serves it at /.well-known/oauth-authorization-server on the root, so a
// path component on the issuer would point clients at a document that is not there.
export function mcpIssuerUrl(port: number): URL {
  const pinned = process.env.AGENTX_PUBLIC_URL?.trim();
  const base = pinned ? new URL(pinned) : new URL(`http://localhost:${port}`);
  return new URL(base.origin + "/");
}

// The canonical RFC 8707 resource identifier of this MCP server - what clients send as
// `resource` and what tokens are audience-bound to.
export function mcpResourceUrl(issuer: URL): URL {
  return new URL(MCP_PATH, issuer);
}

// OAuth endpoints only mount on an issuer the spec allows: HTTPS, or plain HTTP on loopback.
// A plain-HTTP public URL would be refused by the SDK's router anyway; this makes the reason
// visible in the boot log instead of a stack trace.
export function mcpOauthAvailable(issuer: URL): boolean {
  if (issuer.protocol === "https:") return true;
  return issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1" || issuer.hostname === "[::1]";
}

// Audience check: a token (or an authorization request) names the resource it is for; it must
// be this server. Trailing-slash and case differences in the origin are not different servers.
export function resourceMatches(candidate: string | URL | null | undefined, canonical: URL): boolean {
  if (candidate === null || candidate === undefined) return true;
  let url: URL;
  try {
    url = typeof candidate === "string" ? new URL(candidate) : candidate;
  } catch {
    return false;
  }
  const norm = (u: URL) => `${u.origin.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  return url.hash === "" && url.search === "" && norm(url) === norm(canonical);
}

// Redirect URIs a dynamically registered client may present. /register is unauthenticated by
// spec, so an open redirect list would let anyone register a client that receives authorization
// codes for this instance; the list below is what real MCP hosts use, and
// AGENTX_MCP_REDIRECT_ALLOWLIST extends it (comma-separated; an entry ending in `*` matches by
// prefix, anything else must match exactly).
//
// Loopback on any port is allowed by RFC 8252 for native clients (Claude Code picks an
// ephemeral port); the SDK's authorize handler relaxes the port the same way when it later
// compares the request against the registered URI.
const DEFAULT_REDIRECT_ALLOWLIST = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function redirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)) {
    return true;
  }
  const extra = (process.env.AGENTX_MCP_REDIRECT_ALLOWLIST ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  for (const entry of [...DEFAULT_REDIRECT_ALLOWLIST, ...extra]) {
    if (entry.endsWith("*")) {
      if (uri.startsWith(entry.slice(0, -1))) return true;
    } else if (entry === uri) {
      return true;
    }
  }
  return false;
}

// Token lifetimes. Access tokens are short so a leaked one is worth little; the refresh token
// is what keeps a claude.ai connector working between conversations, rotated on every use.
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
// How long an unsubmitted consent page stays valid.
export const AUTHORIZE_REQUEST_TTL_MS = 15 * 60 * 1000;
