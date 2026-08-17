import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// Remote MCP introspection for the Register Tool flow: connect to a remote MCP server, list its
// tools, hand the shapes back for human review. Two auth shapes exist in the wild:
//
//   1. Open/header-authed servers: connect straight through (optional user-supplied key-value
//      pairs sent as HTTP headers - the only channel a REMOTE server has; true env vars only
//      exist for stdio-launched local servers, which self-host doesn't spawn).
//   2. OAuth servers (PayPal, Atlassian, ...): the spec's OAuth 2.1 flow - the server 401s with
//      a challenge, the SDK discovers the authorization server, dynamically registers a client,
//      and hands us an authorization URL the USER must visit in a browser popup. The engine
//      keeps a short-lived in-memory session (PKCE verifier, client registration, tokens); the
//      popup lands on the unauthenticated /api/v1/mcp-oauth/callback route (index.ts), which
//      finishes the code exchange, and the dashboard's next poll of this module connects with
//      the stored tokens.
//
// Nothing here executes MCP tools; the registered result is ordinary tool-schema rows.

const CONNECT_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 15 * 60_000;

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpLoadResult =
  | { tools: McpToolInfo[] }
  | { authRequired: true; authorizationUrl: string; sessionId: string }
  | { error: string };

type TransportKind = "streamable" | "sse";

type McpSession = {
  id: string;
  serverUrl: string;
  headers: Record<string, string>;
  callbackUrl: string;
  transportKind: TransportKind | null;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  tokens?: OAuthTokens;
  authorizationUrl?: string;
  createdAt: number;
};

const sessions = new Map<string, McpSession>();

function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}

// Bridges the SDK's OAuth hooks onto the in-memory session: the SDK drives discovery, dynamic
// client registration, and PKCE; we only persist what it hands us and capture the authorization
// URL instead of "redirecting" (there's no user agent on the server side - the dashboard opens
// the URL in a popup).
class SessionOAuthProvider implements OAuthClientProvider {
  constructor(private session: McpSession) {}
  get redirectUrl(): string {
    return this.session.callbackUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AgentX Self-Host",
      redirect_uris: [this.session.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    return this.session.id;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.session.clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.session.clientInformation = info;
  }
  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.session.tokens = tokens;
  }
  redirectToAuthorization(authorizationUrl: URL): void {
    this.session.authorizationUrl = authorizationUrl.toString();
  }
  saveCodeVerifier(codeVerifier: string): void {
    this.session.codeVerifier = codeVerifier;
  }
  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error("No PKCE verifier saved for this MCP auth session");
    return this.session.codeVerifier;
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)
    ),
  ]);
}

function buildTransport(session: McpSession, kind: TransportKind) {
  const url = new URL(session.serverUrl);
  const options = {
    authProvider: new SessionOAuthProvider(session),
    requestInit: { headers: session.headers },
  };
  return kind === "streamable" ? new StreamableHTTPClientTransport(url, options) : new SSEClientTransport(url, options);
}

// Real-world servers ship tool schemas whose regex patterns JavaScript's unicode mode rejects
// (PayPal: "^https\:\/\/"); the SDK's default Ajv provider compiles every outputSchema during
// listTools and throws on them. This flow only introspects - tools are never executed here - so
// schema validation buys nothing and a permissive validator keeps listing robust.
const permissiveValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

async function listViaTransport(session: McpSession, kind: TransportKind): Promise<McpToolInfo[]> {
  const client = new Client(
    { name: "agentx-selfhost", version: "1.0.0" },
    { jsonSchemaValidator: permissiveValidator }
  );
  const transport = buildTransport(session, kind);
  try {
    await withTimeout(client.connect(transport), "Connecting to the MCP server");
    const result = await withTimeout(client.listTools(), "Listing MCP tools");
    return (result.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

// Streamable HTTP first (current spec transport), legacy SSE fallback - EXCEPT that an OAuth
// challenge on either transport short-circuits into the auth flow rather than being treated as
// a connection failure.
export async function loadMcpTools(input: {
  serverUrl: string;
  headers: Record<string, string>;
  callbackUrl: string;
  sessionId?: string;
}): Promise<McpLoadResult> {
  sweepSessions();
  let url: URL;
  try {
    url = new URL(input.serverUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    return { error: "serverUrl must be an http(s) URL" };
  }

  let session = input.sessionId ? sessions.get(input.sessionId) : undefined;
  if (!session) {
    session = {
      id: randomUUID(),
      serverUrl: url.toString(),
      headers: input.headers,
      callbackUrl: input.callbackUrl,
      transportKind: null,
      createdAt: Date.now(),
    };
    sessions.set(session.id, session);
  }

  // Pending-consent guard: while a consent popup is outstanding (authorization URL minted, no
  // tokens yet), a dashboard poll must NOT reconnect - the SDK would restart the flow and rotate
  // the PKCE verifier, invalidating the code the user is about to come back with. Hand back the
  // same URL until the callback stores tokens.
  if (session.authorizationUrl && !session.tokens) {
    return { authRequired: true, authorizationUrl: session.authorizationUrl, sessionId: session.id };
  }

  const kinds: TransportKind[] = session.transportKind
    ? [session.transportKind]
    : url.pathname.endsWith("/sse")
      ? ["sse", "streamable"]
      : ["streamable", "sse"];

  let firstError: unknown = null;
  for (const kind of kinds) {
    try {
      const tools = await listViaTransport(session, kind);
      sessions.delete(session.id);
      return { tools };
    } catch (err) {
      if (err instanceof UnauthorizedError && session.authorizationUrl) {
        // The SDK ran discovery + dynamic registration and produced a consent URL - hand it to
        // the dashboard to open in a popup; the callback route finishes the exchange.
        session.transportKind = kind;
        return { authRequired: true, authorizationUrl: session.authorizationUrl, sessionId: session.id };
      }
      console.error(`[mcp] ${kind} connect to ${session.serverUrl} failed (session ${session.id}):`, err);
      firstError = firstError ?? err;
    }
  }
  sessions.delete(session.id);
  const message = firstError instanceof Error ? firstError.message : "connection failed";
  return { error: `Could not load the MCP server: ${message.slice(0, 180)}${message.length > 180 ? "..." : ""}` };
}

// The OAuth callback's half: exchange the authorization code against the session's transport
// (PKCE verifier + registered client both live on the session) and store the tokens. The
// dashboard's ongoing poll then reconnects with them.
export async function finishMcpAuth(sessionId: string, code: string): Promise<{ ok: true } | { error: string }> {
  sweepSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    return { error: "Authorization session not found or expired - reload the MCP server and try again" };
  }
  try {
    const transport = buildTransport(session, session.transportKind ?? "streamable");
    await withTimeout(transport.finishAuth(code), "Exchanging the authorization code");
    // Clear the consumed consent URL: if the server 401s again later, the SDK must mint a fresh
    // one (and the pending-consent guard above must not trap the session on the dead URL).
    session.authorizationUrl = undefined;
    return { ok: true };
  } catch (err) {
    console.error(`[mcp] token exchange failed for session ${sessionId}:`, err);
    const message = err instanceof Error ? err.message : "token exchange failed";
    return { error: `Authorization failed: ${message.slice(0, 180)}` };
  }
}
