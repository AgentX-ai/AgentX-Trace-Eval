import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./log.js";

// Locates web/index.html without relying on Bun-specific asset embedding (which would need a
// different, non-portable code path under plain Node/tsx dev mode, see storage/db.ts's
// better-sqlite3/bun:sqlite split for why cross-runtime portability matters here too). Instead,
// installation ships web/index.html as a plain sibling file next to the agentx-engine/
// agentx-server binaries (see install.sh/homebrew-tap), the same way agentx-engine itself is a
// sibling of agentx-server rather than embedded in it. Tries, in order: next to this running
// file (installed layout: dist/../web or a compiled binary's own directory), then the repo's
// web/ directory (source checkout, dev mode).
// Every location a dashboard bundle is ALLOWED to live, in serving priority. Exported so boot
// can also report shadowed copies - a checkout with two differing bundles is exactly the
// "which one is stale?" debugging session this list used to cause silently.
export function webBundleCandidates(): string[] {
  // process.execPath: under a compiled Bun binary this is the real on-disk path to that binary
  // (e.g. .../agentx-engine), unlike import.meta.url which resolves inside Bun's virtual
  // "/$bunfs/root/..." filesystem and can't be used to find a real sibling directory. Under
  // plain Node/tsx dev mode execPath points at the node binary itself, not useful here, so the
  // source-relative candidates below are what actually match in that case.
  const execDir = path.dirname(process.execPath);
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));

  // ONE location per layout, no aliases: installed = next to the binary; source checkout =
  // the repo root web/ (what build.sh assembles and downloadWebBundle fetches into); cwd as
  // the last resort for odd launch dirs. engine/web deliberately is NOT a candidate - it used
  // to be, and the copy people cp'd there silently shadowed the canonical repo-root bundle.
  return [
    path.join(execDir, "web", "index.html"), // installed layout: agentx-engine's own directory
    path.join(sourceDir, "..", "..", "web", "index.html"), // repo root/web from engine/dist|src
    path.join(process.cwd(), "web", "index.html"),
  ];
}

export function findWebIndexHtml(): string | null {
  for (const candidate of webBundleCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** One-line provenance for a resolved bundle: build stamp when the bundle carries one
 *  (build-info.json, written by AgentX-eval-front's build), index.html mtime otherwise. */
export function describeWebBundle(indexHtml: string): string {
  const dir = path.dirname(indexHtml);
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, "build-info.json"), "utf8")) as {
      builtAt?: string;
      commit?: string;
    };
    if (info.builtAt) {
      return `built ${info.builtAt}${info.commit ? ` (${info.commit})` : ""}`;
    }
  } catch {
    // No stamp - releases predating build-info.json; fall through to mtime.
  }
  try {
    return `modified ${fs.statSync(indexHtml).mtime.toISOString()}`;
  } catch {
    return "age unknown";
  }
}

// The prebuilt dashboard bundle published onto this repo's own releases - the same asset
// install.sh, build.sh's fallback, and the Dockerfile's dashboard stage all consume.
const WEB_BUNDLE_URL = "https://github.com/AgentX-ai/AgentX-Trace-Eval/releases/latest/download/agentx-web.tar.gz";

// Same trap findWebIndexHtml documents above: under a compiled binary import.meta.url resolves
// inside Bun's virtual /$bunfs/root/..., so a repo-relative "../../web" collapses to /web. A real
// checkout is identified by its package.json; anything else writes beside the binary, which is
// where findWebIndexHtml looks first.
export function resolveWebBundleDir(
  sourceDir: string,
  execPath: string,
  exists: (p: string) => boolean = fs.existsSync
): string {
  const repoRoot = path.join(sourceDir, "..", "..");
  if (exists(path.join(repoRoot, "package.json"))) {
    return path.join(repoRoot, "web");
  }
  return path.join(path.dirname(execPath), "web");
}

// Fetches the released dashboard bundle into the canonical web/ directory. Two callers:
// - Dev-mode convenience: a fresh `git clone && yarn && yarn dev --dev` has no web/ directory
//   (it isn't committed - see README's "Fastest dev loop"), which used to mean an API-only boot
//   and a manual curl|tar step - so a missing bundle is fetched once.
// - `--upgrade`: an EXISTING bundle is otherwise never refreshed (the missing-only check is the
//   staleness trap for source hosts), so the flag forces a re-download of the latest release.
// Best-effort by design: offline or a missing release just returns null and the caller falls
// back to what it had - the old bundle keeps serving (force mode extracts into a temp sibling
// and swaps only after index.html verifies, so a failed download can never break a working UI).
export async function downloadWebBundle(options: { force?: boolean } = {}): Promise<string | null> {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const webDir = resolveWebBundleDir(sourceDir, process.execPath);
  const tarPath = path.join(os.tmpdir(), `agentx-web-${process.pid}.tar.gz`);
  // Force mode: never extract over the live directory - hashed assets accumulate forever and a
  // half-failed extraction would leave a broken UI. Stage, verify, then swap.
  const stageDir = options.force ? `${webDir}.upgrading-${process.pid}` : webDir;
  const currentIndex = path.join(webDir, "index.html");
  try {
    logger.info(
      options.force
        ? `Upgrading the dashboard bundle in ${webDir} (currently ${fs.existsSync(currentIndex) ? describeWebBundle(currentIndex) : "absent"})...`
        : `Dev mode: web UI not found - downloading the prebuilt dashboard bundle...`
    );
    const resp = await fetch(WEB_BUNDLE_URL, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    fs.writeFileSync(tarPath, Buffer.from(await resp.arrayBuffer()));
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    // System tar (macOS, Linux, and Windows 10+ all ship one) rather than an npm tarball dep.
    // --no-same-owner: extracting as root would otherwise restore the archive's own uid/gid.
    execFileSync("tar", ["--no-same-owner", "-xzf", tarPath, "-C", stageDir]);
    if (!fs.existsSync(path.join(stageDir, "index.html"))) {
      throw new Error("bundle extracted but web/index.html is missing");
    }
    if (options.force) {
      fs.rmSync(webDir, { recursive: true, force: true });
      fs.renameSync(stageDir, webDir);
    }
    const indexHtml = path.join(webDir, "index.html");
    logger.info(`Dashboard bundle installed into ${webDir} (${describeWebBundle(indexHtml)})`);
    return indexHtml;
  } catch (err) {
    logger.warn(
      { err },
      options.force
        ? "Dashboard upgrade failed - keeping the existing bundle."
        : "Dev mode: dashboard download failed - continuing API-only."
    );
    return null;
  } finally {
    fs.rmSync(tarPath, { force: true });
    if (options.force) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }
}
