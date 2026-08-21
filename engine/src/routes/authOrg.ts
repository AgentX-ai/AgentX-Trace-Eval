import type { Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { asyncRouter } from "./asyncRouter.js";
import { getDb, type Db } from "../storage/db.js";
import { getSessionUser, type SessionUser } from "../auth/betterAuth.js";
import { mailerConfigured, sendMailInBackground } from "../auth/mailer.js";
import { deleteOrganization } from "../core/project/deleteOrganization.js";

// Organization membership + invitations for AGENTX_AUTH=enabled mode (mounted only then, see
// apiV1.ts). Session-authenticated - these are account-plane routes, not data-plane, so no
// project API key is involved. Deliberately engine-native rows (the same auth_member /
// auth_invitation tables better-auth's organization plugin owns) rather than proxying the
// plugin's own HTTP surface: the flows here are small, and pinning them to our tables keeps
// them stable across better-auth versions.
//
// Invitation flow (works without a mailer - Phase 2 adds invite emails on top):
//   owner/admin POSTs an invitation -> gets a link to hand to the teammate
//   teammate signs in (or signs up) -> opens the link -> POST accept -> becomes a member.
// The invite is bound to the invited email: only a session with that email can accept it.
export const authOrgRouter = asyncRouter();

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type MemberRow = { id: string; organizationId: string; userId: string; role: string | null; createdAt: Date };

async function membershipsOf(db: Db, userId: string): Promise<MemberRow[]> {
  const cond = eq(db.schema.authMembers.userId, userId);
  return (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).where(cond).all()
      : await db.db.select().from(db.schema.authMembers).where(cond)
  ) as MemberRow[];
}

async function memberIn(db: Db, userId: string, organizationId: string): Promise<MemberRow | null> {
  const rows = await membershipsOf(db, userId);
  return rows.find(row => row.organizationId === organizationId) ?? null;
}

function canManage(member: MemberRow | null): boolean {
  return !!member && (member.role === "owner" || member.role === "admin");
}

async function requireUser(req: Request, res: Response): Promise<SessionUser | null> {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in first" });
    return null;
  }
  return user;
}

authOrgRouter.get("/organizations", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getDb();
  const memberships = await membershipsOf(db, user.id);
  const orgIds = memberships.map(m => m.organizationId);
  if (orgIds.length === 0) {
    res.status(200).json({ organizations: [] });
    return;
  }
  const cond = inArray(db.schema.authOrganizations.id, orgIds);
  const orgs = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authOrganizations).where(cond).all()
      : await db.db.select().from(db.schema.authOrganizations).where(cond)
  ) as { id: string; name: string }[];
  res.status(200).json({
    organizations: orgs.map(org => ({
      _id: org.id,
      name: org.name,
      role: memberships.find(m => m.organizationId === org.id)?.role ?? "member",
    })),
  });
});

authOrgRouter.get("/organizations/:orgId/members", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const orgId = req.params.orgId!;
  const db = getDb();
  if (!(await memberIn(db, user.id, orgId))) {
    res.status(403).json({ error: "Not a member of this organization" });
    return;
  }
  const cond = eq(db.schema.authMembers.organizationId, orgId);
  const members = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).where(cond).all()
      : await db.db.select().from(db.schema.authMembers).where(cond)
  ) as MemberRow[];
  const userCond = inArray(db.schema.authUsers.id, members.map(m => m.userId));
  const users = (
    members.length
      ? db.kind === "sqlite"
        ? db.db.select().from(db.schema.authUsers).where(userCond).all()
        : await db.db.select().from(db.schema.authUsers).where(userCond)
      : []
  ) as { id: string; email: string; name: string | null }[];
  const byId = new Map(users.map(u => [u.id, u]));
  res.status(200).json({
    members: members.map(m => ({
      _id: m.id,
      userId: m.userId,
      email: byId.get(m.userId)?.email ?? null,
      name: byId.get(m.userId)?.name ?? null,
      role: m.role ?? "member",
    })),
  });
});

authOrgRouter.post("/organizations/:orgId/invitations", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const orgId = req.params.orgId!;
  const db = getDb();
  if (!canManage(await memberIn(db, user.id, orgId))) {
    res.status(403).json({ error: "Only an owner or admin can invite members" });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  const role = req.body?.role === "admin" ? "admin" : "member";
  const row = {
    id: nanoid(24),
    organizationId: orgId,
    email,
    role,
    status: "pending",
    expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    createdAt: new Date(),
    inviterId: user.id,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.authInvitations).values(row);
  } else {
    await db.db.insert(db.schema.authInvitations).values(row);
  }
  // The path the dashboard's accept page mounts at; PUBLIC_URL makes the link shareable
  // beyond localhost when configured (the cloud deployment always sets it).
  const base = (process.env.AGENTX_PUBLIC_URL || "").replace(/\/$/, "");
  const url = `${base}/accept-invite?token=${row.id}`;
  // With a mailer configured the invitee gets the link directly; the response still carries it
  // either way so the inviter can always hand it over out-of-band.
  if (mailerConfigured()) {
    const orgCond = eq(db.schema.authOrganizations.id, orgId);
    const org = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.authOrganizations).where(orgCond).all()[0]
        : (await db.db.select().from(db.schema.authOrganizations).where(orgCond))[0]
    ) as { name: string } | undefined;
    sendMailInBackground({
      to: email,
      subject: `You've been invited to ${org?.name ?? "an AgentX organization"}`,
      text: `${user.name || user.email} invited you to join ${org?.name ?? "their organization"} on AgentX as a ${role}.\n\nAccept here (sign in or create an account with this email first): ${url}\n\nThe link expires in 7 days.`,
    });
  }
  res.status(201).json({
    invitation: { _id: row.id, email, role, expiresAt: row.expiresAt.toISOString() },
    url,
  });
});

type InvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
};

async function getInvitation(db: Db, id: string): Promise<InvitationRow | null> {
  const cond = eq(db.schema.authInvitations.id, id);
  const row = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authInvitations).where(cond).all()[0]
      : (await db.db.select().from(db.schema.authInvitations).where(cond))[0]
  ) as InvitationRow | undefined;
  return row ?? null;
}

authOrgRouter.get("/invitations/:id", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getDb();
  const invitation = await getInvitation(db, req.params.id!);
  if (!invitation) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  const orgCond = eq(db.schema.authOrganizations.id, invitation.organizationId);
  const org = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authOrganizations).where(orgCond).all()[0]
      : (await db.db.select().from(db.schema.authOrganizations).where(orgCond))[0]
  ) as { name: string } | undefined;
  res.status(200).json({
    invitation: {
      _id: invitation.id,
      organizationName: org?.name ?? "an organization",
      email: invitation.email,
      role: invitation.role ?? "member",
      status: new Date(invitation.expiresAt).getTime() < Date.now() ? "expired" : invitation.status,
      emailMatches: invitation.email === user.email.toLowerCase(),
    },
  });
});

authOrgRouter.post("/invitations/:id/accept", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const db = getDb();
  const invitation = await getInvitation(db, req.params.id!);
  if (!invitation || invitation.status !== "pending") {
    res.status(404).json({ error: "Invitation not found or already used" });
    return;
  }
  if (new Date(invitation.expiresAt).getTime() < Date.now()) {
    res.status(410).json({ error: "Invitation expired - ask for a new one" });
    return;
  }
  if (invitation.email !== user.email.toLowerCase()) {
    res.status(403).json({ error: `This invitation was issued to ${invitation.email} - sign in with that account` });
    return;
  }
  if (!(await memberIn(db, user.id, invitation.organizationId))) {
    const memberRow = {
      id: nanoid(),
      organizationId: invitation.organizationId,
      userId: user.id,
      role: invitation.role ?? "member",
      createdAt: new Date(),
    };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.authMembers).values(memberRow);
    } else {
      await db.db.insert(db.schema.authMembers).values(memberRow);
    }
  }
  const cond = eq(db.schema.authInvitations.id, invitation.id);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.authInvitations).set({ status: "accepted" }).where(cond);
  } else {
    await db.db.update(db.schema.authInvitations).set({ status: "accepted" }).where(cond);
  }
  res.status(200).json({ ok: true, organizationId: invitation.organizationId });
});

// Owner-only, typed-name-confirmed, irreversible - the standard danger-zone contract.
authOrgRouter.delete("/organizations/:orgId", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const orgId = req.params.orgId!;
  const db = getDb();
  const member = await memberIn(db, user.id, orgId);
  if (member?.role !== "owner") {
    res.status(403).json({ error: "Only the owner can delete an organization" });
    return;
  }
  const orgCond = eq(db.schema.authOrganizations.id, orgId);
  const org = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authOrganizations).where(orgCond).all()[0]
      : (await db.db.select().from(db.schema.authOrganizations).where(orgCond))[0]
  ) as { name: string } | undefined;
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }
  if (req.body?.confirmName !== org.name) {
    res.status(400).json({ error: `Type the organization name ("${org.name}") as confirmName to confirm deletion` });
    return;
  }
  const result = await deleteOrganization(db, orgId);
  res.status(200).json({ ok: true, ...result });
});

authOrgRouter.delete("/organizations/:orgId/members/:memberId", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const orgId = req.params.orgId!;
  const db = getDb();
  if (!canManage(await memberIn(db, user.id, orgId))) {
    res.status(403).json({ error: "Only an owner or admin can remove members" });
    return;
  }
  const cond = and(eq(db.schema.authMembers.id, req.params.memberId!), eq(db.schema.authMembers.organizationId, orgId));
  const target = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.authMembers).where(cond).all()[0]
      : (await db.db.select().from(db.schema.authMembers).where(cond))[0]
  ) as MemberRow | undefined;
  if (!target) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (target.role === "owner") {
    res.status(400).json({ error: "The owner cannot be removed" });
    return;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.authMembers).where(cond);
  } else {
    await db.db.delete(db.schema.authMembers).where(cond);
  }
  res.status(200).json({ ok: true });
});
