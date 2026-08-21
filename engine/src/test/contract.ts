import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Shared loader for contracts/sdk-endpoints.json - the checked-in list of every endpoint the
// AgentX Python SDK calls, and which of the two backends implements it. See that file's own
// $comment for the whole arrangement; this module only resolves and types it.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

export type ContractEndpoint = {
  /** The SDK call that produces this request, e.g. "client.monitor.signals.list()". */
  sdk: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Templated path relative to apiRoot, e.g. "/monitor/patterns/{patternId}". */
  path: string;
  /** Concrete path to probe with - same route, placeholders filled with a throwaway id. */
  probe: string;
  /** Implemented by the hosted API (AgentX-web-api). */
  cloud: boolean;
  /** Implemented by this engine. */
  selfHost: boolean;
  gap?: string;
  note?: string;
};

export type Contract = {
  sdkVersion: string;
  apiRoot: string;
  gapKinds: Record<string, string>;
  endpoints: ContractEndpoint[];
};

export const CONTRACT_PATH = path.join(repoRoot, "contracts", "sdk-endpoints.json");

export function loadContract(): Contract {
  return JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")) as Contract;
}

/**
 * Root of a sibling AgentX-web-api checkout, or "" when there isn't one. The hosted API lives in
 * its own repo, so the suite that checks its half of the contract is opt-in: point
 * AGENTX_WEB_API_PATH at a checkout (or keep one as a sibling directory) and it runs, otherwise
 * it skips rather than failing a clone that only has this repo.
 */
export function hostedApiRoot(): string {
  const candidates = [
    process.env.AGENTX_WEB_API_PATH ?? "",
    path.resolve(repoRoot, "../AgentX-web-api-ts/AgentX-web-api"),
    path.resolve(repoRoot, "../AgentX-web-api"),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(path.join(candidate, "src", "routes"))) ?? "";
}
