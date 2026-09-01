import fs from "node:fs";
import path from "node:path";

// The engine's release version, for display (Settings' corner, boot log) - version control's
// first question: "which build is this install actually running?"
//
// Source of truth is the RELEASE file build.sh writes next to the binaries (the release
// workflow's tag, or `git describe` for a local build) - the engine's package.json version is
// NOT used: releases are minted per merge by tag (v0.3.x), and package.json does not track
// them. A source checkout running under tsx has no RELEASE file and honestly reports "dev".
let cached: string | null = null;

export function engineVersion(): string {
  if (cached !== null) {
    return cached;
  }
  // Installed layouts, same sibling convention as web/ (see web.ts): RELEASE ships inside the
  // release tarball (written by release.yml, and by build.sh for local dist builds);
  // `.version` is what the Python SDK's launcher stamps into ~/.agentx/bin on install. cwd
  // covers `./dist/agentx-server` style launches.
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, "RELEASE"),
    path.join(execDir, ".version"),
    path.join(process.cwd(), "RELEASE"),
  ];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) {
        cached = value;
        return cached;
      }
    } catch {
      // Not this layout - keep looking.
    }
  }
  cached = "dev";
  return cached;
}
