import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The bug class this pins: a column migration added to the sqlite list without its Postgres
// ADD COLUMN IF NOT EXISTS twin. Three of those shipped (auth_account.issuer - a hard BOOT
// CRASH on upgraded pg installs because a later backfill UPDATEs the column - plus
// auth_invitation.created_at and traces.span_kind/source, which 500'd invites and every trace
// read). auth/schemaParity.test.ts compares drizzle schemas only; nothing compared the two
// migration lists until this did.
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "db.ts"), "utf8");

const sqliteMigrations = new Set(
  [...source.matchAll(/\["(\w+)", "ALTER TABLE \w+ ADD COLUMN (\w+)/g)].map(m => `${m[1]}.${m[2]}`)
);
const pgMigrations = new Set(
  [...source.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => `${m[1]}.${m[2]}`)
);

describe("column-migration dialect parity", () => {
  it("every sqlite column migration has a Postgres ADD COLUMN IF NOT EXISTS twin", () => {
    const missing = [...sqliteMigrations].filter(entry => !pgMigrations.has(entry));
    expect(missing, `sqlite migrations with no pg twin: ${missing.join(", ")}`).toEqual([]);
  });

  it("sanity: both lists are non-trivially populated", () => {
    expect(sqliteMigrations.size).toBeGreaterThan(50);
    expect(pgMigrations.size).toBeGreaterThan(50);
  });
});
