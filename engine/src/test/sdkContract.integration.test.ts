import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadContract, type ContractEndpoint } from "./contract.js";
import { startEngine, type TestEngine } from "./server.js";

// This engine's half of contracts/sdk-endpoints.json: every endpoint the Python SDK calls is
// either mounted here or explicitly recorded as a gap, and nothing drifts either way silently.
//
// Renaming a route, or dropping one, breaks a real SDK caller and nothing else in this suite
// notices - the eval/monitor suites drive the routes they test by hand, so a rename that updates
// both the route and the test stays green. This one asserts against the paths the SDK actually
// sends, which are fixed by a published package we don't control.
//
// Both directions are checked. A `selfHost: false` row that starts answering is as much a drift
// as a `selfHost: true` row that 404s: it means a gap closed and the contract still advertises
// it, so the SDK-side and hosted-API-side suites reading the same file are now wrong too.

const contract = loadContract();

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

/**
 * Whether a route is mounted at all, as opposed to a mounted handler answering 404 for a
 * throwaway id. The engine's catch-all for unimplemented /api paths (see index.ts) answers with
 * `{statusCode, message}`; every real handler's own 404 uses `{error}`. Without this the two are
 * indistinguishable and a deleted route reads as "run not found".
 */
function isMounted(status: number, body: unknown): boolean {
  if (status !== 404) return true;
  const shape = body as { statusCode?: unknown; message?: unknown } | null;
  return !(shape?.statusCode === 404 && shape?.message === "Not found");
}

async function probe(endpoint: ContractEndpoint): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method: endpoint.method };
  if (endpoint.method === "POST" || endpoint.method === "PUT") {
    // Empty body on purpose: every handler validates before it does any work, so this reaches the
    // route without creating anything or calling out to an LLM provider.
    init.body = "{}";
    init.headers = { "content-type": "application/json" };
  }
  return engine.json(`${contract.apiRoot}${endpoint.probe}`, init);
}

describe(`SDK contract (agentx-python ${contract.sdkVersion})`, () => {
  const implemented = contract.endpoints.filter(e => e.selfHost);
  const gaps = contract.endpoints.filter(e => !e.selfHost);

  it.each(implemented.map(e => [`${e.method} ${e.path}`, e] as const))(
    "serves %s",
    async (_label, endpoint) => {
      const { status, body } = await probe(endpoint);
      expect(
        isMounted(status, body),
        `${endpoint.sdk} calls ${endpoint.method} ${endpoint.path}, which this engine no longer mounts. ` +
          `Restore the route, or flip selfHost to false in contracts/sdk-endpoints.json and record the gap.`
      ).toBe(true);
    }
  );

  it.each(gaps.map(e => [`${e.method} ${e.path}`, e] as const))(
    "records %s as a gap and does not answer it",
    async (_label, endpoint) => {
      const { status, body } = await probe(endpoint);
      expect(
        isMounted(status, body),
        `${endpoint.method} ${endpoint.path} now answers, but contracts/sdk-endpoints.json still lists it ` +
          `as a "${endpoint.gap}" gap. Flip selfHost to true there so ${endpoint.sdk} is covered by the ` +
          `suites above instead of being asserted absent.`
      ).toBe(false);
    }
  );

  it("declares a gap kind for every unimplemented endpoint", () => {
    const undeclared = gaps.filter(e => !e.gap || !(e.gap in contract.gapKinds));
    expect(undeclared.map(e => `${e.method} ${e.path}`)).toEqual([]);
  });

  it("keeps every SDK path under the API root the engine actually mounts", () => {
    // The SDK derives every path below from AGENTX_API_BASE_URL, so a prefix change here would
    // silently 404 every call rather than failing loudly.
    const stray = contract.endpoints.filter(e => !e.probe.startsWith("/"));
    expect(stray.map(e => e.probe)).toEqual([]);
    expect(contract.apiRoot).toBe("/api/v1");
  });
});
