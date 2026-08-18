import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getProfile } from "./profiles.js";

// Self-host's real agent registry. Before this, an "agent" was purely derived from
// `SELECT DISTINCT name FROM traces` - no identity table, no real id, and every monitor_* table
// that scoped something to an agent stored that same name string directly. Backward compatibility
// is the whole point here: every existing caller that only ever knew about names (every demo
// script, every dashboard flow before this shipped) keeps resolving to the same single agent it
// always implicitly meant - see resolveAgentId below. A real, generated id (from an explicit
// POST /agents / client.agents.register()) is the only way to end up with two agents sharing a
// display name, disambiguated from then on by id.
export type AgentRow = {
  id: string;
  name: string;
  createdAt: Date;
  projectId: string | null;
};

function toWire(row: AgentRow) {
  return { _id: row.id, name: row.name, createdAt: row.createdAt };
}

export async function createAgent(db: Db, name: string) {
  const row: AgentRow = { id: nanoid(), name, createdAt: new Date(), projectId: db.projectId };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.agents).values(row);
  } else {
    await db.db.insert(db.schema.agents).values(row);
  }
  return toWire(row);
}

export async function getAgentRow(db: Db, id: string): Promise<AgentRow | null> {
  const cond = and(eq(db.schema.agents.id, id), eq(db.schema.agents.projectId, db.projectId));
  let row: AgentRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.agents).where(cond).all()[0] as AgentRow | undefined;
  } else {
    row = (await db.db.select().from(db.schema.agents).where(cond))[0] as AgentRow | undefined;
  }
  return row ?? null;
}

export async function getAgent(db: Db, id: string) {
  const row = await getAgentRow(db, id);
  return row ? toWire(row) : null;
}

async function findOldestAgentByName(db: Db, name: string): Promise<AgentRow | null> {
  const cond = and(eq(db.schema.agents.name, name), eq(db.schema.agents.projectId, db.projectId));
  let row: AgentRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db
      .select()
      .from(db.schema.agents)
      .where(cond)
      .orderBy(asc(db.schema.agents.createdAt))
      .limit(1)
      .all()[0] as AgentRow | undefined;
  } else {
    row = (
      await db.db.select().from(db.schema.agents).where(cond).orderBy(asc(db.schema.agents.createdAt)).limit(1)
    )[0] as AgentRow | undefined;
  }
  return row ?? null;
}

// The crux backward-compat mechanism. `input` is either a real agent id (honored as-is) or a bare
// name (today's - and every pre-registry caller's - only concept of agent identity): resolved to
// the oldest agent already registered under that name, or a freshly created one on first use.
// Reused at every write site that accepts an "agentId" as external input (trace ingestion,
// PUT .../profiles/:agentId, pattern/online-evaluator agentIds scope arrays) so a legacy caller
// passing a name never sees different behavior than before this registry existed.
export async function resolveAgentId(db: Db, input: string): Promise<string> {
  const byId = await getAgentRow(db, input);
  if (byId) {
    return byId.id;
  }
  const existing = await findOldestAgentByName(db, input);
  if (existing) {
    return existing.id;
  }
  return autoRegisterAgent(db, input);
}

// The id an auto-registered agent gets, derived from (project, name) instead of drawn at random.
//
// Auto-registration is a find-or-create across two statements, and the find cannot see a create
// that has not committed yet - so a burst of first-ever traces for one new agent name (a deploy,
// a load test, an SDK fanning out across workers) used to register the name once PER REQUEST.
// Twenty duplicate rows in the Agents tab, and worse, those twenty traces split across twenty
// agent ids, fragmenting every per-agent KPI and scope rule that keys off one. It held on SQLite
// only because better-sqlite3 is synchronous; on Postgres, and on any multi-replica deployment
// (which AGENTX_AUTH_SECRET's docs explicitly contemplate), it is wide open.
//
// A unique index on (project_id, name) would be the obvious fix and is the wrong one: two agents
// deliberately registered under the same display name is a supported thing (see this file's header
// comment - that is what POST /agents is for, disambiguated by id from then on). Deriving the id
// instead makes the PRIMARY KEY do the work for the auto-registration path alone: every replica
// computes the same id for the same (project, name), so the second insert conflicts and loses.
// Explicit registrations keep their random nanoid and can still collide by name freely.
//
// Existing installs are unaffected: an agent already registered under the name is found by
// findOldestAgentByName above and this is never reached.
function autoRegisteredAgentId(projectId: string, name: string): string {
  return createHash("sha256").update(`${projectId}\u0000${name}`).digest("base64url").slice(0, 21);
}

async function autoRegisterAgent(db: Db, name: string): Promise<string> {
  const row: AgentRow = { id: autoRegisteredAgentId(db.projectId, name), name, createdAt: new Date(), projectId: db.projectId };
  const inserted = (
    db.kind === "sqlite"
      ? db.db.insert(db.schema.agents).values(row).onConflictDoNothing().returning({ id: db.schema.agents.id }).all()
      : await db.db.insert(db.schema.agents).values(row).onConflictDoNothing().returning({ id: db.schema.agents.id })
  ) as { id: string }[];
  if (inserted[0]) {
    return inserted[0].id;
  }
  // Lost the race - the winner wrote the same id, so it is already the right answer, but re-read
  // by name so a pre-existing row under a different id still wins over this derived one.
  const winner = await findOldestAgentByName(db, name);
  return winner?.id ?? row.id;
}

// Array counterpart of resolveAgentId, for pattern/online-evaluator agentIds scope arrays
// (core/monitor/patterns.ts, core/monitor/onlineEvaluators.ts) - resolves each entry the same way
// a single agentId would, so a legacy caller passing agent names in that array keeps working.
// `undefined` passes through unchanged (the "don't touch this field" case every one of these
// routes' PATCH-like partial updates relies on).
export async function resolveAgentIds(db: Db, ids: string[] | null | undefined): Promise<string[] | undefined> {
  if (!ids) {
    return undefined;
  }
  return Promise.all(ids.map(id => resolveAgentId(db, id)));
}

// Read-only counterpart to resolveAgentId, for filter/query contexts (e.g. GET /signals?agentId=)
// where creating an agent as a side effect of a read would be wrong - a filter for a name that
// doesn't exist should just match nothing, not register a new agent. Falls back to returning
// `input` unchanged if it's neither a known id nor a known name, which still does the right thing
// downstream: filtering by a value nothing has ever matches finds nothing, exactly like before
// this registry existed.
export async function resolveExistingAgentId(db: Db, input: string): Promise<string> {
  const byId = await getAgentRow(db, input);
  if (byId) {
    return byId.id;
  }
  const existing = await findOldestAgentByName(db, input);
  return existing ? existing.id : input;
}

// Batch name lookup for wire responses that need a human-readable label next to a stored agentId
// (signals.ts's toWire, performance.ts, events.ts's getTopFailing,
// agentMonitoringDashboard.ts's resolveMonitorFindingsDataset) - one query instead of N. Falls
// back to the id itself for anything genuinely not found, never a hard failure.
export async function getAgentNamesById(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => !!id)));
  if (unique.length === 0) {
    return new Map();
  }
  const cond = and(inArray(db.schema.agents.id, unique), eq(db.schema.agents.projectId, db.projectId));
  const rows =
    db.kind === "sqlite" ? db.db.select().from(db.schema.agents).where(cond).all() : await db.db.select().from(db.schema.agents).where(cond);
  return new Map((rows as AgentRow[]).map(row => [row.id, row.name]));
}

// Dashboard/SDK agent list - one row per registered agent (real rows now, not distinct trace
// names), each joined with its monitoring profile, same shape as before this registry existed.
export async function listAgentsWire(db: Db) {
  const cond = eq(db.schema.agents.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.agents).where(cond).orderBy(asc(db.schema.agents.name)).all()
      : await db.db.select().from(db.schema.agents).where(cond).orderBy(asc(db.schema.agents.name));

  return Promise.all(
    (rows as AgentRow[]).map(async row => ({
      _id: row.id,
      name: row.name,
      kind: "agent" as const,
      // Every agent self-host knows about arrived via the SDK/dashboard registration, never
      // AgentX's own native agent-builder, so this is always "external" (matches the dashboard's
      // "External" badge).
      agentType: "external" as const,
      monitoringAgentId: row.id,
      monitoringProfile: await getProfile(db, row.id),
      createdAt: row.createdAt,
    }))
  );
}
