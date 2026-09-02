import { secretEquals } from "../auth/secretEquals.js";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { asyncRouter } from "./asyncRouter.js";
import { traceStoreFor } from "../core/trace/store/index.js";
import { getDb } from "../storage/db.js";
import { judgeCallsSince } from "../core/shared/usage.js";
import { listAuditEvents } from "../core/audit/auditLog.js";

// Operator surface for a multi-tenant deployment: who's on this instance and what are they
// spending. Guarded by a static operator token (AGENTX_ADMIN_TOKEN, x-admin-token header) -
// deliberately NOT a user role: the operator of the box and the tenants on it are different
// trust domains. Unset token = the router 404s everything (mounted but inert), so the OSS
// single-tenant default exposes nothing new.
export const adminRouter = asyncRouter();

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.AGENTX_ADMIN_TOKEN;
  if (!expected) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!secretEquals(req.header("x-admin-token"), expected)) {
    res.status(401).json({ error: "Invalid admin token" });
    return;
  }
  next();
}

adminRouter.use(requireAdminToken);

adminRouter.get("/overview", async (req: Request, res: Response) => {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  type OrgRow = { id: string; name: string; createdAt: Date };
  type TraceCount = { projectId: string | null; n: number };
  let orgs: OrgRow[];
  let members: { organizationId: string }[];
  let projects: { id: string; organizationId: string | null }[];
  let traceRows: TraceCount[];
  if (db.kind === "sqlite") {
    orgs = db.db.select().from(db.schema.authOrganizations).all() as OrgRow[];
    members = db.db.select().from(db.schema.authMembers).all() as { organizationId: string }[];
    projects = db.db.select().from(db.schema.projects).all() as { id: string; organizationId: string | null }[];
    traceRows = (await traceStoreFor(db).countRootsByProjectUnscoped(since)) as TraceCount[];
  } else {
    orgs = (await db.db.select().from(db.schema.authOrganizations)) as OrgRow[];
    members = (await db.db.select().from(db.schema.authMembers)) as { organizationId: string }[];
    projects = (await db.db.select().from(db.schema.projects)) as { id: string; organizationId: string | null }[];
    traceRows = (await traceStoreFor(db).countRootsByProjectUnscoped(since)) as TraceCount[];
  }
  const judgeCalls = await judgeCallsSince(db, since);
  const tracesByProject = new Map(traceRows.map(row => [row.projectId, Number(row.n)]));

  res.status(200).json({
    organizations: orgs.map(org => {
      const orgProjects = projects.filter(p => p.organizationId === org.id);
      return {
        _id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        members: members.filter(m => m.organizationId === org.id).length,
        projects: orgProjects.length,
        judgeCalls24h: judgeCalls.get(org.id) ?? 0,
        traces24h: orgProjects.reduce((sum, p) => sum + (tracesByProject.get(p.id) ?? 0), 0),
      };
    }),
    // Pre-auth / single-tenant rows (organizationId null) reported as their own bucket.
    unassigned: {
      projects: projects.filter(p => !p.organizationId).length,
      judgeCalls24h: judgeCalls.get(null) ?? 0,
    },
  });
});

// The instance-wide audit trail (core/audit/auditLog.ts) - the operator's compliance read.
// Read-only by design: no update or delete route exists anywhere for audit_events, and this
// router adds none. Filters: ?since=ISO, ?action=scorer.create, ?actor=..., ?limit= (max 1000).
adminRouter.get("/audit", async (req: Request, res: Response) => {
  let since: Date | undefined;
  if (typeof req.query.since === "string" && req.query.since) {
    since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "since must be an ISO-8601 date" });
      return;
    }
  }
  const events = await listAuditEvents(getDb(), {
    since,
    action: typeof req.query.action === "string" ? req.query.action : undefined,
    actor: typeof req.query.actor === "string" ? req.query.actor : undefined,
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) || undefined : undefined,
  });
  res.status(200).json({ events });
});
