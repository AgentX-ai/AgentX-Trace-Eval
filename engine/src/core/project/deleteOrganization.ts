import { eq, inArray } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Full organization deletion (the data-lifecycle half of multi-tenant): every row of every
// project the org owns, the projects themselves, the org's settings row and catalog entries,
// and finally the auth rows (members, invitations, the organization). Users are NOT deleted -
// a user can belong to other organizations, and an orphaned account signing in again simply
// gets a fresh org in multi-tenant mode.
//
// The per-table sweep is schema-driven: any table carrying a project_id column is cleared for
// the org's projects, so a new project-scoped table added later is covered automatically
// instead of silently surviving deletions.
export async function deleteOrganization(db: Db, organizationId: string): Promise<{ projectsDeleted: number }> {
  const projectRows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.projects).where(eq(db.schema.projects.organizationId, organizationId)).all()
      : await db.db.select().from(db.schema.projects).where(eq(db.schema.projects.organizationId, organizationId))
  ) as { id: string }[];
  const projectIds = projectRows.map(row => row.id);

  if (projectIds.length > 0) {
    // Branch once on dialect so each loop stays fully typed against its own schema flavor.
    if (db.kind === "sqlite") {
      for (const [name, table] of Object.entries(db.schema)) {
        if (name === "projects") continue;
        const columns = getTableColumns(table as never) as Record<string, unknown>;
        if (!columns.projectId) continue;
        const t = table as typeof db.schema.traces;
        await db.db.delete(t).where(inArray(t.projectId, projectIds));
      }
      await db.db.delete(db.schema.projects).where(inArray(db.schema.projects.id, projectIds));
    } else {
      for (const [name, table] of Object.entries(db.schema)) {
        if (name === "projects") continue;
        const columns = getTableColumns(table as never) as Record<string, unknown>;
        if (!columns.projectId) continue;
        const t = table as typeof db.schema.traces;
        await db.db.delete(t).where(inArray(t.projectId, projectIds));
      }
      await db.db.delete(db.schema.projects).where(inArray(db.schema.projects.id, projectIds));
    }
  }

  // Org-scoped rows outside the project sweep: settings ("org:<id>"), catalog additions.
  const settingsCond = eq(db.schema.appSettings.id, `org:${organizationId}`);
  const catalogCond = eq(db.schema.portabilityModels.organizationId, organizationId);
  const membersCond = eq(db.schema.authMembers.organizationId, organizationId);
  const invitesCond = eq(db.schema.authInvitations.organizationId, organizationId);
  const orgCond = eq(db.schema.authOrganizations.id, organizationId);
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.appSettings).where(settingsCond);
    await db.db.delete(db.schema.portabilityModels).where(catalogCond);
    await db.db.delete(db.schema.authMembers).where(membersCond);
    await db.db.delete(db.schema.authInvitations).where(invitesCond);
    await db.db.delete(db.schema.authOrganizations).where(orgCond);
  } else {
    await db.db.delete(db.schema.appSettings).where(settingsCond);
    await db.db.delete(db.schema.portabilityModels).where(catalogCond);
    await db.db.delete(db.schema.authMembers).where(membersCond);
    await db.db.delete(db.schema.authInvitations).where(invitesCond);
    await db.db.delete(db.schema.authOrganizations).where(orgCond);
  }

  return { projectsDeleted: projectIds.length };
}
