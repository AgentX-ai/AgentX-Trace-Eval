// Shared outbound-URL guard for every surface that fetches a caller-supplied URL server-side.
// Importers: playground tool endpoints (core/evaluate/playground.ts), MCP servers
// (core/evaluate/mcp.ts), monitor webhooks (core/monitor/webhooks.ts), custom/external
// scorer URLs (routes/agentMonitoringDashboard.ts), and agent connectors
// (core/evaluate/agentConnectors.ts).
//
// The self-host posture is deliberate: loopback and RFC1918 targets are ALLOWED - operators
// legitimately point tools at their own local vLLM/Ollama/webhook receivers, and blocking
// them would break the product's main deployment shape. What is never legitimate is a cloud
// metadata endpoint (a credential grab, not a tool), and under AGENTX_MULTI_TENANT=true -
// where these URLs arrive in per-tenant request bodies - private ranges are refused too
// unless the operator opts back in with AGENTX_EGRESS_ALLOW_PRIVATE=1.
//
// Hostname-literal checks only: DNS-rebinding-grade defenses are out of scope for a
// trusted-operator tier and documented as such.
import { isIP } from "node:net";
import { isMultiTenant } from "../../auth/mode.js";

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "fd00:ec2::254", "[fd00:ec2::254]"]);

// A pure-numeric host is an IPv4 literal in disguise: decimal (2130706433), hex (0x7f000001),
// or octal (017700000001) all dial 127.0.0.1. Node's WHATWG URL parser already folds these into
// dotted-quad hostnames, so this decode is defense in depth for any caller that hands the guard
// a host that never went through URL parsing.
function ipv4FromNumericLiteral(host: string): string | null {
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(host)) return null;
  const value = /^0x/i.test(host)
    ? Number.parseInt(host.slice(2), 16)
    : /^0\d+$/.test(host)
      ? Number.parseInt(host, 8)
      : Number.parseInt(host, 10);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

// v4-mapped IPv6 wraps an IPv4 target in a bracket host ([::ffff:127.0.0.1]). URL serializes
// the mapped form as pure hex groups ("::ffff:7f00:1"), so both spellings are accepted.
function ipv4FromMapped(bare: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }
  return null;
}

/** Every spelling of an IPv4 target (dotted, numeric literal, v4-mapped IPv6) as dotted-quad. */
function effectiveIpv4(host: string): string | null {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return bare;
  return ipv4FromNumericLiteral(bare) ?? ipv4FromMapped(bare);
}

function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost") return true;
  // IPv6: loopback, unspecified (routes to loopback), ULA fc00::/7, link-local fe80::/10.
  if (bare === "::1" || bare === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  const ip4 = effectiveIpv4(host);
  if (ip4) {
    if (/^127\./.test(ip4)) return true;
    // 0.0.0.0/8: "0", "0.0.0.0" and friends reach the local host on Linux and macOS.
    if (/^0\./.test(ip4)) return true;
    if (/^10\./.test(ip4)) return true;
    if (/^192\.168\./.test(ip4)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip4)) return true;
  }
  return false;
}

/** Null when the URL is acceptable to fetch; a human-readable refusal otherwise. */
export function outboundUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "only http(s) URLs are allowed";
  }
  const host = url.hostname.toLowerCase();
  // The link-local check runs on the canonical IPv4 so 169.254.169.254 spelled as a decimal
  // literal or a v4-mapped IPv6 host is refused the same as the dotted form.
  const ip4 = effectiveIpv4(host);
  if (METADATA_HOSTS.has(host) || /^169\.254\./.test(ip4 ?? host)) {
    return "cloud metadata endpoints are never a valid target";
  }
  if (isMultiTenant() && process.env.AGENTX_EGRESS_ALLOW_PRIVATE !== "1" && isPrivateHost(host)) {
    return "private-network targets are disabled on multi-tenant deployments (AGENTX_EGRESS_ALLOW_PRIVATE=1 to allow)";
  }
  return null;
}
