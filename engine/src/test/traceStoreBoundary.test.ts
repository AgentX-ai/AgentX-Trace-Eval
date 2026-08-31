import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The TraceStore boundary ratchet (ADR-0002): no module outside the store implementations may
// touch the traces table directly, because in the enterprise tier (ADR-0001/0003) the rows are
// not in the relational database at all. Same posture as routeBodyValidation.test.ts: ground
// gained is held by a test, not a convention.

const SRC = path.join(__dirname, "..");

// Files allowed to reference schema.traces, each for a stated reason.
const ALLOWED_DIRS = ["core/trace/store/"]; // the port and its adapters
const ALLOWED = new Set([
  "storage/schema.sqlite.ts", // table definition
  "storage/schema.pg.ts", // table definition
  "storage/db.ts", // DDL, migrations, indexes
  // typeof-cast only, inside the generic per-project delete sweep; the sweep is correct for the
  // SQL tiers and the ClickHouse tier adds an explicit store call (see the comment there).
  "core/project/deleteOrganization.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("TraceStore boundary", () => {
  it("no module outside the store touches schema.traces", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel) || ALLOWED_DIRS.some(dir => rel.startsWith(dir))) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("schema.traces")) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "These modules reach around the TraceStore port. Route the access through " +
        "core/trace/store (extending the interface if a new shape is genuinely needed) instead " +
        "of touching schema.traces - the enterprise tier has no such table to touch."
    ).toEqual([]);
  });
});
