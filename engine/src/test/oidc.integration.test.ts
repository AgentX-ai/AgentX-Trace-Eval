import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// P2.3 generic OIDC SSO: the env trio (AGENTX_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET) must light
// up an "oidc" provider end-to-end against a stub issuer: /auth/config advertises it (with the
// AGENTX_OIDC_NAME button label), the engine performs real OIDC discovery against the issuer
// (better-auth >= 1.7 does this once at boot, when the generic provider registers), and
// POST /auth/sign-in/social returns an authorization URL pointing at it. The full round trip
// (IdP login -> callback -> session) is verified against a real IdP per release, per the plan;
// what CI pins is that the engine's half of the handshake is genuinely wired, not advertised.

let issuer: http.Server;
let issuerUrl: string;
let discoveryHits = 0;

beforeAll(async () => {
  issuer = http.createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/openid-configuration")) {
      discoveryHits += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: issuerUrl,
          authorization_endpoint: `${issuerUrl}/authorize`,
          token_endpoint: `${issuerUrl}/token`,
          userinfo_endpoint: `${issuerUrl}/userinfo`,
          jwks_uri: `${issuerUrl}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>(resolve => issuer.listen(0, "127.0.0.1", resolve));
  const address = issuer.address();
  issuerUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>(resolve => issuer.close(() => resolve()));
});

describe("with the env trio set", () => {
  let engine: TestEngine;

  beforeAll(async () => {
    engine = await startEngine({
      AGENTX_AUTH: "enabled",
      AGENTX_OIDC_ISSUER: issuerUrl,
      AGENTX_OIDC_CLIENT_ID: "agentx-test-client",
      AGENTX_OIDC_CLIENT_SECRET: "agentx-test-secret",
      AGENTX_OIDC_NAME: "Okta",
    });
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("advertises the oidc provider and its label on /auth/config", async () => {
    const res = await engine.json("/api/v1/auth/config", { apiKey: null });
    expect(res.status).toBe(200);
    const body = res.body as { socialProviders: string[]; ssoLabel: string };
    expect(body.socialProviders).toContain("oidc");
    expect(body.ssoLabel).toBe("Okta");
  });

  it("performs discovery against the issuer and returns its authorization URL", async () => {
    const res = await engine.json("/api/v1/auth/sign-in/social", {
      ...postJson({ provider: "oidc", callbackURL: "http://localhost:3000" }),
      apiKey: null,
    });
    expect(res.status).toBe(200);
    const body = res.body as { url: string };
    expect(body.url).toContain(`${issuerUrl}/authorize`);
    expect(body.url).toContain("client_id=agentx-test-client");
    expect(body.url).toContain("scope=");
    expect(discoveryHits).toBeGreaterThanOrEqual(1);
  });
});

describe("without the env trio", () => {
  it("advertises nothing and the social sign-in route rejects the unknown provider", async () => {
    const engine = await startEngine({ AGENTX_AUTH: "enabled" });
    try {
      const cfg = await engine.json("/api/v1/auth/config", { apiKey: null });
      const body = cfg.body as { socialProviders: string[]; ssoLabel?: string };
      expect(body.socialProviders).not.toContain("oidc");
      expect(body.ssoLabel).toBeUndefined();

      const res = await engine.json("/api/v1/auth/sign-in/social", {
        ...postJson({ provider: "oidc", callbackURL: "http://localhost:3000" }),
        apiKey: null,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await engine.stop();
    }
  }, 90_000);
});
