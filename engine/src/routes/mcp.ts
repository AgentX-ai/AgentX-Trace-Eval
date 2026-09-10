import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { asyncHandler, asyncRouter } from "./asyncRouter.js";
import { getDb, withProjectId } from "../storage/db.js";
import { currentTenancy, runWithTenancy } from "../auth/requestContext.js";
import { resolveProjectByApiKey } from "../core/project/projects.js";
import { logger } from "../log.js";
import {
  MCP_PATH,
  MCP_READ_SCOPE,
  MCP_SCOPES_SUPPORTED,
  mcpEnabled,
  mcpIssuerUrl,
  mcpOauthAvailable,
  mcpResourceUrl,
} from "../core/mcp/config.js";
import { EngineOAuthProvider } from "../core/mcp/oauthProvider.js";
import { createMcpServer } from "../core/mcp/server.js";
import type { McpPrincipal } from "../core/mcp/tools.js";
import { listGrants, revokeGrant } from "../core/mcp/oauthStore.js";
import { validateBody } from "./validateBody.js";
import { rateLimitDisabled } from "../auth/rateLimit.js";

// The consent form's fields: the signed request bundle (core/mcp/oauthProvider.ts verifies the
// signature and expiry, which is the real gate) plus the user's decision and, per auth mode,
// the credential proving who is deciding. Shape here, meaning in the provider.
const decisionBodySchema = z
  .object({
    action: z.enum(["approve", "deny"]),
    client_id: z.string().min(1),
    redirect_uri: z.string().url(),
    code_challenge: z.string().min(1),
    state: z.string().default(""),
    scope: z.string().default(""),
    resource: z.string().default(""),
    exp: z.string().regex(/^\d+$/),
    sig: z.string().regex(/^[a-f0-9]{64}$/),
    api_key: z.string().optional(),
    project_id: z.string().optional(),
  })
  .strip();

// The transport validates every JSON-RPC message in full; this only refuses bodies that are not
// JSON-RPC at all before a server is built for them.
const jsonRpcMessageSchema = z.object({ jsonrpc: z.literal("2.0") }).passthrough();
const mcpBodySchema = z.union([jsonRpcMessageSchema, z.array(jsonRpcMessageSchema).min(1)]);

// The MCP surface: POST /mcp (Streamable HTTP) plus, when the issuer allows it, the OAuth 2.1
// authorization server that lets claude.ai connect without a project API key ever leaving the
// box. See docs/self-hosted-mcp-plan.md for the design and core/mcp/oauthProvider.ts for the
// grant model. Mounted at the application ROOT, not under /api/v1: the resource identifier
// clients bind tokens to is <public URL>/mcp, and RFC 8414/9728 metadata documents live at
// /.well-known/* on the origin.

declare global {
  namespace Express {
    interface Request {
      mcpPrincipal?: McpPrincipal;
    }
  }
}

export type McpDeps = {
  credentialLimit: RequestHandler;
  dataPlaneLimit: RequestHandler;
  port: number;
};

// Credential resolution for /mcp, in order: a project API key (x-api-key, or a bearer that is
// not one of our OAuth tokens - Claude Code's `--header` path, the Agent SDK, CI), then an OAuth
// access token through the SDK's bearer middleware so the 401 carries the WWW-Authenticate
// resource_metadata hint that starts a client's OAuth discovery. Either way the request ends up
// with req.projectId and the AsyncLocalStorage tenancy every core function reads.
function requireMcpAuth(provider: EngineOAuthProvider | null, resourceMetadataUrl: string | null) {
  const bearer = provider
    ? requireBearerAuth({ verifier: provider, requiredScopes: [MCP_READ_SCOPE], resourceMetadataUrl: resourceMetadataUrl ?? undefined })
    : null;
  const unauthorized = (res: Response, description: string) => {
    const hint = resourceMetadataUrl ? `, resource_metadata="${resourceMetadataUrl}"` : "";
    res.set("WWW-Authenticate", `Bearer error="invalid_token", error_description="${description}"${hint}`);
    res.status(401).json({ error: "invalid_token", error_description: description });
  };
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const [scheme, bearerValue] = header.split(" ");
    const bearerToken = scheme?.toLowerCase() === "bearer" && bearerValue ? bearerValue.trim() : "";
    const isOauthToken = bearerToken.startsWith("agtx_mcp_");
    const candidateKey = req.header("x-api-key") || (!isOauthToken ? bearerToken : "");

    if (candidateKey) {
      const project = await resolveProjectByApiKey(getDb(), candidateKey);
      if (!project) {
        unauthorized(res, "Invalid project API key");
        return;
      }
      req.projectId = project.id;
      req.mcpPrincipal = { kind: "project-key" };
      runWithTenancy({ projectId: project.id, organizationId: project.organizationId ?? null }, () => next());
      return;
    }
    if (!bearer) {
      unauthorized(res, "Provide a project API key as a bearer token or x-api-key header");
      return;
    }
    bearer(req, res, err => {
      if (err) {
        next(err);
        return;
      }
      const extra = (req.auth?.extra ?? {}) as { projectId?: string; organizationId?: string | null; userId?: string | null; grantId?: string };
      if (!extra.projectId) {
        unauthorized(res, "Token carries no project");
        return;
      }
      req.projectId = extra.projectId;
      req.mcpPrincipal = {
        kind: "oauth",
        clientId: req.auth?.clientId ?? "",
        userId: extra.userId ?? null,
        grantId: extra.grantId ?? "",
      };
      runWithTenancy({ projectId: extra.projectId, organizationId: extra.organizationId ?? null }, () => next());
    });
  };
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const projectId = req.projectId!;
  const server = createMcpServer({
    db: withProjectId(getDb(), projectId),
    projectId,
    // Set by requireMcpAuth for both credential kinds (the project row's org for a key, the
    // grant's org for a token).
    organizationId: currentTenancy().organizationId ?? null,
    principal: req.mcpPrincipal ?? { kind: "project-key" },
    ip: req.ip ?? null,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  // express.json already consumed the body (index.ts mounts it globally); hand the parsed
  // object over rather than letting the transport read an empty stream.
  await transport.handleRequest(req, res, req.body);
}

export function registerMcp(app: Express, deps: McpDeps): void {
  if (!mcpEnabled()) {
    logger.info("MCP endpoint disabled (AGENTX_MCP=disabled).");
    return;
  }
  const issuer = mcpIssuerUrl(deps.port);
  const resource = mcpResourceUrl(issuer);
  const oauth = mcpOauthAvailable(issuer);
  const provider = oauth ? new EngineOAuthProvider(resource, issuer.href) : null;
  const resourceMetadataUrl = oauth ? getOAuthProtectedResourceMetadataUrl(resource) : null;

  if (provider) {
    // The consent decision verifies a session or a project API key per submission, so it gets a
    // ceiling of its own on top of the shared credential limiter - built here with
    // express-rate-limit directly (the same shape as apiV1.ts's projectMutationLimit) so the
    // guard is visible at the route, not hidden behind an injected handler. 60 decisions per 15
    // minutes per IP is far above any human consent flow and well below a key-guessing loop.
    // Honours the same AGENTX_RATE_LIMIT=off switch as every other limiter.
    const consentLimit = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip: () => rateLimitDisabled(),
      handler: (_req, res) => {
        res.status(429).json({ statusCode: 429, message: "Too many requests" });
      },
    });
    // Consent form submission - registered BEFORE the SDK router so `/authorize/decision` never
    // reaches the SDK's `/authorize` prefix handler. The engine's own credential limiter guards
    // the SDK endpoints; the SDK's built-in per-endpoint limiters are disabled so the two ceilings
    // do not stack into surprising 429s.
    app.post(
      "/authorize/decision",
      deps.credentialLimit,
      consentLimit,
      express.urlencoded({ extended: false }),
      validateBody(decisionBodySchema),
      asyncHandler(async (req: Request, res: Response) => {
        await provider.decision(req, res);
      })
    );
    for (const path of ["/authorize", "/token", "/register", "/revoke"]) {
      app.use(path, deps.credentialLimit);
    }
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: issuer,
        resourceServerUrl: resource,
        scopesSupported: [...MCP_SCOPES_SUPPORTED],
        resourceName: "AgentX Trace & Eval (self-hosted)",
        authorizationOptions: { rateLimit: false },
        tokenOptions: { rateLimit: false },
        revocationOptions: { rateLimit: false },
        // A connector should not stop working because a registration secret aged out; the
        // refresh token's own 30-day lifetime already bounds an idle grant.
        clientRegistrationOptions: { rateLimit: false, clientSecretExpirySeconds: 0 },
      })
    );
  }

  app.post(
    "/mcp",
    deps.dataPlaneLimit,
    asyncHandler(requireMcpAuth(provider, resourceMetadataUrl)),
    validateBody(mcpBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      await handleMcpPost(req, res);
    })
  );
  // Stateless transport: no server-initiated stream to GET, no session to DELETE.
  app.all(MCP_PATH, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. POST JSON-RPC to this endpoint." }, id: null });
  });

  logger.info(`MCP endpoint: ${resource.href} (bearer project API key${oauth ? ", or OAuth via " + issuer.href : ""})`);
  if (!oauth) {
    logger.warn(
      `MCP OAuth is off: the issuer ${issuer.href} is neither HTTPS nor loopback. Set AGENTX_PUBLIC_URL to an https:// URL to let claude.ai connect; project-key bearer access still works.`
    );
  }
}

// Key-authenticated view of the OAuth grants on the caller's project (the dashboard's
// "connected apps"), mounted under /api/v1/mcp by apiV1.ts. Revoking a grant kills its refresh
// chain and every access token minted from it.
export const mcpGrantsRouter = asyncRouter();

mcpGrantsRouter.get("/grants", async (req: Request, res: Response) => {
  const grants = await listGrants(getDb(), req.projectId!);
  res.status(200).json({
    grants: grants.map(grant => ({
      grantId: grant.grantId,
      clientId: grant.clientId,
      clientName: grant.clientName,
      userId: grant.userId,
      scopes: grant.scopes,
      createdAt: grant.createdAt.toISOString(),
      lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
      expiresAt: grant.expiresAt.toISOString(),
    })),
  });
});

mcpGrantsRouter.delete("/grants/:grantId", async (req: Request, res: Response) => {
  const grants = await listGrants(getDb(), req.projectId!);
  const target = grants.find(grant => grant.grantId === req.params.grantId);
  if (!target) {
    res.status(404).json({ error: "Grant not found" });
    return;
  }
  await revokeGrant(getDb(), target.grantId);
  res.status(204).end();
});
