import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostedApiRoot, loadContract } from "./contract.js";

// The hosted API's half of contracts/sdk-endpoints.json. Same idea as sdkContract.integration
// .test.ts, one repo over: the SDK's `cloud` rows have to be routes AgentX-web-api actually
// mounts, and its `cloud: false` rows have to stay unmounted there.
//
// This matters most where the two backends have diverged on purpose - prompts and online
// evaluators are self-host-only today, and the SDK documents them that way. If the hosted API
// grows them, the docs and this contract both need updating, and nothing else would say so.
//
// AgentX-web-api is a separate repo and booting it needs Mongo, so this reads its route tables
// off disk instead: `router.use("/mount", handler)` in api_v1/index.ts plus `router.<verb>("/p")`
// in the file that handler came from. That is exactly how those files are written; anything
// fancier (dynamic mounts, re-exported routers) is out of scope and would show up as a missing
// route rather than a silent pass.

const contract = loadContract();
const apiRoot = hostedApiRoot();

/** ":id" and "{id}" both become "*" so param naming never has to agree across the two repos. */
function normalize(routePath: string): string {
  const collapsed = routePath.replace(/:[A-Za-z0-9_]+/g, "*").replace(/\{[A-Za-z0-9_]+\}/g, "*");
  const trimmed = collapsed.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function readIfPresent(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Resolves a TS import specifier the way the bundler does: ./x -> x.ts, else x/index.ts. */
function resolveModule(fromDir: string, specifier: string): string {
  const base = path.resolve(fromDir, specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** Every "VERB /mount/path" the hosted API's /api/v1 router mounts, normalized. */
function hostedRoutes(): Set<string> {
  const indexFile = path.join(apiRoot, "src", "routes", "api_v1", "index.ts");
  const source = readIfPresent(indexFile);
  const indexDir = path.dirname(indexFile);

  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^import\s+(\w+)\s+from\s+"([^"]+)"/gm)) {
    imports.set(match[1]!, match[2]!);
  }
  // The tail of that file mounts a second group lazily, inside an async IIFE - /ingest, the SDK's
  // whole tracing surface, is one of them.
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*\(await import\(\s*"([^"]+)"\s*\)\)\.default/g)) {
    imports.set(match[1]!, match[2]!);
  }

  const routes = new Set<string>();
  for (const mounted of source.matchAll(/router\.use\(\s*"([^"]*)"\s*,\s*(\w+)\s*\)/g)) {
    const mount = mounted[1]!;
    const specifier = imports.get(mounted[2]!);
    if (!specifier) continue;
    const moduleFile = resolveModule(indexDir, specifier);
    if (!moduleFile) continue;
    for (const route of readIfPresent(moduleFile).matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      routes.add(`${route[1]!.toUpperCase()} ${normalize(`${mount}${route[2]!}`)}`);
    }
  }
  return routes;
}

const describeHosted = apiRoot ? describe : describe.skip;

describeHosted(`hosted API contract (agentx-python ${contract.sdkVersion})`, () => {
  const routes = hostedRoutes();

  it("found the hosted API's /api/v1 route table", () => {
    // A refactor that moves those files would otherwise empty the table and pass every
    // "not mounted" assertion below by accident.
    expect(routes.size, `no routes parsed out of ${apiRoot} - has api_v1/index.ts moved?`).toBeGreaterThan(100);
  });

  const cloudEndpoints = contract.endpoints.filter(e => e.cloud);
  const cloudGaps = contract.endpoints.filter(e => !e.cloud);

  it.each(cloudEndpoints.map(e => [`${e.method} ${e.path}`, e] as const))("routes %s", (_label, endpoint) => {
    expect(
      routes.has(`${endpoint.method} ${normalize(endpoint.path)}`),
      `${endpoint.sdk} calls ${endpoint.method} ${endpoint.path}, which AgentX-web-api no longer routes. ` +
        `Restore it there, or flip cloud to false in contracts/sdk-endpoints.json and record the gap.`
    ).toBe(true);
  });

  it.each(cloudGaps.map(e => [`${e.method} ${e.path}`, e] as const))(
    "records %s as absent from the hosted API",
    (_label, endpoint) => {
      expect(
        routes.has(`${endpoint.method} ${normalize(endpoint.path)}`),
        `AgentX-web-api now routes ${endpoint.method} ${endpoint.path}, but contracts/sdk-endpoints.json ` +
          `still calls it a "${endpoint.gap}" gap. Flip cloud to true there, and drop the "self-host only" ` +
          `note from the SDK docs for ${endpoint.sdk}.`
      ).toBe(false);
    }
  );
});
