import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveWebBundleDir } from "./web.js";

// The compiled binary resolves import.meta.url inside Bun's virtual filesystem, so the
// repo-relative path it used to use collapsed to the real filesystem root.
describe("resolveWebBundleDir", () => {
  const repoCheckout = (p: string) => p === "/home/dev/agentx/package.json";

  it("uses the repo's web/ when running from a source checkout", () => {
    expect(resolveWebBundleDir("/home/dev/agentx/engine/src", "/usr/bin/node", repoCheckout)).toBe(
      "/home/dev/agentx/web"
    );
  });

  it("uses the same path from dist/ as from src/", () => {
    expect(resolveWebBundleDir("/home/dev/agentx/engine/dist", "/usr/bin/node", repoCheckout)).toBe(
      "/home/dev/agentx/web"
    );
  });

  it("never writes to the filesystem root from a compiled binary", () => {
    // Bun's virtual path: joining "../.." off it lands at "/", and the old code extracted there.
    const target = resolveWebBundleDir("/$bunfs/root", "/opt/agentx/agentx-engine", () => false);
    expect(target).toBe("/opt/agentx/web");
    expect(target).not.toBe("/web");
    expect(path.dirname(target)).not.toBe("/");
  });

  it("falls back beside the binary whenever there is no package.json above it", () => {
    expect(resolveWebBundleDir("/anything/at/all", "/usr/local/bin/agentx-engine", () => false)).toBe(
      "/usr/local/bin/web"
    );
  });
});
