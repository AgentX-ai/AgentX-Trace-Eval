// Shared outbound-URL guard for every surface that fetches a caller-supplied URL server-side.
// Importers: playground tool endpoints (core/evaluate/playground.ts), MCP servers
// (core/evaluate/mcp.ts), monitor webhooks (core/monitor/webhooks.ts), and custom/external
// scorer URLs (routes/agentMonitoringDashboard.ts).
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
import { isMultiTenant } from "../../auth/mode.js";

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "fd00:ec2::254", "[fd00:ec2::254]"]);

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host.replace(/^\[|\]$/g, ""))) return true;
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
  if (METADATA_HOSTS.has(host) || /^169\.254\./.test(host)) {
    return "cloud metadata endpoints are never a valid target";
  }
  if (isMultiTenant() && process.env.AGENTX_EGRESS_ALLOW_PRIVATE !== "1" && isPrivateHost(host)) {
    return "private-network targets are disabled on multi-tenant deployments (AGENTX_EGRESS_ALLOW_PRIVATE=1 to allow)";
  }
  return null;
}
