import { describe, expect, it } from "vitest";
import { getAuthTables } from "better-auth/db";
import { organization } from "better-auth/plugins";
import * as sqliteSchema from "../storage/schema.sqlite.js";
import * as pgSchema from "../storage/schema.pg.js";

// better-auth owns the shape of the auth tables; this engine hand-writes them (storage/
// schema.*.ts plus the bootstrap DDL in storage/db.ts) instead of running better-auth's own
// migrator, because everything else here is hand-written DDL too. That is fine right up until
// better-auth adds a field: the dependency is pinned as ^1.6.29, so a plain `yarn install` can
// pick up 1.7, and 1.7 added a REQUIRED `issuer` to the account model. The result was a fresh
// install where every single sign-up answered 500 - no test, no type error, nothing but a
// runtime error in a mode nobody ran.
//
// So this compares the two definitions directly. It fails on the next such addition, at build
// time, naming the exact table and field to add.

// The same options index.ts passes to betterAuth() - the model names have to match or the tables
// come back under better-auth's defaults instead of this engine's.
const AUTH_OPTIONS = {
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  user: { modelName: "auth_user" },
  session: { modelName: "auth_session" },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  plugins: [
    organization({
      schema: {
        organization: { modelName: "auth_organization" },
        member: { modelName: "auth_member" },
        invitation: { modelName: "auth_invitation" },
      },
    }),
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expectedTables = getAuthTables(AUTH_OPTIONS as any);

// drizzle keeps the column list on the table object; the exact accessor differs between the
// sqlite and pg builders, so read the declared columns generically.
function columnNames(table: unknown): Set<string> {
  const columns = (table as { [k: symbol]: unknown });
  const symbols = Object.getOwnPropertySymbols(columns);
  const columnsSymbol = symbols.find(sym => sym.description === "drizzle:Columns");
  const declared = columnsSymbol ? (columns[columnsSymbol] as Record<string, unknown>) : {};
  return new Set(Object.keys(declared));
}

const ENGINE_TABLES: Record<string, { sqlite: unknown; pg: unknown }> = {
  auth_user: { sqlite: sqliteSchema.authUsers, pg: pgSchema.authUsers },
  auth_session: { sqlite: sqliteSchema.authSessions, pg: pgSchema.authSessions },
  auth_account: { sqlite: sqliteSchema.authAccounts, pg: pgSchema.authAccounts },
  auth_verification: { sqlite: sqliteSchema.authVerifications, pg: pgSchema.authVerifications },
  auth_organization: { sqlite: sqliteSchema.authOrganizations, pg: pgSchema.authOrganizations },
  auth_member: { sqlite: sqliteSchema.authMembers, pg: pgSchema.authMembers },
  auth_invitation: { sqlite: sqliteSchema.authInvitations, pg: pgSchema.authInvitations },
};

describe("auth schema matches the installed better-auth", () => {
  it("declares every table better-auth expects", () => {
    const expected = Object.values(expectedTables).map(table => table.modelName).sort();
    expect(Object.keys(ENGINE_TABLES).sort()).toEqual(expect.arrayContaining(expected));
  });

  for (const [modelName, tables] of Object.entries(ENGINE_TABLES)) {
    for (const dialect of ["sqlite", "pg"] as const) {
      it(`${modelName} has every field better-auth expects (${dialect})`, () => {
        const expectedTable = Object.values(expectedTables).find(t => t.modelName === modelName);
        expect(expectedTable, `better-auth no longer defines ${modelName}`).toBeTruthy();

        const declared = columnNames(tables[dialect]);
        expect(declared.size, `could not read columns off the ${dialect} ${modelName} table`).toBeGreaterThan(0);

        const missing = Object.keys(expectedTable!.fields).filter(field => !declared.has(field));
        expect(missing, `${modelName} (${dialect}) is missing field(s) better-auth requires`).toEqual([]);
      });
    }
  }

  it("keeps the two dialects' auth tables in step with each other", () => {
    for (const [modelName, tables] of Object.entries(ENGINE_TABLES)) {
      expect([...columnNames(tables.pg)].sort(), `${modelName} differs between dialects`).toEqual(
        [...columnNames(tables.sqlite)].sort()
      );
    }
  });
});
