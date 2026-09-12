import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engineVersion } from "../../version.js";
import { registerTools, type McpContext } from "./tools.js";

// One McpServer per request: the Streamable HTTP transport runs stateless (no session ids, so
// any replica can answer any request), and the SDK requires a fresh server+transport pair per
// request in that mode to keep JSON-RPC ids from colliding. Registering ~20 tools is
// microseconds; the alternative (a shared server with per-request tenancy smuggled through
// AsyncLocalStorage) is exactly the kind of cross-tenant footgun this engine avoids elsewhere.
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "agentx-self-host", version: engineVersion() },
    {
      instructions:
        "AgentX Trace & Eval, self-hosted. Read-only access to one project's traces, sessions, monitoring " +
        "signals and KPIs, evaluation datasets and runs, the Prompt and Tool Schema registries, and dataset " +
        "coverage insights. Start with agentx_whoami to see which project this connection is scoped to. List " +
        "tools clip long payloads; the matching get tool returns the full record.",
    }
  );
  registerTools(server, ctx);
  return server;
}
