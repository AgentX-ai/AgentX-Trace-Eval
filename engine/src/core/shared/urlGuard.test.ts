import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundUrlProblem } from "./urlGuard.js";

// The guard's contract has two tiers: metadata endpoints are refused on every deployment shape,
// while private/loopback targets are refused only under multi-tenant (self-host operators point
// tools at their own local receivers on purpose). The bypass spellings below are the ones a
// hostname-literal check historically missed: numeric IPv4 literals, v4-mapped IPv6, link-local
// IPv6, and the 0.0.0.0/8 "this host" range.

afterEach(() => {
  vi.unstubAllEnvs();
});

function multiTenant() {
  vi.stubEnv("AGENTX_AUTH", "enabled");
  vi.stubEnv("AGENTX_MULTI_TENANT", "true");
}

describe("outboundUrlProblem - every deployment shape", () => {
  it("rejects garbage and non-http(s) schemes", () => {
    expect(outboundUrlProblem("not a url")).toBe("not a valid URL");
    expect(outboundUrlProblem("ftp://example.com/x")).toBe("only http(s) URLs are allowed");
    expect(outboundUrlProblem("file:///etc/passwd")).toBe("only http(s) URLs are allowed");
  });

  it("rejects cloud metadata endpoints in any spelling", () => {
    expect(outboundUrlProblem("http://metadata.google.internal/computeMetadata/v1/")).not.toBeNull();
    expect(outboundUrlProblem("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
    // 169.254.169.254 as a decimal literal - URL canonicalizes it, the guard must still refuse it.
    expect(outboundUrlProblem("http://2852039166/latest/meta-data/")).not.toBeNull();
    expect(outboundUrlProblem("http://[::ffff:169.254.169.254]/latest/meta-data/")).not.toBeNull();
    expect(outboundUrlProblem("http://[fd00:ec2::254]/latest/meta-data/")).not.toBeNull();
  });

  it("allows loopback and RFC1918 targets on single-tenant self-host", () => {
    expect(outboundUrlProblem("http://localhost:11434/v1/chat")).toBeNull();
    expect(outboundUrlProblem("http://127.0.0.1:8000/hook")).toBeNull();
    expect(outboundUrlProblem("http://192.168.1.20/webhook")).toBeNull();
    expect(outboundUrlProblem("https://hooks.slack.com/services/T0/B0/x")).toBeNull();
  });
});

describe("outboundUrlProblem - multi-tenant", () => {
  it("rejects loopback and RFC1918 targets", () => {
    multiTenant();
    for (const url of [
      "http://localhost:8000/hook",
      "http://127.0.0.1/hook",
      "http://10.1.2.3/hook",
      "http://192.168.1.20/hook",
      "http://172.16.0.1/hook",
      "http://172.31.255.255/hook",
    ]) {
      expect(outboundUrlProblem(url), url).not.toBeNull();
    }
  });

  it("rejects numeric IPv4 literal spellings of private targets", () => {
    multiTenant();
    for (const url of [
      "http://2130706433/hook", // decimal 127.0.0.1
      "http://0x7f000001/hook", // hex 127.0.0.1
      "http://0177.0.0.1/hook", // octal first octet
      "http://0/hook", // 0.0.0.0 shorthand
      "http://0.0.0.0/hook",
    ]) {
      expect(outboundUrlProblem(url), url).not.toBeNull();
    }
  });

  it("rejects IPv6 loopback, unspecified, link-local, ULA, and v4-mapped forms", () => {
    multiTenant();
    for (const url of [
      "http://[::1]/hook",
      "http://[::]/hook",
      "http://[fe80::1]/hook",
      "http://[fd12:3456::1]/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://[::ffff:7f00:1]/hook",
      "http://[::ffff:10.0.0.1]/hook",
    ]) {
      expect(outboundUrlProblem(url), url).not.toBeNull();
    }
  });

  it("still allows public targets, and private ones with the explicit opt-in", () => {
    multiTenant();
    expect(outboundUrlProblem("https://hooks.slack.com/services/T0/B0/x")).toBeNull();
    vi.stubEnv("AGENTX_EGRESS_ALLOW_PRIVATE", "1");
    expect(outboundUrlProblem("http://127.0.0.1:8000/hook")).toBeNull();
    // The opt-in never reaches metadata endpoints.
    expect(outboundUrlProblem("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
  });
});
