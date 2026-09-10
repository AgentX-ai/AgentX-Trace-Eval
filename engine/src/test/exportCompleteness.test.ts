import { describe, expect, it } from "vitest";
import { getTableColumns, is, Table, getTableName } from "drizzle-orm";
import * as schema from "../storage/schema.sqlite.js";
import { EXPORT_ENTITIES } from "../core/export/exportData.js";

// The registry is hand-maintained while deleteProject derives its table list from the schema -
// the exact shape that already burned once ("a backup captured the binding but not what it
// judges WITH"). This test derives the same list: every project-scoped table is either
// exported or NAMED here as deliberately excluded, so a new table cannot silently vanish
// from backups.
const DELIBERATELY_EXCLUDED = new Set([
  // Derived/ephemeral - cheap to rebuild, wrong to restore:
  "monitor_rollups", // re-aggregated from spans
  "insight_case_embeddings", // lazily re-warmed embedding cache
  "sweep_leases", // cross-replica election state
  "usage_events", // metering counters
  "projects", // the container itself - created by the import target, not restored into it
  "api_keys", // credentials never leave an install in a backup file
]);

describe("export registry completeness", () => {
  it("every project-scoped table is exported or explicitly excluded", () => {
    const exported = new Set(
      Object.values(EXPORT_ENTITIES).map(e => getTableName(schema[e.table as keyof typeof schema] as Table))
    );
    const missing: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, Table)) continue;
      const columns = getTableColumns(value);
      if (!("projectId" in columns)) continue;
      const name = getTableName(value);
      if (!exported.has(name) && !DELIBERATELY_EXCLUDED.has(name)) {
        missing.push(name);
      }
    }
    expect(missing, `project-scoped tables absent from EXPORT_ENTITIES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every registry entry names a real table and a real column", () => {
    for (const [entity, config] of Object.entries(EXPORT_ENTITIES)) {
      const table = schema[config.table as keyof typeof schema] as Table | undefined;
      expect(table, `${entity}: table ${config.table} missing from schema`).toBeTruthy();
      const columns = getTableColumns(table as Table);
      expect(config.sinceColumn in columns, `${entity}: sinceColumn ${config.sinceColumn} missing`).toBe(true);
    }
  });
});
