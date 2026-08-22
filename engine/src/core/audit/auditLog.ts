import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, type SQL } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// The append-only audit trail (P2.2 of the enterprise improvement plan). Two functions, by
// design: record and list. There is no update, no delete, and no route that reaches either -
// immutability here is enforced by the absence of code, which is the strongest guarantee a
// single-binary engine can make (an operator with database access can always do anything; the
// audit trail's job is making the ENGINE incapable of quietly rewriting history).

export type AuditActorType = "project-key" | "user" | "admin" | "anonymous";

export type AuditEventInput = {
  actor: string;
  actorType: AuditActorType;
  action: string;
  method: string;
  path: string;
  status: number;
  entityType?: string | null;
  entityId?: string | null;
  summary?: Record<string, unknown> | null;
  ip?: string | null;
  projectId?: string | null;
};

export type AuditEventRow = AuditEventInput & { id: string; createdAt: Date };

// Fire-and-forget from the request tap: an audit insert failing must never fail the request it
// describes (the mutation already happened), so errors are logged and swallowed here rather
// than bubbled into response handling.
export async function recordAuditEvent(db: Db, input: AuditEventInput): Promise<void> {
  const row = {
    id: randomUUID(),
    createdAt: new Date(),
    actor: input.actor,
    actorType: input.actorType,
    action: input.action,
    method: input.method,
    path: input.path,
    status: input.status,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary ?? null,
    ip: input.ip ?? null,
    projectId: input.projectId ?? null,
  };
  try {
    if (db.kind === "sqlite") {
      db.db.insert(db.schema.auditEvents).values(row).run();
    } else {
      await db.db.insert(db.schema.auditEvents).values(row);
    }
  } catch (err) {
    console.error("Audit event write failed (request unaffected):", err);
  }
}

export type AuditListFilters = {
  since?: Date;
  action?: string;
  actor?: string;
  projectId?: string;
  // Org-scoped reads (/auth-org/audit): restrict to the caller's own projects. An empty array
  // matches nothing, by design - "no projects" must not mean "everything".
  projectIds?: string[];
  limit?: number;
};

export async function listAuditEvents(db: Db, filters: AuditListFilters = {}): Promise<AuditEventRow[]> {
  // Same one-spot `any` narrowing as core/export/exportData.ts: the sqlite/pg table types
  // don't unify, and the two schemas are kept parallel by auth/schemaParity.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = db.schema.auditEvents;
  const conds: SQL[] = [];
  if (filters.since) {
    conds.push(gte(t.createdAt, filters.since));
  }
  if (filters.action) {
    conds.push(eq(t.action, filters.action));
  }
  if (filters.actor) {
    conds.push(eq(t.actor, filters.actor));
  }
  if (filters.projectId) {
    conds.push(eq(t.projectId, filters.projectId));
  }
  if (filters.projectIds) {
    conds.push(inArray(t.projectId, filters.projectIds.length ? filters.projectIds : ["__none__"]));
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const where = conds.length ? and(...conds) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (db.db as any).select().from(t).where(where).orderBy(desc(t.createdAt)).limit(limit);
  const rows = db.kind === "sqlite" ? q.all() : await q;
  return rows as AuditEventRow[];
}
