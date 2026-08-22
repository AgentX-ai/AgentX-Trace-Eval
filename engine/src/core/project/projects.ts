import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import { eq, getTableColumns, is, Table } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Any schema table carrying a projectId - the shape deleteProject cascades over.
type AnyProjectScopedTable = Table & { _: { columns: { projectId: AnyColumn } } };

// Self-host's project registry. A project's own apiKey IS what selects it on every request - see
// auth/apiKey.ts's requireApiKey, which resolves the incoming x-api-key against this table and
// attaches the matching project's id to the request. No project_id is ever sent explicitly by a
// caller; the key alone disambiguates. Every function here takes the *unscoped* Db (getDb()'s
// bare cached singleton, not a withProjectId()-scoped one) - resolving/managing project identity
// itself is deliberately global, it's everything project identity then *scopes* (traces, agents,
// patterns, ...) that reads db.projectId.
export type ProjectRow = {
  id: string;
  name: string;
  apiKey: string;
  isDefault: boolean;
  // Project-level monitoring defaults - see schema.sqlite.ts's projects.coverageMode comment.
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  latencyThresholdMs: number;
  topicsEnabled: boolean;
  coherenceSweepEnabled: boolean;
  // Built-in template-scorer keys this project switched ON (scorer catalog toggle) -
  // null/empty = none run. Scorers are opt-in: a fresh project applies nothing by default.
  enabledBuiltinPatterns: string[] | null;
  // Owning auth organization (AGENTX_AUTH=enabled mode) - null in disabled mode and for pre-auth
  // rows until the first owner signup claims them (core/auth/betterAuth.ts's onUserCreated).
  organizationId: string | null;
  createdAt: Date;
};

function toWire(row: ProjectRow) {
  return { _id: row.id, name: row.name, apiKey: row.apiKey, isDefault: row.isDefault, createdAt: row.createdAt };
}

export type MonitoringDefaults = {
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  latencyThresholdMs: number;
  // Topics classification opt-in - project-level as of the migration described in
  // schema.sqlite.ts's projects.topicsEnabled comment (formerly per-agent on monitor_profiles).
  topicsEnabled: boolean;
  // Idle-session coherence sweep opt-OUT (default on) - see schema.sqlite.ts's
  // projects.coherenceSweepEnabled comment.
  coherenceSweepEnabled: boolean;
  // Built-in template-scorer keys (detect.ts's BUILT_IN_MONITOR_PATTERNS) this project switched
  // ON via the scorer catalog's enable toggle. Only listed keys run on incoming traffic.
  enabledBuiltinPatterns: string[];
};

function toMonitoringDefaultsWire(row: ProjectRow): MonitoringDefaults {
  return {
    coverageMode: row.coverageMode,
    sampleRate: row.sampleRate,
    retentionDays: row.retentionDays,
    latencyThresholdMs: row.latencyThresholdMs,
    topicsEnabled: row.topicsEnabled,
    coherenceSweepEnabled: row.coherenceSweepEnabled,
    enabledBuiltinPatterns: Array.isArray(row.enabledBuiltinPatterns) ? row.enabledBuiltinPatterns : [],
  };
}

function generateApiKey(): string {
  return `agtx_local_${randomBytes(24).toString("hex")}`;
}

export async function createProject(db: Db, name: string, organizationId: string | null = null) {
  const row: ProjectRow = {
    id: nanoid(),
    name,
    apiKey: generateApiKey(),
    isDefault: false,
    coverageMode: "all",
    sampleRate: 1,
    retentionDays: 30,
    latencyThresholdMs: 20000,
    topicsEnabled: false,
    coherenceSweepEnabled: true,
    enabledBuiltinPatterns: null,
    organizationId,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.projects).values(row);
  } else {
    await db.db.insert(db.schema.projects).values(row);
  }
  return toWire(row);
}

export async function getProjectRow(db: Db, id: string): Promise<ProjectRow | null> {
  let row: ProjectRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.projects).where(eq(db.schema.projects.id, id)).all()[0] as
      | ProjectRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.projects).where(eq(db.schema.projects.id, id)))[0] as
      | ProjectRow
      | undefined;
  }
  return row ?? null;
}

export async function getProject(db: Db, id: string) {
  const row = await getProjectRow(db, id);
  return row ? toWire(row) : null;
}

// The auth boundary itself: called from requireApiKey() on every authenticated request.
export async function resolveProjectByApiKey(db: Db, apiKey: string): Promise<ProjectRow | null> {
  let row: ProjectRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.projects).where(eq(db.schema.projects.apiKey, apiKey)).all()[0] as
      | ProjectRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.projects).where(eq(db.schema.projects.apiKey, apiKey)))[0] as
      | ProjectRow
      | undefined;
  }
  return row ?? null;
}

// The startup log's "Default project API key" source - whichever project the one-time migration
// created first (storage/db.ts's backfillDefaultProjectSqlite/Postgres). That printed key is what
// the operator copies into the dashboard's connect screen and the SDK; there is no endpoint that
// hands it out anymore.
export async function getDefaultProject(db: Db): Promise<ProjectRow | null> {
  let row: ProjectRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.projects).where(eq(db.schema.projects.isDefault, true)).all()[0] as
      | ProjectRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.projects).where(eq(db.schema.projects.isDefault, true)))[0] as
      | ProjectRow
      | undefined;
  }
  return row ?? null;
}

// Deleting a project must clear every project-scoped table, not just the projects row: those rows
// are only ever reachable by project id, so anything left behind is unreachable storage that still
// counts toward usage. The table list is read off the schema (anything with a projectId column)
// rather than hand-maintained, so a table added later cascades without a code change here.
export async function deleteProject(db: Db, id: string): Promise<void> {
  const scoped = Object.values(db.schema).filter(
    (value): value is AnyProjectScopedTable => is(value, Table) && "projectId" in getTableColumns(value)
  );
  for (const table of scoped) {
    const { projectId } = getTableColumns(table);
    if (db.kind === "sqlite") {
      await db.db.delete(table).where(eq(projectId, id));
    } else {
      await db.db.delete(table).where(eq(projectId, id));
    }
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.projects).where(eq(db.schema.projects.id, id));
  } else {
    await db.db.delete(db.schema.projects).where(eq(db.schema.projects.id, id));
  }
}

export async function listProjectRows(db: Db): Promise<ProjectRow[]> {
  const rows =
    db.kind === "sqlite" ? db.db.select().from(db.schema.projects).all() : await db.db.select().from(db.schema.projects);
  return rows as ProjectRow[];
}

// GET /api/v1/projects' source - deliberately includes each project's own apiKey so a project
// switcher can populate a dropdown with every project's key already in hand, no separate
// per-project auth handshake needed. The route itself is guarded (session in enabled-auth mode,
// a valid existing project key in disabled mode) - there is no anonymous key handout anymore.
export async function listProjectsWire(db: Db) {
  return (await listProjectRows(db)).map(toWire);
}

// Enabled-auth mode's project listing: only the projects owned by the caller's organizations.
// Unclaimed (orgless) rows are deliberately invisible here - they only exist before the first
// owner signup, which claims them all.
export async function listProjectsWireForOrgs(db: Db, organizationIds: string[]) {
  const allowed = new Set(organizationIds);
  return (await listProjectRows(db)).filter(row => row.organizationId && allowed.has(row.organizationId)).map(toWire);
}

// Unlike every other function in this file, these two operate on the *current, already-resolved*
// project (db.projectId) rather than an explicit id - same "scoped Db" convention every other
// domain's core functions use, since this is genuinely per-project config once a request has
// already been authenticated, not project-identity resolution itself.
export async function getMonitoringDefaults(db: Db): Promise<MonitoringDefaults> {
  const row = await getProjectRow(db, db.projectId);
  if (!row) {
    throw new Error(`getMonitoringDefaults() called with an unresolved project id "${db.projectId}"`);
  }
  return toMonitoringDefaultsWire(row);
}

export type UpdateMonitoringDefaultsInput = Partial<MonitoringDefaults>;

export async function updateMonitoringDefaults(db: Db, patch: UpdateMonitoringDefaultsInput): Promise<MonitoringDefaults> {
  const existing = await getMonitoringDefaults(db);
  const updated: MonitoringDefaults = {
    coverageMode: patch.coverageMode ?? existing.coverageMode,
    sampleRate: patch.sampleRate ?? existing.sampleRate,
    retentionDays: patch.retentionDays ?? existing.retentionDays,
    latencyThresholdMs: patch.latencyThresholdMs ?? existing.latencyThresholdMs,
    topicsEnabled: patch.topicsEnabled ?? existing.topicsEnabled,
    coherenceSweepEnabled: patch.coherenceSweepEnabled ?? existing.coherenceSweepEnabled,
    enabledBuiltinPatterns: patch.enabledBuiltinPatterns ?? existing.enabledBuiltinPatterns,
  };
  const cond = eq(db.schema.projects.id, db.projectId);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.projects).set(updated).where(cond);
  } else {
    await db.db.update(db.schema.projects).set(updated).where(cond);
  }
  return updated;
}

export async function regenerateProjectApiKey(db: Db, projectId: string) {
  const newKey = generateApiKey();
  const setValues = { apiKey: newKey };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.projects).set(setValues).where(eq(db.schema.projects.id, projectId));
  } else {
    await db.db.update(db.schema.projects).set(setValues).where(eq(db.schema.projects.id, projectId));
  }
  return getProject(db, projectId);
}
