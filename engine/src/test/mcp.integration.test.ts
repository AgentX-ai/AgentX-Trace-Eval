import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { mcpGrantsResponseSchema } from "../contract/wire.js";
import { postJson, postgresAvailable, startEngine, type TestEngine } from "./server.js";

// The MCP connector surface (routes/mcp.ts, core/mcp/*), driven by the real MCP SDK client the
// way Claude Code and claude.ai drive it: bearer project key for local clients, and the full
// OAuth 2.1 dance - discovery, dynamic client registration, consent page, PKCE code exchange,
// refresh rotation, revocation - for hosted ones. Both auth modes, because the consent page is
// where they differ.

// The engine's issuer defaults to http://localhost:<port> when AGENTX_PUBLIC_URL is unset, and
// the SDK client refuses a protected-resource document whose origin differs from the URL it was
// given, so the tests speak to localhost rather than the harness's 127.0.0.1.
function mcpUrl(engine: TestEngine): URL {
  return new URL(engine.baseUrl.replace("127.0.0.1", "localhost") + "/mcp");
}

function originOf(engine: TestEngine): string {
  return engine.baseUrl.replace("127.0.0.1", "localhost");
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

function textOf(result: unknown): string {
  return ((result as ToolResult).content ?? []).map(c => c.text ?? "").join("\n");
}

function parsed<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

async function keyClient(engine: TestEngine, key: string, header: "authorization" | "x-api-key" = "authorization"): Promise<Client> {
  const headers = header === "authorization" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
  const transport = new StreamableHTTPClientTransport(mcpUrl(engine), { requestInit: { headers } });
  const client = new Client({ name: "mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}

// Raw JSON-RPC over fetch, for the cases where the interesting part is the HTTP status.
async function rawToolsList(engine: TestEngine, headers: Record<string, string>): Promise<Response> {
  return fetch(mcpUrl(engine), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

// What Claude Code / claude.ai keep on their side of the flow.
class MemoryOAuthProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  toks?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return "http://localhost:9999/callback";
  }
  get clientMetadata() {
    return {
      client_name: "Test connector",
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.toks;
  }
  saveTokens(tokens: OAuthTokens) {
    this.toks = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

// Kicks off the flow the way a client does: connect, get bounced, capture the authorization URL.
async function beginOAuth(engine: TestEngine): Promise<{ provider: MemoryOAuthProvider; transport: StreamableHTTPClientTransport }> {
  const provider = new MemoryOAuthProvider();
  const transport = new StreamableHTTPClientTransport(mcpUrl(engine), { authProvider: provider });
  const client = new Client({ name: "mcp-test-oauth", version: "0" });
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl, "no authorization URL captured").toBeDefined();
  expect(provider.info?.client_id, "dynamic client registration did not happen").toBeTruthy();
  return { provider, transport };
}

// The consent page's hidden fields (the signed request bundle) as a form body.
function hiddenFields(html: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(match[1]!, match[2]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));
  }
  return form;
}

async function consentPage(engine: TestEngine, authorizationUrl: URL, cookie?: string): Promise<{ status: number; html: string; form: URLSearchParams }> {
  const res = await fetch(authorizationUrl, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const html = await res.text();
  return { status: res.status, html, form: hiddenFields(html) };
}

async function decide(
  engine: TestEngine,
  form: URLSearchParams,
  extra: Record<string, string>,
  cookie?: string
): Promise<{ status: number; location: string | null; body: string }> {
  const body = new URLSearchParams(form);
  for (const [k, v] of Object.entries(extra)) body.set(k, v);
  const res = await fetch(`${originOf(engine)}/authorize/decision`, {
    method: "POST",
    body,
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

async function tokenRequest(engine: TestEngine, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${originOf(engine)}/token`, { method: "POST", body: new URLSearchParams(params) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// End-to-end grant in disabled mode: returns a connected client plus everything needed to poke
// at the tokens afterwards.
async function grantWithKey(engine: TestEngine, key: string) {
  const { provider, transport } = await beginOAuth(engine);
  const page = await consentPage(engine, provider.authorizationUrl!);
  expect(page.status).toBe(200);
  const decision = await decide(engine, page.form, { action: "approve", api_key: key });
  expect(decision.status, decision.body).toBe(302);
  const code = new URL(decision.location!).searchParams.get("code")!;
  expect(code).toBeTruthy();
  await transport.finishAuth(code);
  const client = new Client({ name: "mcp-test-oauth", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(engine), { authProvider: provider }));
  return { provider, client, code };
}

const EXPECTED_TOOLS = [
  "agentx_whoami",
  "agentx_list_traces",
  "agentx_get_trace",
  "agentx_list_sessions",
  "agentx_get_session",
  "agentx_get_kpis",
  "agentx_list_signals",
  "agentx_get_signal",
  "agentx_list_agents",
  "agentx_list_topics",
  "agentx_list_datasets",
  "agentx_get_dataset",
  "agentx_list_evaluations",
  "agentx_get_evaluation",
  "agentx_list_prompts",
  "agentx_get_prompt",
  "agentx_list_tool_schemas",
  "agentx_get_coverage",
  "agentx_probe_coverage",
];

const ROTATION_GRACE_MS = 1500;

describe("MCP endpoint, AGENTX_AUTH=disabled", () => {
  let engine: TestEngine;
  let otherKey = "";
  let sessionId = "";

  beforeAll(async () => {
    // A short rotation grace window (default 60s) so the reuse-after-grace path below runs in
    // test time; everything else is the production configuration.
    engine = await startEngine({ AGENTX_MCP_REFRESH_GRACE_MS: String(ROTATION_GRACE_MS) });
    sessionId = `mcp-session-${Date.now()}`;
    for (const turn of ["first turn", "second turn"]) {
      const res = await engine.json("/api/v1/ingest/traces", postJson({ name: "mcp-agent", input: turn, output: `answer to ${turn}`, session_id: sessionId }));
      expect(res.status).toBe(200);
    }
    const long = await engine.json("/api/v1/ingest/traces", postJson({ name: "mcp-agent", input: "long", output: "x".repeat(2000) }));
    expect(long.status).toBe(200);
    const dataset = await engine.json(
      "/api/v1/custom-agent-evaluations/datasets",
      postJson({ name: "mcp dataset", questions: [{ main_question: { question: "How do I cancel?", expectedResults: "From settings." } }] })
    );
    expect(dataset.status, JSON.stringify(dataset.body)).toBeLessThan(300);

    // A second project with its own trace, for the isolation cases below.
    const other = await engine.json("/api/v1/projects", postJson({ name: "Other project" }));
    expect(other.status).toBe(201);
    otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const otherTrace = await engine.json("/api/v1/ingest/traces", { ...postJson({ name: "other-agent", input: "secret q", output: "secret a" }), apiKey: otherKey });
    expect(otherTrace.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("answers 401 with the protected-resource hint when no credential is sent", async () => {
    const res = await rawToolsList(engine, {});
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${originOf(engine)}/.well-known/oauth-protected-resource/mcp"`);
    await res.text();
  });

  it("rejects an unknown project key and an unknown OAuth token alike", async () => {
    expect((await rawToolsList(engine, { Authorization: "Bearer agtx_local_nope" })).status).toBe(401);
    expect((await rawToolsList(engine, { "x-api-key": "agtx_local_nope" })).status).toBe(401);
    expect((await rawToolsList(engine, { Authorization: "Bearer agtx_mcp_at_nope" })).status).toBe(401);
  });

  it("serves clients whatever Accept header they send, streaming only when asked", async () => {
    // A connector that sends `*/*` (or nothing) used to be refused at the handshake with a 406
    // it never surfaced, so it registered no tools at all and the model improvised around it.
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "accept-probe", version: "0" } },
    };
    const handshake = (accept: string) =>
      fetch(mcpUrl(engine), {
        method: "POST",
        headers: { "content-type": "application/json", accept, authorization: `Bearer ${engine.apiKey}` },
        body: JSON.stringify(init),
      });

    // Spec-compliant client: an event stream, exactly as before.
    const both = await handshake("application/json, text/event-stream");
    expect(both.status).toBe(200);
    expect(both.headers.get("content-type")).toContain("text/event-stream");
    expect(await both.text()).toContain("event: message");

    // Wildcard and JSON-only clients: a single JSON body they can actually parse.
    for (const accept of ["*/*", "application/json", "application/*", "application/json;q=1, */*;q=0.1"]) {
      const res = await handshake(accept);
      expect(res.status, `Accept: ${accept}`).toBe(200);
      expect(res.headers.get("content-type"), `Accept: ${accept}`).toContain("application/json");
      const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
      expect(body.result?.serverInfo?.name, `Accept: ${accept}`).toBe("agentx-self-host");
    }

    // A client that named the stream type alone still gets the stream.
    const streamOnly = await handshake("text/event-stream");
    expect(streamOnly.status).toBe(200);
    expect(streamOnly.headers.get("content-type")).toContain("text/event-stream");

    // Nothing we can serve, and nothing to guess at: the 406 stands.
    const unusable = await handshake("text/plain");
    expect(unusable.status).toBe(406);

    // And the negotiated JSON path carries real tool results, not just the handshake.
    const tools = await fetch(mcpUrl(engine), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*", authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listed = (await tools.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map(t => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("only speaks POST (stateless transport)", async () => {
    const res = await fetch(mcpUrl(engine));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    await res.text();
  });

  it("publishes RFC 9728 and RFC 8414 discovery documents", async () => {
    const prm = (await (await fetch(`${originOf(engine)}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${originOf(engine)}/mcp`, authorization_servers: [`${originOf(engine)}/`], scopes_supported: ["mcp:read"] });
    const as = (await (await fetch(`${originOf(engine)}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: `${originOf(engine)}/`,
      authorization_endpoint: `${originOf(engine)}/authorize`,
      token_endpoint: `${originOf(engine)}/token`,
      registration_endpoint: `${originOf(engine)}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("lists every read tool, all annotated read-only, with a bearer project key", async () => {
    const client = await keyClient(engine, engine.apiKey);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} is not marked read-only`).toBe(true);
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
    }
    await client.close();
  });

  it("accepts the key on x-api-key too, and whoami names the project and the credential kind", async () => {
    const client = await keyClient(engine, engine.apiKey, "x-api-key");
    const whoami = parsed<{ project: { name: string }; authMode: string; authenticatedWith: string }>(await client.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.project.name).toBe("Default");
    expect(whoami.authMode).toBe("disabled");
    expect(whoami.authenticatedWith).toBe("project API key");
    await client.close();
  });

  it("lists and reads traces: clipped in the list, complete in the detail, not-found as a tool error", async () => {
    const client = await keyClient(engine, engine.apiKey);
    const list = parsed<{ traces: { _id: string; name: string; output: string }[]; totalCount: number }>(
      await client.callTool({ name: "agentx_list_traces", arguments: { limit: 10 } })
    );
    expect(list.totalCount).toBeGreaterThanOrEqual(3);
    const long = list.traces.find(t => t.output.includes("more chars"));
    expect(long, "the 2000-char output should be clipped in the list").toBeDefined();
    expect(long!.output.length).toBeLessThan(700);

    const detail = parsed<{ _id: string; output: string; toolCalls?: unknown }>(await client.callTool({ name: "agentx_get_trace", arguments: { traceId: long!._id } }));
    expect(detail._id).toBe(long!._id);
    expect(detail.output).toBe("x".repeat(2000));

    const missing = (await client.callTool({ name: "agentx_get_trace", arguments: { traceId: "does-not-exist" } })) as ToolResult;
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("not found");
    await client.close();
  });

  it("groups the session's turns and returns them in order", async () => {
    const client = await keyClient(engine, engine.apiKey);
    const sessions = parsed<{ sessions: { sessionId: string; turnCount: number }[] }>(await client.callTool({ name: "agentx_list_sessions", arguments: { window: "24h" } }));
    const mine = sessions.sessions.find(s => s.sessionId === sessionId);
    expect(mine?.turnCount).toBe(2);
    const detail = parsed<{ spans: { input: string }[]; scores: unknown[] }>(await client.callTool({ name: "agentx_get_session", arguments: { sessionId } }));
    expect(detail.spans.map(s => s.input)).toEqual(["first turn", "second turn"]);
    expect(Array.isArray(detail.scores)).toBe(true);
    await client.close();
  });

  it("covers the evaluate, monitor and insights surfaces without errors", async () => {
    const client = await keyClient(engine, engine.apiKey);
    const datasets = parsed<{ datasets: { _id: string; name: string; caseCount: number; questions?: unknown }[] }>(await client.callTool({ name: "agentx_list_datasets", arguments: {} }));
    const dataset = datasets.datasets.find(d => d.name === "mcp dataset");
    expect(dataset?.caseCount).toBe(1);
    expect(dataset?.questions, "list view must not carry the cases").toBeUndefined();
    const full = parsed<{ questions: unknown[] }>(await client.callTool({ name: "agentx_get_dataset", arguments: { datasetId: dataset!._id } }));
    expect(full.questions).toHaveLength(1);

    for (const [name, args] of [
      ["agentx_get_kpis", { window: "7d" }],
      ["agentx_list_signals", { limit: 5 }],
      ["agentx_list_agents", {}],
      ["agentx_list_topics", {}],
      ["agentx_list_evaluations", { limit: 5 }],
      ["agentx_list_prompts", {}],
      ["agentx_list_tool_schemas", {}],
      ["agentx_get_coverage", {}],
      ["agentx_probe_coverage", { query: "how do I cancel my plan" }],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as ToolResult;
      expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy();
      expect(() => JSON.parse(textOf(result)), `${name} did not return JSON`).not.toThrow();
    }
    const agents = parsed<{ agents: { name: string }[] }>(await client.callTool({ name: "agentx_list_agents", arguments: {} }));
    expect(agents.agents.map(a => a.name)).toContain("mcp-agent");
    await client.close();
  });

  it("rejects arguments outside the schema at the protocol level", async () => {
    const client = await keyClient(engine, engine.apiKey);
    // The SDK surfaces schema failures as an error result (the server never ran the tool), so a
    // model sees why its arguments were refused instead of a bare protocol failure.
    const result = (await client.callTool({ name: "agentx_list_traces", arguments: { limit: 500 } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/validation|Invalid arguments/i);
    await client.close();
  });

  it("scopes everything to the key's project", async () => {
    const client = await keyClient(engine, engine.apiKey);
    const other = await keyClient(engine, otherKey);
    const mine = parsed<{ traces: { _id: string; name: string }[] }>(await client.callTool({ name: "agentx_list_traces", arguments: {} }));
    const theirs = parsed<{ traces: { _id: string; name: string }[] }>(await other.callTool({ name: "agentx_list_traces", arguments: {} }));
    expect(theirs.traces.map(t => t.name)).toEqual(["other-agent"]);
    expect(mine.traces.map(t => t.name)).not.toContain("other-agent");
    const crossRead = (await client.callTool({ name: "agentx_get_trace", arguments: { traceId: theirs.traces[0]!._id } })) as ToolResult;
    expect(crossRead.isError).toBe(true);
    const whoami = parsed<{ project: { name: string } }>(await other.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.project.name).toBe("Other project");
    await client.close();
    await other.close();
  });

  it("registers a client, renders the consent page, and mints tokens that reach the tools", async () => {
    const { provider, client } = await grantWithKey(engine, engine.apiKey);
    expect(provider.toks?.access_token).toMatch(/^agtx_mcp_at_/);
    expect(provider.toks?.refresh_token).toMatch(/^agtx_mcp_rt_/);
    expect(provider.toks?.scope).toBe("mcp:read");
    const whoami = parsed<{ project: { name: string }; authenticatedWith: string }>(await client.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.project.name).toBe("Default");
    expect(whoami.authenticatedWith).toBe("OAuth access token");
    await client.close();
  });

  it("renders a locked-down consent page in disabled mode", async () => {
    const { provider } = await beginOAuth(engine);
    const page = await consentPage(engine, provider.authorizationUrl!);
    expect(page.status).toBe(200);
    expect(page.html).toContain('name="api_key"');
    expect(page.html).toContain("Test connector");
    expect(page.html).toContain("frame-ancestors 'none'");
    // Chromium applies form-action to the redirect that follows the submit, so the client's
    // callback origin must be listed or the approval never leaves the consent page.
    expect(page.html).toContain(`form-action 'self' ${new URL(provider.redirectUrl).origin};`);
    expect(page.html).not.toContain(engine.apiKey);
    expect(page.form.get("client_id")).toBe(provider.info!.client_id);
    expect(page.form.get("sig")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a wrong key, honours a denial, and rejects a tampered bundle", async () => {
    const { provider } = await beginOAuth(engine);
    const { form } = await consentPage(engine, provider.authorizationUrl!);

    const wrongKey = await decide(engine, form, { action: "approve", api_key: "agtx_local_wrong" });
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.body).toContain("not recognized");

    const denied = await decide(engine, form, { action: "deny", api_key: engine.apiKey });
    expect(denied.status).toBe(302);
    expect(new URL(denied.location!).searchParams.get("error")).toBe("access_denied");

    const tampered = await decide(engine, form, { action: "approve", api_key: engine.apiKey, scope: "mcp:write" });
    expect(tampered.status).toBe(400);

    const malformed = await decide(engine, form, { action: "approve", api_key: engine.apiKey, sig: "zzz" });
    expect(malformed.status).toBe(400);
  });

  it("makes codes single-use and verifies PKCE", async () => {
    const { provider, code } = await grantWithKey(engine, engine.apiKey);
    const replay = await tokenRequest(engine, {
      grant_type: "authorization_code",
      code,
      code_verifier: provider.verifier,
      client_id: provider.info!.client_id,
      redirect_uri: provider.redirectUrl,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    // A fresh code with the wrong verifier: the PKCE check must fail before any token exists.
    const second = await beginOAuth(engine);
    const page = await consentPage(engine, second.provider.authorizationUrl!);
    const decision = await decide(engine, page.form, { action: "approve", api_key: engine.apiKey });
    const freshCode = new URL(decision.location!).searchParams.get("code")!;
    const badVerifier = await tokenRequest(engine, {
      grant_type: "authorization_code",
      code: freshCode,
      code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier",
      client_id: second.provider.info!.client_id,
      redirect_uri: second.provider.redirectUrl,
    });
    expect(badVerifier.status).toBe(400);
    expect(badVerifier.body.error).toBe("invalid_grant");

    // ...and burned the code: the right verifier no longer helps, so a stolen code cannot be
    // brute-forced against its challenge for the rest of its lifetime.
    const rightVerifierTooLate = await tokenRequest(engine, {
      grant_type: "authorization_code",
      code: freshCode,
      code_verifier: second.provider.verifier,
      client_id: second.provider.info!.client_id,
      redirect_uri: second.provider.redirectUrl,
    });
    expect(rightVerifierTooLate.status).toBe(400);
    expect(rightVerifierTooLate.body.error).toBe("invalid_grant");
  });

  it("rotates on refresh, lists the grant, and revokes it end to end", async () => {
    const { provider } = await grantWithKey(engine, engine.apiKey);
    const oldAccess = provider.toks!.access_token;

    const refreshed = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: provider.toks!.refresh_token!, client_id: provider.info!.client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe("mcp:read");
    const newAccess = refreshed.body.access_token as string;
    expect(newAccess).not.toBe(oldAccess);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${oldAccess}` })).status).toBe(401);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${newAccess}` })).status).toBe(200);

    // Presenting the rotated-out token again inside the grace window is a retry (two
    // conversations refreshing at once), not an attack: it gets a pair of its own and the first
    // successor keeps working.
    const retry = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: provider.toks!.refresh_token!, client_id: provider.info!.client_id });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.access_token).not.toBe(newAccess);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${newAccess}` })).status).toBe(200);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${retry.body.access_token as string}` })).status).toBe(200);

    const grants = await engine.json("/api/v1/mcp/grants");
    expect(grants.status).toBe(200);
    const contract = mcpGrantsResponseSchema.safeParse(grants.body);
    expect(contract.success, JSON.stringify(contract.success ? null : contract.error.issues)).toBe(true);
    const mine = (grants.body as { grants: { grantId: string; clientId: string; clientName: string }[] }).grants.find(g => g.clientId === provider.info!.client_id);
    expect(mine?.clientName).toBe("Test connector");

    // The other project sees none of this.
    const otherGrants = await engine.json("/api/v1/mcp/grants", { apiKey: otherKey });
    expect((otherGrants.body as { grants: unknown[] }).grants).toEqual([]);

    const revoked = await engine.request(`/api/v1/mcp/grants/${mine!.grantId}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${newAccess}` })).status).toBe(401);
    const after = await engine.json("/api/v1/mcp/grants");
    expect((after.body as { grants: { grantId: string }[] }).grants.some(g => g.grantId === mine!.grantId)).toBe(false);
  });

  it("treats a refresh token reused after the grace window as theft and revokes the grant", async () => {
    const { provider } = await grantWithKey(engine, engine.apiKey);
    const original = provider.toks!.refresh_token!;
    const first = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: original, client_id: provider.info!.client_id });
    expect(first.status).toBe(200);
    const liveAccess = first.body.access_token as string;
    expect((await rawToolsList(engine, { Authorization: `Bearer ${liveAccess}` })).status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, ROTATION_GRACE_MS + 200));
    const reuse = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: original, client_id: provider.info!.client_id });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    // OAuth 2.1 section 4.3.1: the whole grant goes, successor tokens included.
    expect((await rawToolsList(engine, { Authorization: `Bearer ${liveAccess}` })).status).toBe(401);
    const successor = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: first.body.refresh_token as string, client_id: provider.info!.client_id });
    expect(successor.status).toBe(400);
  });

  it("survives two concurrent refreshes of the same token", async () => {
    const { provider } = await grantWithKey(engine, engine.apiKey);
    const params = { grant_type: "refresh_token", refresh_token: provider.toks!.refresh_token!, client_id: provider.info!.client_id };
    const [a, b] = await Promise.all([tokenRequest(engine, params), tokenRequest(engine, params)]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    for (const result of [a, b]) {
      expect((await rawToolsList(engine, { Authorization: `Bearer ${result.body.access_token as string}` })).status).toBe(200);
    }
    // One grant, not two: the connected-apps list still shows a single entry for this client.
    const grants = await engine.json("/api/v1/mcp/grants");
    const mine = (grants.body as { grants: { clientId: string }[] }).grants.filter(g => g.clientId === provider.info!.client_id);
    expect(mine).toHaveLength(1);
  });

  it("supports RFC 7009 revocation from the client side", async () => {
    const { provider } = await grantWithKey(engine, engine.apiKey);
    const res = await fetch(`${originOf(engine)}/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: provider.toks!.refresh_token!, client_id: provider.info!.client_id }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect((await rawToolsList(engine, { Authorization: `Bearer ${provider.toks!.access_token}` })).status).toBe(401);
  });

  it("revokes every grant when the project API key is regenerated", async () => {
    const { provider } = await grantWithKey(engine, otherKey);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${provider.toks!.access_token}` })).status).toBe(200);
    const regenerated = await engine.json("/api/v1/agent-monitoring/settings/api-key/regenerate", { method: "POST", apiKey: otherKey });
    expect(regenerated.status).toBe(200);
    const newKey = (regenerated.body as { apiKey: string }).apiKey;
    expect((await rawToolsList(engine, { Authorization: `Bearer ${provider.toks!.access_token}` })).status).toBe(401);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${newKey}` })).status).toBe(200);
    const grants = await engine.json("/api/v1/mcp/grants", { apiKey: newKey });
    expect((grants.body as { grants: unknown[] }).grants).toEqual([]);
    otherKey = newKey;
  });

  it("refuses to register a client with a redirect outside the allow-list", async () => {
    const res = await fetch(`${originOf(engine)}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example.com/cb"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_client_metadata");
    expect(body.error_description).toContain("evil.example.com");

    const claude = await fetch(`${originOf(engine)}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
    });
    expect(claude.status).toBe(201);
    await claude.text();
  });

  it("only links an http(s) client_uri on the consent page", async () => {
    // The SDK's registration schema already refuses javascript: and data: URIs; anything else
    // with a scheme that is not http(s) is stored but must not become an anchor.
    const res = await fetch(`${originOf(engine)}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Sneaky",
        client_uri: "file:///etc/passwd",
        redirect_uris: ["http://localhost:4444/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    const url = new URL(`${originOf(engine)}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:4444/cb",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString();
    const page = await fetch(url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Sneaky");
    expect(html).not.toContain("file:");
    expect(html).not.toContain("<a href");
  });

  it("binds the grant to this server's resource identifier", async () => {
    const { provider } = await beginOAuth(engine);
    const url = new URL(provider.authorizationUrl!);
    url.searchParams.set("resource", "https://some-other-server.example.com/mcp");
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    await res.text();
  });
});

describe("MCP OAuth, AGENTX_AUTH=enabled", () => {
  let engine: TestEngine;
  let ownerCookie = "";
  let strangerCookie = "";
  let defaultProject: { _id: string; apiKey: string };
  let secondProject: { _id: string; apiKey: string };

  function cookieHeader(res: Response): string {
    return (res.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
  }

  beforeAll(async () => {
    engine = await startEngine({ AGENTX_AUTH: "enabled" });
    const owner = await engine.request("/api/v1/auth/sign-up/email", { ...postJson({ email: "owner@example.com", password: "correct-horse-battery", name: "Owner" }), apiKey: null });
    expect(owner.status).toBeLessThan(300);
    ownerCookie = cookieHeader(owner);
    await owner.text();
    const stranger = await engine.request("/api/v1/auth/sign-up/email", { ...postJson({ email: "stranger@example.com", password: "correct-horse-battery", name: "Stranger" }), apiKey: null });
    expect(stranger.status).toBeLessThan(300);
    strangerCookie = cookieHeader(stranger);
    await stranger.text();

    const projects = await engine.json("/api/v1/projects", { apiKey: null, headers: { cookie: ownerCookie } });
    defaultProject = (projects.body as { projects: { _id: string; apiKey: string; name: string }[] }).projects.find(p => p.name === "Default")!;
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "Team project" }), apiKey: null, headers: { cookie: ownerCookie, "content-type": "application/json" } });
    expect(created.status).toBe(201);
    secondProject = (created.body as { project: { _id: string; apiKey: string } }).project;
    const trace = await engine.json("/api/v1/ingest/traces", { ...postJson({ name: "team-agent", input: "q", output: "a" }), apiKey: secondProject.apiKey });
    expect(trace.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("still takes a bearer project key on /mcp", async () => {
    const client = await keyClient(engine, secondProject.apiKey);
    const whoami = parsed<{ project: { name: string }; organizationId: string | null }>(await client.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.project.name).toBe("Team project");
    expect(whoami.organizationId).toBeTruthy();
    await client.close();
  });

  it("asks for a dashboard sign-in before showing the project picker", async () => {
    const { provider } = await beginOAuth(engine);
    const anonymous = await consentPage(engine, provider.authorizationUrl!);
    expect(anonymous.status).toBe(200);
    expect(anonymous.html).toContain('id="signin"');
    expect(anonymous.html).not.toContain('name="project_id"');
    expect(anonymous.html).not.toContain('name="api_key"');

    const signedIn = await consentPage(engine, provider.authorizationUrl!, ownerCookie);
    expect(signedIn.status).toBe(200);
    expect(signedIn.html).toContain("owner@example.com");
    expect(signedIn.html).toContain(`value="${secondProject._id}"`);
    expect(signedIn.html).toContain(`value="${defaultProject._id}"`);

    // A valid signed form replayed without the session behind it approves nothing.
    const blind = await decide(engine, signedIn.form, { action: "approve", project_id: secondProject._id });
    expect(blind.status).toBe(401);
    expect(blind.location).toBeNull();
  });

  it("grants the picked project to the signed-in member and scopes the token to it", async () => {
    const { provider, transport } = await beginOAuth(engine);
    const page = await consentPage(engine, provider.authorizationUrl!, ownerCookie);
    const decision = await decide(engine, page.form, { action: "approve", project_id: secondProject._id }, ownerCookie);
    expect(decision.status, decision.body).toBe(302);
    const code = new URL(decision.location!).searchParams.get("code")!;
    await transport.finishAuth(code);

    const client = new Client({ name: "mcp-test-oauth", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl(engine), { authProvider: provider }));
    const whoami = parsed<{ project: { name: string }; authenticatedWith: string; organizationId: string | null }>(await client.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.project.name).toBe("Team project");
    expect(whoami.authenticatedWith).toBe("OAuth access token");
    expect(whoami.organizationId).toBeTruthy();
    const traces = parsed<{ traces: { name: string }[] }>(await client.callTool({ name: "agentx_list_traces", arguments: {} }));
    expect(traces.traces.map(t => t.name)).toEqual(["team-agent"]);
    await client.close();

    // The grant is visible to the project's key holder and records who approved it.
    const grants = await engine.json("/api/v1/mcp/grants", { apiKey: secondProject.apiKey });
    const mine = (grants.body as { grants: { clientId: string; userId: string | null }[] }).grants.find(g => g.clientId === provider.info!.client_id);
    expect(mine?.userId).toBeTruthy();
  });

  it("refuses a signed-in user who is not a member of the project's organization", async () => {
    const { provider } = await beginOAuth(engine);
    const page = await consentPage(engine, provider.authorizationUrl!, strangerCookie);
    expect(page.html).toContain("no projects to grant");
    const decision = await decide(engine, page.form, { action: "approve", project_id: secondProject._id }, strangerCookie);
    expect(decision.status).toBe(403);
    expect(decision.location).toBeNull();
  });

  it("cuts a member's grant off when they are removed from the organization", async () => {
    const orgs = await engine.json("/api/v1/auth-org/organizations", { apiKey: null, headers: { cookie: ownerCookie } });
    const orgId = (orgs.body as { organizations: { _id: string }[] }).organizations[0]!._id;
    const invited = await engine.json(`/api/v1/auth-org/organizations/${orgId}/invitations`, {
      ...postJson({ email: "stranger@example.com", role: "member" }),
      apiKey: null,
      headers: { cookie: ownerCookie, "content-type": "application/json" },
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const invitationId = (invited.body as { invitation: { _id: string } }).invitation._id;
    const accepted = await engine.json(`/api/v1/auth-org/invitations/${invitationId}/accept`, { method: "POST", apiKey: null, headers: { cookie: strangerCookie } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // Now a member: the grant goes through and the token works.
    const { provider, transport } = await beginOAuth(engine);
    const page = await consentPage(engine, provider.authorizationUrl!, strangerCookie);
    const decision = await decide(engine, page.form, { action: "approve", project_id: secondProject._id }, strangerCookie);
    expect(decision.status, decision.body).toBe(302);
    await transport.finishAuth(new URL(decision.location!).searchParams.get("code")!);
    const client = new Client({ name: "mcp-test-oauth", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl(engine), { authProvider: provider }));
    await client.close();
    const access = provider.toks!.access_token;
    expect((await rawToolsList(engine, { Authorization: `Bearer ${access}` })).status).toBe(200);

    // Removed from the org: the still-unexpired access token and the refresh chain both die on
    // their next use, not at the 30-day mark.
    const members = await engine.json(`/api/v1/auth-org/organizations/${orgId}/members`, { apiKey: null, headers: { cookie: ownerCookie } });
    const membership = (members.body as { members: { _id: string; email: string }[] }).members.find(m => m.email === "stranger@example.com");
    expect(membership).toBeDefined();
    const removed = await engine.request(`/api/v1/auth-org/organizations/${orgId}/members/${membership!._id}`, { method: "DELETE", apiKey: null, headers: { cookie: ownerCookie } });
    expect(removed.status).toBe(200);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${access}` })).status).toBe(401);
    const refresh = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: provider.toks!.refresh_token!, client_id: provider.info!.client_id });
    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe("invalid_grant");
    const grants = await engine.json("/api/v1/mcp/grants", { apiKey: secondProject.apiKey });
    expect((grants.body as { grants: { clientId: string }[] }).grants.some(g => g.clientId === provider.info!.client_id)).toBe(false);
  });
});

// The three mcp_oauth_* tables have a hand-written Postgres DDL twin (storage/db.ts); this
// exercises every column of it through the same flow, not just CREATE TABLE. Opt-in like every
// Postgres suite (AGENTX_TEST_DB_URL).
describe.skipIf(!postgresAvailable)("MCP on Postgres", () => {
  let engine: TestEngine;

  beforeAll(async () => {
    engine = await startEngine({}, { postgres: true });
    const res = await engine.json("/api/v1/ingest/traces", postJson({ name: "pg-agent", input: "q", output: "a" }));
    expect(res.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("runs the key path and the whole OAuth grant lifecycle on Postgres", async () => {
    const keyed = await keyClient(engine, engine.apiKey);
    const traces = parsed<{ traces: { name: string }[] }>(await keyed.callTool({ name: "agentx_list_traces", arguments: {} }));
    expect(traces.traces.map(t => t.name)).toContain("pg-agent");
    await keyed.close();

    const { provider, client, code } = await grantWithKey(engine, engine.apiKey);
    const whoami = parsed<{ authenticatedWith: string }>(await client.callTool({ name: "agentx_whoami", arguments: {} }));
    expect(whoami.authenticatedWith).toBe("OAuth access token");
    await client.close();

    const replay = await tokenRequest(engine, { grant_type: "authorization_code", code, code_verifier: provider.verifier, client_id: provider.info!.client_id, redirect_uri: provider.redirectUrl });
    expect(replay.status).toBe(400);

    const refreshed = await tokenRequest(engine, { grant_type: "refresh_token", refresh_token: provider.toks!.refresh_token!, client_id: provider.info!.client_id });
    expect(refreshed.status).toBe(200);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${provider.toks!.access_token}` })).status).toBe(401);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${refreshed.body.access_token as string}` })).status).toBe(200);

    const grants = await engine.json("/api/v1/mcp/grants");
    expect(mcpGrantsResponseSchema.safeParse(grants.body).success).toBe(true);
    const grant = (grants.body as { grants: { grantId: string; clientName: string }[] }).grants[0]!;
    expect(grant.clientName).toBe("Test connector");
    expect((await engine.request(`/api/v1/mcp/grants/${grant.grantId}`, { method: "DELETE" })).status).toBe(204);
    expect((await rawToolsList(engine, { Authorization: `Bearer ${refreshed.body.access_token as string}` })).status).toBe(401);
  });
});
