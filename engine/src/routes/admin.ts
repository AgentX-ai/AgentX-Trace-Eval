import type { NextFunction, Request, Response } from "express";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { asyncRouter } from "./asyncRouter.js";
import { getDb } from "../storage/db.js";
import { judgeCallsSince } from "../core/shared/usage.js";

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
  if (req.header("x-admin-token") !== expected) {
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
  const traceCond = and(gte(db.schema.traces.createdAt, since), isNull(db.schema.traces.parentSpanId));
  let orgs: OrgRow[];
  let members: { organizationId: string }[];
  let projects: { id: string; organizationId: string | null }[];
  let traceRows: TraceCount[];
  if (db.kind === "sqlite") {
    orgs = db.db.select().from(db.schema.authOrganizations).all() as OrgRow[];
    members = db.db.select().from(db.schema.authMembers).all() as { organizationId: string }[];
    projects = db.db.select().from(db.schema.projects).all() as { id: string; organizationId: string | null }[];
    traceRows = db.db
      .select({ projectId: db.schema.traces.projectId, n: sql<number>`count(*)` })
      .from(db.schema.traces)
      .where(traceCond)
      .groupBy(db.schema.traces.projectId)
      .all() as TraceCount[];
  } else {
    orgs = (await db.db.select().from(db.schema.authOrganizations)) as OrgRow[];
    members = (await db.db.select().from(db.schema.authMembers)) as { organizationId: string }[];
    projects = (await db.db.select().from(db.schema.projects)) as { id: string; organizationId: string | null }[];
    traceRows = (await db.db
      .select({ projectId: db.schema.traces.projectId, n: sql<number>`count(*)` })
      .from(db.schema.traces)
      .where(traceCond)
      .groupBy(db.schema.traces.projectId)) as TraceCount[];
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
