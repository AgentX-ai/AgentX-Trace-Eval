import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
