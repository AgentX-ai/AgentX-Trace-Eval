import { and, asc, count, eq, gt, gte, type SQL } from "drizzle-orm";
import { traceStoreFor } from "../trace/store/index.js";
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
// Bearer tokens live in connector header VALUES - the dashboard masks them on every GET, and
// the export stream must not be the one surface that hands them out in cleartext. A restored
// backup keeps the header KEYS; the operator re-enters the secrets, same as provider keys
// (which are excluded from export entirely).
function redactConnectorRow(row: Record<string, unknown>): Record<string, unknown> {
  // Credentials live in the URL as often as in headers (https://user:pass@host, ?api_key=...):
  // strip userinfo and mask every query value, keeping the shape so the export stays useful.
  let url = row.url;
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, "***redacted***");
      url = parsed.toString();
    } catch {
      // Not parseable as a URL - leave as stored; nothing to redact structurally.
    }
  }
  const headers = row.headers;
  const redactedHeaders =
    headers && typeof headers === "object"
      ? Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([k]) => [k, "***redacted***"]))
      : headers;
  return { ...row, url, headers: redactedHeaders };
}

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
  // Scorer groups are grading config (members, weights, gates, online profile) - a restore
  // without them loses every composed grader while its member scorers survive individually.
  "scorer-groups": { table: "scorerGroups", sinceColumn: "createdAt" },
  // The Improve loop's registries and outputs: prompts/tools plus their version histories are
  // the same "paid-for, unreproducible" class as rubric versions above, and improvement
  // reports are LLM output money already spent.
  prompts: { table: "prompts", sinceColumn: "createdAt" },
  "prompt-versions": { table: "promptVersions", sinceColumn: "createdAt" },
  "tool-schemas": { table: "toolSchemas", sinceColumn: "createdAt" },
  "tool-schema-versions": { table: "toolSchemaVersions", sinceColumn: "createdAt" },
  "improvement-proposals": { table: "improvementProposals", sinceColumn: "createdAt" },
  "improvement-groups": { table: "improvementGroups", sinceColumn: "createdAt" },
  "improvement-group-members": { table: "improvementGroupMembers", sinceColumn: "addedAt" },
  "improvement-reports": { table: "improvementReports", sinceColumn: "createdAt" },
  // Operational registries a restore needs to look like the same install: tracked agents,
  // per-agent monitoring profiles (webhook channels included), HTTP agent connectors, saved
  // Playground runs, and the audit log.
  agents: { table: "agents", sinceColumn: "createdAt" },
  "monitor-profiles": { table: "monitorProfiles", sinceColumn: "createdAt" },
  "agent-connectors": { table: "agentConnectors", sinceColumn: "createdAt", redact: redactConnectorRow },
  "playground-runs": { table: "playgroundRuns", sinceColumn: "createdAt" },
  "audit-events": { table: "auditEvents", sinceColumn: "createdAt" },
  // Deliberately excluded (derived/ephemeral, cheap to rebuild): monitorRollups,
  // insightCaseEmbeddings, sweepLeases, usage counters. The completeness test names them.
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
  // Strict projectId match for EVERY entity, audit-events included. The NULL-projectId audit
  // rows are the instance-wide auth trail (every user's sign-in/sign-up attempts with IPs) -
  // handing them to any project API key crossed the tenant boundary this module's header
  // promises never to cross. Operators read the auth trail via the admin-token-gated
  // GET /admin/audit instead.
  const projectCond: SQL = eq(t.projectId, db.projectId);
  const conds: SQL[] = [projectCond];
  if (since) {
    conds.push(gte(t[EXPORT_ENTITIES[entity].sinceColumn], since));
  }
  if (cursor) {
    conds.push(gt(entityKeyColumn(db, entity), cursor));
  }
  return and(...conds);
}

export async function countExportRows(db: Db, entity: ExportEntity, since: Date | null = null): Promise<number> {
  if (entity === "traces") {
    // Spans live behind the trace store - on the ClickHouse tier the relational table is
    // empty, and counting it reported a "successful" backup of zero spans.
    return traceStoreFor(db).countAll(since);
  }
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
  if (entity === "traces") {
    return (await traceStoreFor(db).listForExport({ since, cursor, limit: EXPORT_BATCH })) as unknown as Record<
      string,
      unknown
    >[];
  }
  const t = entityTable(db, entity);
  const q = (db.db as any)
    .select()
    .from(t)
    .where(buildWhere(db, entity, since, cursor))
    .orderBy(asc(entityKeyColumn(db, entity)))
    .limit(EXPORT_BATCH);
  const rows = (db.kind === "sqlite" ? q.all() : await q) as Record<string, unknown>[];
  const redact = (EXPORT_ENTITIES[entity] as { redact?: (row: Record<string, unknown>) => Record<string, unknown> })
    .redact;
  return redact ? rows.map(redact) : rows;
}
 
