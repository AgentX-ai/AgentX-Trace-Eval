import { afterEach, describe, expect, it } from "vitest";
import { mcpIssuerUrl, mcpOauthAvailable, redirectUriAllowed, resourceMatches } from "../core/mcp/config.js";

// The env-driven decisions in core/mcp/config.ts, pinned because two of them gate whether the
// OAuth router mounts at all and which redirect URIs an unauthenticated /register may claim.

describe("MCP config", () => {
  const saved = { publicUrl: process.env.AGENTX_PUBLIC_URL, allowlist: process.env.AGENTX_MCP_REDIRECT_ALLOWLIST };
  afterEach(() => {
    if (saved.publicUrl === undefined) delete process.env.AGENTX_PUBLIC_URL;
    else process.env.AGENTX_PUBLIC_URL = saved.publicUrl;
    if (saved.allowlist === undefined) delete process.env.AGENTX_MCP_REDIRECT_ALLOWLIST;
    else process.env.AGENTX_MCP_REDIRECT_ALLOWLIST = saved.allowlist;
  });

  it("offers OAuth exactly where the SDK's issuer check would accept it", () => {
    expect(mcpOauthAvailable(new URL("https://agentx.example.com/"))).toBe(true);
    expect(mcpOauthAvailable(new URL("http://localhost:3000/"))).toBe(true);
    expect(mcpOauthAvailable(new URL("http://127.0.0.1:3000/"))).toBe(true);
    // The SDK's checkIssuerUrl does not exempt IPv6 loopback; accepting it here would crash boot.
    expect(mcpOauthAvailable(new URL("http://[::1]:3000/"))).toBe(false);
    expect(mcpOauthAvailable(new URL("http://agentx.internal:3000/"))).toBe(false);
  });

  it("derives the issuer from AGENTX_PUBLIC_URL's origin, else loopback on the port", () => {
    delete process.env.AGENTX_PUBLIC_URL;
    expect(mcpIssuerUrl(4321).href).toBe("http://localhost:4321/");
    process.env.AGENTX_PUBLIC_URL = "https://agentx.example.com/some/path?x=1";
    expect(mcpIssuerUrl(4321).href).toBe("https://agentx.example.com/");
  });

  it("matches the resource identifier on origin and path only", () => {
    const canonical = new URL("https://agentx.example.com/mcp");
    expect(resourceMatches("https://agentx.example.com/mcp/", canonical)).toBe(true);
    expect(resourceMatches("HTTPS://AGENTX.EXAMPLE.COM/mcp", canonical)).toBe(true);
    expect(resourceMatches(null, canonical)).toBe(true);
    expect(resourceMatches("https://agentx.example.com/mcp?x=1", canonical)).toBe(false);
    expect(resourceMatches("https://other.example.com/mcp", canonical)).toBe(false);
    expect(resourceMatches("not a url", canonical)).toBe(false);
  });

  it("allows claude.ai, loopback on any port, and operator entries; nothing else", () => {
    delete process.env.AGENTX_MCP_REDIRECT_ALLOWLIST;
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriAllowed("http://localhost:51234/callback")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:51234/callback")).toBe(true);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback#frag")).toBe(false);
    expect(redirectUriAllowed("https://claude.ai.evil.example/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed("https://localhost.evil.example/callback")).toBe(false);
    expect(redirectUriAllowed("https://evil.example/callback")).toBe(false);
    process.env.AGENTX_MCP_REDIRECT_ALLOWLIST = "https://ide.example.com/oauth/*, https://exact.example.com/cb";
    expect(redirectUriAllowed("https://ide.example.com/oauth/callback")).toBe(true);
    expect(redirectUriAllowed("https://exact.example.com/cb")).toBe(true);
    expect(redirectUriAllowed("https://exact.example.com/cb2")).toBe(false);
  });
});
