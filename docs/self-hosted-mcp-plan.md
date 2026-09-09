# Self-host MCP server: plan

**Status:** Phases 1 and 2 are implemented; Phase 3 is still design.

| Shipped | Where |
|---|---|
| `POST /mcp` (stateless Streamable HTTP), key + OAuth bearer auth, 405 on other verbs | `engine/src/routes/mcp.ts` |
| Nineteen read-only `agentx_*` tools, audited per call | `engine/src/core/mcp/tools.ts`, `server.ts` |
| OAuth 2.1 authorization server: DCR allow-list, consent page in both auth modes, PKCE, hashed tokens, refresh rotation, revocation, audience binding | `engine/src/core/mcp/oauthProvider.ts`, `oauthStore.ts`, `authorizePage.ts`, `config.ts` |
| Tables in both dialects | `engine/src/storage/schema.{sqlite,pg}.ts`, `db.ts` |
| Grants list/revoke (`/api/v1/mcp/grants`, under wire contract) and key-regeneration cascade | `engine/src/routes/mcp.ts`, `apiV1.ts`, `agentMonitoringDashboard.ts` |
| Tests: SDK client end to end, both auth modes, failure paths | `engine/src/test/mcp.integration.test.ts` |
| README section, configuration rows | `README.md` |

**Three things changed during implementation.**

1. **Only one scope exists.** `mcp:write` was dropped from the consent page until a write tool
   ships - a checkbox that gates nothing is the placebo knob CONTRIBUTING.md bans. §2.3 and §2.4
   below still describe the two-scope end state.
2. **The issuer defaults to loopback.** With no `AGENTX_PUBLIC_URL`, the issuer is
   `http://localhost:<port>` rather than "OAuth off": the spec allows plain HTTP on loopback, so
   Claude Code can run the real OAuth flow against a local engine, and the integration tests
   exercise the exact code path claude.ai will. A non-loopback `http://` public URL still
   disables OAuth with a boot warning.
3. **Consent requests are signed, not stored.** The authorize page carries the request back as
   HMAC-signed hidden fields (keyed by the persisted instance secret), so multi-replica
   deployments need no pending-request table and a tampered form fails before any principal check.

**Verified on both dialects**: the suite's opt-in Postgres describe ran against a local
Postgres 16 alongside the SQLite run. **Still unverified:** a real claude.ai connector through a
tunnel (the SDK's own OAuth client is the closest offline stand-in and passes).

### Localhost

"Localhost MCP" means different things per surface, and only the last row needs Phase 2:

| Surface | How it reaches a local engine | Needs |
|---|---|---|
| Claude Code | `claude mcp add --transport http agentx http://localhost:4700/mcp --header "Authorization: Bearer <key>"` (or `/mcp` login via the loopback OAuth issuer) | Phase 1 |
| Claude Desktop, Cursor, other stdio-only hosts | `npx mcp-remote http://localhost:4700/mcp --header "Authorization: Bearer <key>"` in the host's MCP config; an `agentx mcp` stdio proxy in the Go CLI would remove the Node dependency (Phase 3) | Phase 1 |
| Agent SDK, scripts, CI | Any HTTP MCP client with the header | Phase 1 |
| claude.ai web / mobile, Messages API connector | Cannot reach localhost at all - Anthropic's servers open the connection. Expose the engine (cloudflared, ngrok, Tailscale Funnel), set `AGENTX_PUBLIC_URL` to that HTTPS URL, connect | Phase 2 |

**Goal:** a Claude user adds `https://<their-self-host>/mcp` as a custom connector in claude.ai
(or `claude mcp add` in Claude Code) and Claude can read traces, sessions, signals, datasets,
evaluations, prompts and insights from their own instance - the same experience as the hosted
AgentX MCP, against data that never leaves their box.

## 1. The authorization problem, stated precisely

The hosted AgentX MCP has an account system behind it. Self-host, by default, has none:
`AGENTX_AUTH=disabled` means "reachable port = trusted", `/api/v1/auth/config` hands the default
project's API key to anyone who asks, and every data-plane route is keyed by that project API
key (`x-api-key`, resolved in `engine/src/auth/apiKey.ts`).

Three facts decide the design:

1. **A claude.ai connector needs a public HTTPS URL.** claude.ai's servers fetch the MCP endpoint,
   not the user's browser, so `localhost` never works and the endpoint is reachable from the
   whole internet. An authless `/mcp` on a public host hands every trace and prompt on the
   instance to anyone who guesses the URL. So the MCP endpoint can never be authless when it is
   reachable by claude.ai, regardless of what the rest of the engine does.
2. **claude.ai custom connectors authenticate with OAuth 2.1**, discovering the authorization
   server through RFC 9728 protected-resource metadata and registering themselves with Dynamic
   Client Registration (RFC 7591). Their callback is `https://claude.ai/api/mcp/auth_callback`.
   A client ID/secret can be typed in under Advanced settings when a server does not offer DCR.
   Static header credentials are reported as a beta option and are not something to build on.
   Claude Code, the Agent SDK and the Messages API MCP connector *do* accept a static bearer
   header (`--header "Authorization: Bearer ..."` / `authorization_token`).
3. **The engine already has the only identity that matters: the project.** Every core function
   is scoped with `withProjectId(getDb(), projectId)` inside `runWithTenancy(...)`. Whatever the
   MCP accepts as a credential must resolve to a `projectId` (plus `organizationId`), exactly as
   `requireApiKey()` does today.

**Decision:** do not make the MCP authless, and do not invent a second identity system. Make the
engine itself a small OAuth 2.1 authorization server whose access tokens are short-lived,
audience-bound stand-ins for a project API key. What the user does on the authorize page depends
on the auth mode the instance already runs in:

| Instance mode | What "log in" means on the authorize page | Who this is for |
|---|---|---|
| `AGENTX_AUTH=enabled` (recommended for anything public) | Existing dashboard sign-in (better-auth cookie), then pick the project(s) to grant and confirm scopes | Team servers, anything on a real domain |
| `AGENTX_AUTH=disabled` | Paste a project API key; the key is verified and the token is minted for that project | Local instances exposed through a tunnel (cloudflared/ngrok) for a personal claude.ai connector |

The disabled-mode path adds no protection beyond what the README already documents for that
mode (anyone who reaches the port gets the key), but it also removes none, and it keeps the
zero-setup posture for people who just want to point claude.ai at their laptop through a tunnel.
The docs must say plainly: a self-host that is reachable from the internet should run
`AGENTX_AUTH=enabled`, and the connector is one more reason to.

Alongside OAuth, the MCP endpoint accepts `Authorization: Bearer <project API key>` (and
`x-api-key`) directly. That is the Claude Code / Agent SDK / CI path, it costs nothing, and it
ships first.

### Rejected

- **Authless `/mcp`, even behind a flag.** Public URL is a requirement of the consumer; see fact 1.
- **`@better-auth/mcp` / `@better-auth/oauth-provider` as the authorization server.** better-auth
  1.7 moved these to separate packages that peer on `better-auth ^1.7.3` (the repo pins 1.7.1),
  add five OAuth tables through their own schema generator, need the `jwt` plugin, and
  `@better-auth/mcp` documents itself as accepting only the MCP `2026-07-28` protocol version,
  which is not something we can guarantee claude.ai's client sends. Most decisively: better-auth
  is only initialized in enabled mode, so this could never serve the disabled-mode tunnel case.
  Revisit if the hand-rolled provider grows past a few hundred lines.
- **Delegating to the customer's own IdP (OIDC) as the authorization server.** The IdP does not
  know what a project is, so a token from it still needs a project-selection step inside the
  engine. Keep as an optional Phase 3 using the SDK's `ProxyOAuthServerProvider`, not as the base.
- **A separate MCP process/port.** One binary, one port, one `AGENTX_PUBLIC_URL` is the whole
  self-host promise; the transport is a route.

## 2. Architecture

Everything lives in the engine, on the existing port, built on `@modelcontextprotocol/sdk`
(already a dependency at 1.30.0, the current release - the engine uses its *client* side in
`core/evaluate/mcp.ts` for the Register Tool flow; this adds the *server* side).

```
claude.ai / Claude Code
   │  POST /mcp  (Streamable HTTP, stateless)         Authorization: Bearer <token|project key>
   ▼
requireMcpAuth  ──►  token store / projects table  ──►  req.projectId, runWithTenancy(...)
   │
   ▼
McpServer (tools) ──► core/* functions with withProjectId(getDb(), projectId)   (no HTTP self-calls)

OAuth 2.1 authorization server (SDK mcpAuthRouter + engine OAuthServerProvider):
  GET  /.well-known/oauth-protected-resource/mcp    (RFC 9728, points at issuer = AGENTX_PUBLIC_URL)
  GET  /.well-known/oauth-authorization-server      (RFC 8414)
  POST /register                                    (DCR, redirect allow-list)
  GET  /authorize                                   (login/consent page, PKCE required)
  POST /token                                       (code + refresh grants, rotation)
  POST /revoke
```

### 2.1 MCP endpoint

- `POST /mcp` with `StreamableHTTPServerTransport` in **stateless** mode (`sessionIdGenerator:
  undefined`): no server-side session table, so multi-replica Postgres/Helm deployments need no
  sticky routing. `GET`/`DELETE /mcp` return 405. Registered before the SPA catch-all in
  `index.ts` (the `^(?!\/api).*` fallback would otherwise swallow it), under `dataPlaneLimit`.
- `requireMcpAuth` middleware, in order: `Authorization: Bearer` that resolves as an MCP access
  token → `Authorization: Bearer` / `x-api-key` that resolves as a project API key → 401 with
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`
  (the SDK's `requireBearerAuth` produces this header; wrap it so the project-key fallback runs
  first). Sets `req.projectId` and enters `runWithTenancy`, so every tool call inherits tenancy
  the same way route handlers do.
- Tool handlers call core functions directly with a scoped `Db`. No loopback HTTP: the audit tap
  (`routes/auditTap.ts`) gets an explicit `mcp.tool_call` event (tool name, project, client id,
  outcome) instead.

### 2.2 Tool surface

Mirror the hosted MCP's naming (`agentx_*`) and argument shapes wherever the same concept exists,
so prompts, skills and docs written for one work against the other. Phase 1 is read-only:

| Area | Tools | Backed by |
|---|---|---|
| Identity | `agentx_whoami` (project, org, mode, engine version) | `projects.ts` |
| Trace | `agentx_list_traces`, `agentx_get_trace`, `agentx_list_sessions`, `agentx_get_session` | `core/trace/*` |
| Monitor | `agentx_get_kpis`, `agentx_list_signals`, `agentx_get_signal`, `agentx_list_agents`, `agentx_list_topics` | `core/monitor/*` |
| Evaluate | `agentx_list_datasets`, `agentx_get_dataset`, `agentx_list_evaluations`, `agentx_get_evaluation`, `agentx_list_prompts`, `agentx_get_prompt`, `agentx_list_tool_schemas` | `core/evaluate/*` |
| Insights | `agentx_get_coverage`, `agentx_probe_coverage` | `core/insights/*` |

Writes come in Phase 3 behind the `mcp:write` scope: add a dataset case from a trace, run an
evaluation, propose (never publish) a prompt improvement. Publish/promote stays human-only, which
is the same rule the dashboard enforces.

Every list tool takes `limit` (default 20, max 100) and returns compact rows; detail tools return
the full record. Input schemas are zod, the same validators the routes use where they exist.

### 2.3 Authorization server

Implement the SDK's `OAuthServerProvider` interface (`clientsStore`, `authorize`,
`challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`,
`verifyAccessToken`, `revokeToken`) and mount it with `mcpAuthRouter({ provider, issuerUrl,
resourceServerUrl: <PUBLIC_URL>/mcp, scopesSupported: ["mcp:read", "mcp:write"] })`. The SDK
handles PKCE verification, DCR request validation, metadata documents and error shapes; the engine
supplies storage and the login/consent step.

**Storage** - three tables, both dialects, created in `storage/db.ts` next to the existing
`CREATE TABLE IF NOT EXISTS` blocks:

| Table | Columns (abridged) | Notes |
|---|---|---|
| `mcp_oauth_clients` | id, client_name, redirect_uris (json), token_endpoint_auth_method, client_secret_hash (nullable), created_at, last_used_at | DCR output; also holds any manually provisioned client |
| `mcp_oauth_codes` | code_hash, client_id, project_id, organization_id, user_id (nullable), scopes, code_challenge, redirect_uri, resource, expires_at | single use, 10 min |
| `mcp_oauth_tokens` | token_hash, kind (access/refresh), client_id, project_id, organization_id, user_id (nullable), scopes, resource, expires_at, revoked_at, parent_refresh_hash | opaque random tokens, sha256 at rest; access 1h, refresh 30d, rotated on use |

Tokens are hashed even though project keys are stored in plaintext today: these are derived,
short-lived credentials and hashing them is free.

**DCR policy** - `/register` is unauthenticated by spec, so constrain it:
- Exact-match redirect URIs against an allow-list: `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, and loopback `http://127.0.0.1:<any port>/…` /
  `http://localhost:<any port>/…` (Claude Code uses a varying port). Extendable with
  `AGENTX_MCP_REDIRECT_ALLOWLIST` for other MCP clients.
- `credentialLimit` on `/register`, `/authorize`, `/token`; clients never used within 30 days are
  pruned by the existing sweep cadence.
- Public clients only (`token_endpoint_auth_method: none`) plus PKCE S256 required - which is
  what claude.ai and Claude Code send.

**Authorize page** - server-rendered HTML from the engine (same approach as the existing
`/api/v1/mcp-oauth/callback` page), no dashboard build needed:
- Enabled mode: `getSessionUser(req)`; no session → redirect to the SPA login with a `redirect`
  back to the full authorize URL; with a session → list the projects of the user's orgs
  (`listProjectsWireForOrgs`), radio-select one, scope checkboxes (read pre-checked, write
  unchecked), Approve. The form posts to `POST /authorize/decision` with a nonce bound to the
  pending request; `X-Frame-Options: DENY`.
- Disabled mode: the same page with a single "project API key" field instead of the project list;
  verified through `resolveProjectByApiKey` (constant-time by construction of the lookup).
- On approve: mint the code, redirect to the validated `redirect_uri` with `code` and `state`.

**Token validation** (`verifyAccessToken`): hash lookup, not revoked, not expired, `resource`
equals the canonical `<PUBLIC_URL>/mcp` (RFC 8707 audience binding, required by the MCP spec),
project still exists. Returns `AuthInfo` with `extra: { projectId, organizationId, userId }`,
which `requireMcpAuth` copies onto the request.

**Preconditions and switches**
- `AGENTX_PUBLIC_URL` must be set and `https://` for the OAuth routes to mount (issuer must be
  HTTPS; the SDK refuses otherwise except for localhost). Without it the `/mcp` endpoint still
  works with a bearer project key and the boot log says why OAuth is off.
- `AGENTX_MCP=disabled` turns the whole surface off. Default on: it exposes nothing a project key
  does not already expose.
- `AGENTX_TRUST_PROXY` matters here as it does everywhere else behind an ingress.

### 2.4 Revocation and visibility

- `POST /revoke` (SDK-mounted) for the client side.
- Session-authenticated engine routes `GET/DELETE /api/v1/mcp/grants` (enabled mode) and
  key-authenticated equivalents under the project (disabled mode) list and revoke grants per
  project. A "Connected apps" card in the dashboard consumes these (front-end repo, Phase 3).
- Regenerating a project API key (`POST /agent-monitoring/settings/api-key/regenerate`) revokes
  every MCP token minted for that project - the token is a stand-in for the key, so it dies with
  it.

## 3. Phases

**Phase 1 - MCP endpoint with bearer project key** (engine only, ~2-3 days)
- `routes/mcp.ts`: `POST /mcp`, stateless Streamable HTTP, `requireMcpAuth` with the project-key
  path only (401 without `WWW-Authenticate` metadata yet).
- `core/mcp/tools/*.ts`: the read tools in §2.2, one file per area, each a thin adapter over an
  existing core function.
- Audit event `mcp.tool_call`; access-log `projectId` already flows.
- Tests: `src/test/mcp.integration.test.ts` drives the SDK `Client` +
  `StreamableHTTPClientTransport` against a booted engine: initialize, `tools/list`, a call per
  area, project isolation (key A cannot see project B), 401 without a key.
- README: "Connect Claude" section with `claude mcp add --transport http agentx
  http://localhost:4700/mcp --header "Authorization: Bearer <key>"`.
- Unblocks: Claude Code, Agent SDK, Messages API `mcp_servers` (+ `authorization_token`), CI.

**Phase 2 - OAuth 2.1 authorization server** (engine only, ~3-5 days)
- Tables (§2.3, both dialects), `core/mcp/oauthProvider.ts`, `mcpAuthRouter` mount, protected
  resource metadata, `WWW-Authenticate` on 401, DCR allow-list, authorize page in both modes,
  refresh rotation, revoke, key-regeneration cascade.
- Tests: full flow through the SDK client's `OAuthClientProvider` (the same interface
  `core/evaluate/mcp.ts` implements for the outbound case): DCR → authorize (test session or
  pasted key) → token → tool call; then audience mismatch, expired, revoked, replayed code, bad
  redirect URI, PKCE mismatch all 4xx. Both `AGENTX_AUTH` modes.
- Manual verification: cloudflared tunnel to a dev engine, add the connector in claude.ai, run
  a conversation that lists traces. Same against Claude Code's `/mcp` login.
- Docs: configuration table rows (`AGENTX_MCP`, `AGENTX_MCP_REDIRECT_ALLOWLIST`), a "Connecting
  claude.ai to a self-host" walkthrough for both modes with the enabled-mode recommendation
  stated up front, runbook entry for "connector says unauthorized".

**Phase 3 - polish and reach** (engine + dashboard, ongoing)
- Write tools behind `mcp:write` (§2.2); "Connected apps" card in the dashboard; Helm values for
  `AGENTX_PUBLIC_URL`.
- Optional external IdP as authorization server via `ProxyOAuthServerProvider` for enterprises
  that already run OIDC (`AGENTX_OIDC_*`), keeping the engine's project-selection step.
- Share tool definitions with the hosted MCP (a `packages/agentx-mcp-tools` workspace) once both
  sides have stabilized, so the two servers cannot drift apart.

## 4. Security checklist (carried into the implementation PR)

- [ ] `/mcp` never answers without a credential that resolves to a project.
- [ ] Tokens: opaque, hashed at rest, 1h access / 30d refresh, refresh rotation, revocation.
- [ ] Audience: `resource` checked on every token; no token passthrough anywhere.
- [ ] Redirect URIs: exact match, allow-listed; codes single-use with a 10-minute TTL.
- [ ] PKCE S256 required (SDK enforces); `state` echoed untouched.
- [ ] Authorize page: session or key proof, nonce-bound decision POST, `X-Frame-Options: DENY`,
      no autosubmit.
- [ ] `/register`, `/authorize`, `/token` under `credentialLimit`; `/mcp` under `dataPlaneLimit`.
- [ ] Project key regeneration revokes derived tokens.
- [ ] Every tool call audited with client id and project.
- [ ] Docs state the public-URL-implies-enabled-mode recommendation explicitly.

## 5. Open questions

1. **claude.ai's DCR expectations.** Reports exist of connectors that register fine and then
   fail at the callback; the Phase 2 manual tunnel test is the gate, and the SDK's router is the
   most-tested implementation available to us. If claude.ai turns out to need something the
   router does not emit, the fix is in `oauthProvider.ts`, not a redesign.
2. **One project per token, or several?** Start with one (matches the key model, keeps every
   tool call unambiguous). Multi-project grants would need a `project` argument on every tool.
3. **Authorize page ownership.** Engine-rendered HTML ships without a dashboard release; if the
   team prefers the SPA look, the decision POST is the same and only the page moves.
4. **Should Phase 1 also accept the project key on claude.ai's header-credential option?** It
   does automatically (same bearer path); whether to document it depends on that option leaving
   beta.
