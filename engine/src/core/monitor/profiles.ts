import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getMonitoringDefaults, type MonitoringDefaults } from "../project/projects.js";

// Matches AgentX-Python's MonitorProfile field aliases (agentx/monitor/models.py) and the
// AGENTX_selfhost PUT payload shape client.monitor.profile.update(agent_id, ...) sends (same
// field names as the hosted SaaS's PUT /agentMonitoring/profiles/:agentId, see
// AgentX-web-api/src/helpers/agentMonitoringProfileHelpers.ts's allowlist).
export const DEFAULT_LATENCY_THRESHOLD_MS = 20000;

export type ProfileRow = {
  id: string;
  agentId: string;
  projectId: string | null;
  enabled: boolean;
  failureDetectionEnabled: boolean;
  infoDetectionEnabled: boolean;
  // Opt-in (default false) - see core/monitor/topics.ts's runClassification for what this gates.
  topicsEnabled: boolean;
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  redactionMode: string;
  thresholdOverrides: Record<string, unknown> | null;
  approvalPolicy: Record<string, string> | null;
  channels: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

// Matches AgentX-web-front's AgentMonitoringProfile type (src/types/agentMonitoring.ts).
// billingMode/pausedForCredits are hosted-SaaS-only concepts (Monitor coverage there is metered
// against workspace credits) with no self-host equivalent; always reporting "credits"/false
// keeps the dashboard's settings dialog rendering sensibly instead of needing a self-host-only
// branch there.
//
// coverageMode/sampleRate/retentionDays/redactionMode/thresholdOverrides.latencyMs are no longer
// read from `row` for any actual behavior (see core/project/projects.ts's MonitoringDefaults) -
// they moved to project-level Settings. Still returned here, overlaid from `defaults`, so the SDK
// and any remaining per-agent reader see the *effective* values rather than a stale per-agent copy
// (and so AgentX-Python's MonitorProfile model, which still expects these fields, keeps working
// unchanged).
function toWire(row: ProfileRow, defaults: MonitoringDefaults) {
  return {
    _id: row.id,
    workspaceId: "local",
    agentId: row.agentId,
    enabled: row.enabled,
    failureDetectionEnabled: row.failureDetectionEnabled,
    infoDetectionEnabled: row.infoDetectionEnabled,
    topicsEnabled: row.topicsEnabled,
    coverageMode: defaults.coverageMode,
    sampleRate: defaults.sampleRate,
    channels: row.channels ?? [],
    retentionDays: defaults.retentionDays,
    redactionMode: defaults.redactionMode,
    thresholdOverrides: { ...(row.thresholdOverrides ?? {}), latencyMs: defaults.latencyThresholdMs },
    billingMode: "credits" as const,
    pausedForCredits: false,
    approvalPolicy: row.approvalPolicy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getProfileRow(db: Db, agentId: string): Promise<ProfileRow | null> {
  const cond = and(eq(db.schema.monitorProfiles.agentId, agentId), eq(db.schema.monitorProfiles.projectId, db.projectId));
  let row: ProfileRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorProfiles).where(cond).all()[0] as ProfileRow | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorProfiles).where(cond))[0] as ProfileRow | undefined;
  }
  return row ?? null;
}

export async function getProfile(db: Db, agentId: string) {
  const row = await getProfileRow(db, agentId);
  if (!row) {
    return null;
  }
  return toWire(row, await getMonitoringDefaults(db));
}

export type UpdateProfileInput = Partial<{
  enabled: boolean;
  failureDetectionEnabled: boolean;
  infoDetectionEnabled: boolean;
  topicsEnabled: boolean;
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  redactionMode: string;
  thresholdOverrides: Record<string, unknown>;
  approvalPolicy: Record<string, string>;
  channels: string[];
}>;

// Upsert: an agent that's never been configured gets a profile on its first PUT, matching the
// hosted SaaS's findOneAndUpdate(..., { upsert: true }) behavior.
export async function updateProfile(db: Db, agentId: string, patch: UpdateProfileInput) {
  const existing = await getProfileRow(db, agentId);
  const now = new Date();

  if (!existing) {
    const row: ProfileRow = {
      id: nanoid(),
      agentId,
      projectId: db.projectId,
      enabled: patch.enabled ?? true,
      failureDetectionEnabled: patch.failureDetectionEnabled ?? true,
      infoDetectionEnabled: patch.infoDetectionEnabled ?? true,
      topicsEnabled: patch.topicsEnabled ?? false,
      coverageMode: patch.coverageMode ?? "all",
      sampleRate: patch.sampleRate ?? 1,
      retentionDays: patch.retentionDays ?? 30,
      redactionMode: patch.redactionMode ?? "standard",
      thresholdOverrides: patch.thresholdOverrides ?? null,
      approvalPolicy: patch.approvalPolicy ?? null,
      channels: patch.channels ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.monitorProfiles).values(row);
    } else {
      await db.db.insert(db.schema.monitorProfiles).values(row);
    }
    return toWire(row, await getMonitoringDefaults(db));
  }

  const updated: ProfileRow = {
    ...existing,
    enabled: patch.enabled ?? existing.enabled,
    failureDetectionEnabled: patch.failureDetectionEnabled ?? existing.failureDetectionEnabled,
    infoDetectionEnabled: patch.infoDetectionEnabled ?? existing.infoDetectionEnabled,
    topicsEnabled: patch.topicsEnabled ?? existing.topicsEnabled,
    coverageMode: patch.coverageMode ?? existing.coverageMode,
    sampleRate: patch.sampleRate ?? existing.sampleRate,
    retentionDays: patch.retentionDays ?? existing.retentionDays,
    redactionMode: patch.redactionMode ?? existing.redactionMode,
    thresholdOverrides: patch.thresholdOverrides
      ? { ...(existing.thresholdOverrides ?? {}), ...patch.thresholdOverrides }
      : existing.thresholdOverrides,
    approvalPolicy: patch.approvalPolicy ? { ...(existing.approvalPolicy ?? {}), ...patch.approvalPolicy } : existing.approvalPolicy,
    channels: patch.channels ?? existing.channels,
    updatedAt: now,
  };
  const setValues = {
    enabled: updated.enabled,
    failureDetectionEnabled: updated.failureDetectionEnabled,
    infoDetectionEnabled: updated.infoDetectionEnabled,
    topicsEnabled: updated.topicsEnabled,
    coverageMode: updated.coverageMode,
    sampleRate: updated.sampleRate,
    retentionDays: updated.retentionDays,
    redactionMode: updated.redactionMode,
    thresholdOverrides: updated.thresholdOverrides,
    approvalPolicy: updated.approvalPolicy,
    channels: updated.channels,
    updatedAt: updated.updatedAt,
  };
  const updateCond = and(eq(db.schema.monitorProfiles.agentId, agentId), eq(db.schema.monitorProfiles.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorProfiles).set(setValues).where(updateCond);
  } else {
    await db.db.update(db.schema.monitorProfiles).set(setValues).where(updateCond);
  }
  return toWire(updated, await getMonitoringDefaults(db));
}

export async function listProfileRows(db: Db): Promise<ProfileRow[]> {
  const cond = eq(db.schema.monitorProfiles.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorProfiles).where(cond).all()
      : await db.db.select().from(db.schema.monitorProfiles).where(cond);
  return rows as ProfileRow[];
}

export async function listProfilesWire(db: Db) {
  const [rows, defaults] = await Promise.all([listProfileRows(db), getMonitoringDefaults(db)]);
  return rows.map(row => toWire(row, defaults));
}

// Resolves the latency threshold the built-in "Latency regression" check uses. Project-level
// (see core/project/projects.ts's MonitoringDefaults) - no longer a per-agent override.
// DEFAULT_LATENCY_THRESHOLD_MS is only reachable pre-migration/as a defensive fallback, the
// `latency_threshold_ms` column itself already defaults to the same value.
export async function resolveLatencyThresholdMs(db: Db): Promise<number> {
  const defaults = await getMonitoringDefaults(db);
  return defaults.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
}
