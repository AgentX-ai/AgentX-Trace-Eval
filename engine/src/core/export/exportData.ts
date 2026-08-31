import { and, asc, count, eq, gt, gte, type SQL } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Bulk data egress (P2.1 of the enterprise improvement plan): every project-scoped table an
// operator needs to back up, migrate, or walk out the door with, streamed as NDJSON by
// routes/exportData.ts. Config tables (patterns, evaluators) ride along with the data tables
// because a usable backup is the data PLUS the scorer/judge config that produced it.
//
// The registry maps a stable wire name to its table and to the timestamp column an incremental
// `?since=` filter applies to. Rows are keyset-paginated on `id` under the hood, so memory stays
// flat regardless of table size and an interrupted export can be diffed against a re-run (ids
// are stable). Instance-wide tables (portability models, app settings, auth_*) are deliberately
// absent: they belong to the operator's own infrastructure backup, not a project's data export.
export const EXPORT_ENTITIES = {
  traces: { table: "traces", sinceColumn: "createdAt" },
  signals: { table: "monitorSignals", sinceColumn: "lastSeenAt" },
  "signal-feedback": { table: "monitorSignalFeedback", sinceColumn: "createdAt" },
  "review-queue": { table: "reviewQueueItems", sinceColumn: "createdAt" },
  rules: { table: "monitorRules", sinceColumn: "createdAt" },
  events: { table: "monitorEvents", sinceColumn: "createdAt" },
  classifications: { table: "monitorClassifications", sinceColumn: "createdAt" },
  runs: { table: "evaluationRuns", sinceColumn: "createdAt" },
  "run-results": { table: "evaluationRunResults", sinceColumn: "createdAt" },
  "gate-results": { table: "gateResults", sinceColumn: "createdAt" },
  // Head-to-head verdicts are judged work with real judge spend behind them; losing them on a
  // restore would mean re-running (and re-paying for) every comparison.
  "pairwise-comparisons": { table: "pairwiseComparisons", sinceColumn: "createdAt" },
  "playground-profiles": { table: "playgroundProfiles", sinceColumn: "createdAt" },
  datasets: { table: "datasets", sinceColumn: "createdAt" },
  feedback: { table: "userFeedback", sinceColumn: "createdAt" },
  outcomes: { table: "outcomeReports", sinceColumn: "reportedAt" },
  "session-scores": { table: "sessionScores", sinceColumn: "createdAt" },
  patterns: { table: "monitorPatterns", sinceColumn: "createdAt" },
  "online-evaluators": { table: "monitorOnlineEvaluators", sinceColumn: "createdAt" },
  // The judge rubric + offline profile behind each online evaluator and dataset run - without
  // it a backup captured the binding but not what it judges WITH (deep-dive gap, closed with
  // the LLM Judge Scorer unification).
  "evaluation-settings": { table: "evaluationSettings", sinceColumn: "createdAt" },
  // Version histories and analysis narratives: rubric-edit snapshots (incl. judge-tuning
  // provenance stamps) and whole-run analyses are paid-for, unreproducible work - a "full
  // backup" that dropped them lost every historical rubric and every report.
  "dataset-versions": { table: "datasetVersions", sinceColumn: "createdAt" },
  "evaluation-settings-versions": { table: "evaluationSettingsVersions", sinceColumn: "createdAt" },
  // The one table without an `id` column: its primary key is the run it analyzed.
  "evaluation-analyses": { table: "evaluationAnalyses", sinceColumn: "createdAt", keyColumn: "evaluationId" },
  "custom-evaluators": { table: "customEvaluators", sinceColumn: "createdAt" },
} as const;

export type ExportEntity = keyof typeof EXPORT_ENTITIES;

export const EXPORT_BATCH = 500;

export function isExportEntity(value: string): value is ExportEntity {
  return value in EXPORT_ENTITIES;
}

// drizzle's sqlite and pg table types don't unify, so the registry lookup narrows through `any`
// in this one spot; the two schemas are kept structurally parallel by auth/schemaParity.test.ts.
 
function entityTable(db: Db, entity: ExportEntity): any {
  return (db.schema as Record<string, any>)[EXPORT_ENTITIES[entity].table];
}

// Keyset column: `id` for every table except the ones that key differently (registry
// `keyColumn`). Resolved here so a registry typo fails loudly instead of drizzle rendering a
// bare `asc` identifier into the SQL (the exact 500 UC8 caught on evaluation-analyses).
function entityKeyColumn(db: Db, entity: ExportEntity): any {
  const t = entityTable(db, entity);
  const name = (EXPORT_ENTITIES[entity] as { keyColumn?: string }).keyColumn ?? "id";
  const col = t[name];
  if (!col) throw new Error(`Export entity "${entity}": key column "${name}" missing on table`);
  return col;
}

/** Wire-object property carrying the keyset cursor value ("id" for all but keyed exceptions). */
export function exportKeyName(entity: ExportEntity): string {
  return (EXPORT_ENTITIES[entity] as { keyColumn?: string }).keyColumn ?? "id";
}

function buildWhere(db: Db, entity: ExportEntity, since: Date | null, cursor: string | null): SQL | undefined {
  const t = entityTable(db, entity);
  const conds: SQL[] = [eq(t.projectId, db.projectId)];
  if (since) {
    conds.push(gte(t[EXPORT_ENTITIES[entity].sinceColumn], since));
  }
  if (cursor) {
    conds.push(gt(entityKeyColumn(db, entity), cursor));
  }
  return and(...conds);
}

export async function countExportRows(db: Db, entity: ExportEntity, since: Date | null = null): Promise<number> {
  const t = entityTable(db, entity);
  const q = (db.db as any).select({ n: count() }).from(t).where(buildWhere(db, entity, since, null));
  const rows: { n: number | string }[] = db.kind === "sqlite" ? q.all() : await q;
  return Number(rows[0]?.n ?? 0);
}

export async function fetchExportBatch(
  db: Db,
  entity: ExportEntity,
  since: Date | null,
  cursor: string | null
): Promise<Record<string, unknown>[]> {
  const t = entityTable(db, entity);
  const q = (db.db as any)
    .select()
    .from(t)
    .where(buildWhere(db, entity, since, cursor))
    .orderBy(asc(entityKeyColumn(db, entity)))
    .limit(EXPORT_BATCH);
  return db.kind === "sqlite" ? q.all() : await q;
}
 
