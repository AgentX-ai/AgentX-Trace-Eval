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
export function findWebIndexHtml(): string | null {
  // process.execPath: under a compiled Bun binary this is the real on-disk path to that binary
  // (e.g. .../agentx-engine), unlike import.meta.url which resolves inside Bun's virtual
  // "/$bunfs/root/..." filesystem and can't be used to find a real sibling directory. Under
  // plain Node/tsx dev mode execPath points at the node binary itself, not useful here, so the
  // source-relative candidates below are what actually match in that case.
  const execDir = path.dirname(process.execPath);
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.join(execDir, "web", "index.html"), // installed layout: agentx-engine's own directory
    path.join(sourceDir, "web", "index.html"),
    path.join(sourceDir, "..", "web", "index.html"), // dist/../web or src/../web
    path.join(sourceDir, "..", "..", "web", "index.html"), // repo root/web from engine/dist|src
    path.join(process.cwd(), "web", "index.html"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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

// Dev-mode convenience: a fresh `git clone && yarn && yarn dev --dev` has no web/ directory
// (it isn't committed - see README's "Fastest dev loop"), which used to mean an API-only boot
// and a manual curl|tar step. Instead, fetch the released bundle into the repo's web/ once.
// Best-effort by design: offline or a missing release just returns null and the caller falls
// back to the old "not found" message with the manual command.
export async function downloadWebBundle(): Promise<string | null> {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const webDir = resolveWebBundleDir(sourceDir, process.execPath);
  const tarPath = path.join(os.tmpdir(), `agentx-web-${process.pid}.tar.gz`);
  try {
    logger.info(`Dev mode: web UI not found - downloading the prebuilt dashboard bundle...`);
    const resp = await fetch(WEB_BUNDLE_URL, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    fs.writeFileSync(tarPath, Buffer.from(await resp.arrayBuffer()));
    fs.mkdirSync(webDir, { recursive: true });
    // System tar (macOS, Linux, and Windows 10+ all ship one) rather than an npm tarball dep.
    // --no-same-owner: extracting as root would otherwise restore the archive's own uid/gid.
    execFileSync("tar", ["--no-same-owner", "-xzf", tarPath, "-C", webDir]);
    const indexHtml = path.join(webDir, "index.html");
    if (!fs.existsSync(indexHtml)) {
      throw new Error("bundle extracted but web/index.html is missing");
    }
    logger.info(`Dev mode: dashboard bundle installed into ${webDir}`);
    return indexHtml;
  } catch (err) {
    logger.info({ err }, "Dev mode: dashboard download failed - continuing API-only.");
    return null;
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}
