import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Matches AgentX-Python's MonitorProfile field aliases (agentx/monitor/models.py) and the
// AGENTX_selfhost PUT payload shape client.monitor.profile.update(agent_id, ...) sends (same
// field names as the hosted SaaS's PUT /agentMonitoring/profiles/:agentId, see
// AgentX-web-api/src/helpers/agentMonitoringProfileHelpers.ts's allowlist).
export const DEFAULT_LATENCY_THRESHOLD_MS = 20000;

export type ProfileRow = {
  id: string;
  agentId: string;
  enabled: boolean;
  failureDetectionEnabled: boolean;
  infoDetectionEnabled: boolean;
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  redactionMode: string;
  thresholdOverrides: Record<string, unknown> | null;
  approvalPolicy: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
};

function toWire(row: ProfileRow) {
  return {
    _id: row.id,
    agentId: row.agentId,
    enabled: row.enabled,
    failureDetectionEnabled: row.failureDetectionEnabled,
    infoDetectionEnabled: row.infoDetectionEnabled,
    coverageMode: row.coverageMode,
    sampleRate: row.sampleRate,
    retentionDays: row.retentionDays,
    redactionMode: row.redactionMode,
    thresholdOverrides: row.thresholdOverrides ?? undefined,
    approvalPolicy: row.approvalPolicy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getProfileRow(db: Db, agentId: string): Promise<ProfileRow | null> {
  let row: ProfileRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorProfiles).where(eq(db.schema.monitorProfiles.agentId, agentId)).all()[0] as
      | ProfileRow
      | undefined;
  } else {
    row = (
      await db.db.select().from(db.schema.monitorProfiles).where(eq(db.schema.monitorProfiles.agentId, agentId))
    )[0] as ProfileRow | undefined;
  }
  return row ?? null;
}

export async function getProfile(db: Db, agentId: string) {
  const row = await getProfileRow(db, agentId);
  return row ? toWire(row) : null;
}

export type UpdateProfileInput = Partial<{
  enabled: boolean;
  failureDetectionEnabled: boolean;
  infoDetectionEnabled: boolean;
  coverageMode: string;
  sampleRate: number;
  retentionDays: number;
  redactionMode: string;
  thresholdOverrides: Record<string, unknown>;
  approvalPolicy: Record<string, string>;
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
      enabled: patch.enabled ?? true,
      failureDetectionEnabled: patch.failureDetectionEnabled ?? true,
      infoDetectionEnabled: patch.infoDetectionEnabled ?? true,
      coverageMode: patch.coverageMode ?? "all",
      sampleRate: patch.sampleRate ?? 1,
      retentionDays: patch.retentionDays ?? 30,
      redactionMode: patch.redactionMode ?? "standard",
      thresholdOverrides: patch.thresholdOverrides ?? null,
      approvalPolicy: patch.approvalPolicy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.monitorProfiles).values(row);
    } else {
      await db.db.insert(db.schema.monitorProfiles).values(row);
    }
    return toWire(row);
  }

  const updated: ProfileRow = {
    ...existing,
    enabled: patch.enabled ?? existing.enabled,
    failureDetectionEnabled: patch.failureDetectionEnabled ?? existing.failureDetectionEnabled,
    infoDetectionEnabled: patch.infoDetectionEnabled ?? existing.infoDetectionEnabled,
    coverageMode: patch.coverageMode ?? existing.coverageMode,
    sampleRate: patch.sampleRate ?? existing.sampleRate,
    retentionDays: patch.retentionDays ?? existing.retentionDays,
    redactionMode: patch.redactionMode ?? existing.redactionMode,
    thresholdOverrides: patch.thresholdOverrides
      ? { ...(existing.thresholdOverrides ?? {}), ...patch.thresholdOverrides }
      : existing.thresholdOverrides,
    approvalPolicy: patch.approvalPolicy ? { ...(existing.approvalPolicy ?? {}), ...patch.approvalPolicy } : existing.approvalPolicy,
    updatedAt: now,
  };
  const setValues = {
    enabled: updated.enabled,
    failureDetectionEnabled: updated.failureDetectionEnabled,
    infoDetectionEnabled: updated.infoDetectionEnabled,
    coverageMode: updated.coverageMode,
    sampleRate: updated.sampleRate,
    retentionDays: updated.retentionDays,
    redactionMode: updated.redactionMode,
    thresholdOverrides: updated.thresholdOverrides,
    approvalPolicy: updated.approvalPolicy,
    updatedAt: updated.updatedAt,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorProfiles).set(setValues).where(eq(db.schema.monitorProfiles.agentId, agentId));
  } else {
    await db.db.update(db.schema.monitorProfiles).set(setValues).where(eq(db.schema.monitorProfiles.agentId, agentId));
  }
  return toWire(updated);
}

// Resolves the latency threshold this agent's built-in "Latency regression" check uses: the
// agent's own override if set, otherwise the platform default. Mirrors
// AgentX-web-api/src/services/agentMonitoringService.ts's DEFAULT_LATENCY_THRESHOLD_MS fallback.
export async function resolveLatencyThresholdMs(db: Db, agentId: string): Promise<number> {
  const row = await getProfileRow(db, agentId);
  const override = row?.thresholdOverrides?.latencyMs;
  return typeof override === "number" ? override : DEFAULT_LATENCY_THRESHOLD_MS;
}
