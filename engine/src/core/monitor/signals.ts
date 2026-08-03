import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listOccurrencesForSignal, type EventRow } from "./events.js";

// Matches AgentX-Python's MonitorSignal field aliases (agentx/monitor/models.py).
export type SignalRow = {
  id: string;
  patternKey: string;
  type: string;
  severity: string;
  polarity: string;
  status: string;
  reviewStatus: string | null;
  recommendedActions: string[] | null;
  summary: string;
  rootCause: string | null;
  agentId: string | null;
  traceId: string | null;
  evidence: Record<string, unknown> | null;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

// Serves both AgentX-Python's MonitorSignal (agentx/monitor/models.py) and AgentX-web-front's
// AgentMonitoringSignal (src/types/agentMonitoring.ts) — workspaceId/createdAt/updatedAt are
// required by the latter but not the former; self-host has no separate created-vs-first-seen
// timestamp to report, so createdAt/updatedAt alias firstSeenAt/lastSeenAt.
//
// `occurrences` is optional here (populated by the two callers below via listOccurrencesForSignal
// — a DB round-trip toWire() itself can't do since it's a sync function) — AgentX-web-front's
// SignalRow.tsx renders exactly this array as the per-occurrence list under "N occurrences"; a
// missing/empty array there silently collapses to a single synthesized fallback row, which is the
// "shows 4 occurrences but only 1 in the list" bug this closes.
function toWire(row: SignalRow, occurrences: EventRow[] = []) {
  return {
    _id: row.id,
    workspaceId: "local",
    patternKey: row.patternKey,
    type: row.type,
    severity: row.severity,
    polarity: row.polarity,
    status: row.status,
    reviewStatus: row.reviewStatus ?? undefined,
    recommendedActions: row.recommendedActions ?? undefined,
    summary: row.summary,
    rootCause: row.rootCause ?? undefined,
    // AgentX-Python's MonitorSignal.agent_id expects the hosted SaaS's populated shape
    // ({_id, name, avatar}, from Mongoose .populate("agentId", "name avatar")), not a bare
    // string. Self-host has no agent registry to populate from, so agentId doubles as both.
    agentId: row.agentId ? { _id: row.agentId, name: row.agentId } : undefined,
    evidence: row.evidence ?? undefined,
    occurrenceCount: row.occurrenceCount,
    // Matches AgentMonitoringSignalOccurrence's shape (types/agentMonitoring.ts): self-host has no
    // conversationId/messageId (native-chat-only concepts), but does have a real traceId/agentId
    // per detection.
    occurrences: occurrences.map(e => ({
      agentId: e.agentId ? { _id: e.agentId, name: e.agentId } : undefined,
      traceId: e.traceId ?? undefined,
      seenAt: e.createdAt.toISOString(),
    })),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.firstSeenAt.toISOString(),
    updatedAt: row.lastSeenAt.toISOString(),
  };
}

export type DetectedSignal = {
  type: string;
  severity: string;
  polarity?: string;
  summary: string;
  patternKey: string;
  rootCause?: string;
};

// Upsert deduped by (patternKey, agentId): a re-detected issue for the same pattern/agent
// increments occurrenceCount and bumps lastSeenAt instead of creating a new row, mirroring the
// hosted SaaS's upsertMonitoringSignal (agentMonitoringService.ts).
export async function upsertSignal(
  db: Db,
  detected: DetectedSignal,
  ctx: { agentId?: string | null; traceId?: string | null; evidence?: Record<string, unknown> }
) {
  const agentId = ctx.agentId ?? null;
  // eq(col, "") would never match a real NULL column value (SQL's NULL isn't equal to anything,
  // including ""), silently breaking dedup for any signal with no agentId, so a separate isNull
  // branch is needed here rather than coercing null to "".
  const cond = and(
    eq(db.schema.monitorSignals.patternKey, detected.patternKey),
    agentId === null ? isNull(db.schema.monitorSignals.agentId) : eq(db.schema.monitorSignals.agentId, agentId)
  );

  const existing =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.monitorSignals).where(cond).all()[0] as SignalRow | undefined)
      : ((await db.db.select().from(db.schema.monitorSignals).where(cond))[0] as SignalRow | undefined);

  const now = new Date();

  if (!existing) {
    const row: SignalRow = {
      id: nanoid(),
      patternKey: detected.patternKey,
      type: detected.type,
      severity: detected.severity,
      polarity: detected.polarity ?? "failure",
      status: "open",
      reviewStatus: null,
      recommendedActions: null,
      summary: detected.summary,
      rootCause: detected.rootCause ?? null,
      agentId,
      traceId: ctx.traceId ?? null,
      evidence: ctx.evidence ?? null,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.monitorSignals).values(row);
    } else {
      await db.db.insert(db.schema.monitorSignals).values(row);
    }
    return toWire(row);
  }

  const updated: SignalRow = {
    ...existing,
    summary: detected.summary,
    severity: detected.severity,
    traceId: ctx.traceId ?? existing.traceId,
    evidence: ctx.evidence ?? existing.evidence,
    occurrenceCount: existing.occurrenceCount + 1,
    lastSeenAt: now,
  };
  const setValues = {
    summary: updated.summary,
    severity: updated.severity,
    traceId: updated.traceId,
    evidence: updated.evidence,
    occurrenceCount: updated.occurrenceCount,
    lastSeenAt: updated.lastSeenAt,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(cond);
  } else {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(cond);
  }
  return toWire(updated);
}

export async function listSignalRows(db: Db): Promise<SignalRow[]> {
  const rows =
    db.kind === "sqlite" ? db.db.select().from(db.schema.monitorSignals).all() : await db.db.select().from(db.schema.monitorSignals);
  return rows as SignalRow[];
}

export async function listSignals(
  db: Db,
  filter: { severity?: string; status?: string; agentId?: string; polarity?: string } = {},
  limit = 50
) {
  const rows = await listSignalRows(db);
  let filtered = rows;
  if (filter.severity) filtered = filtered.filter(r => r.severity === filter.severity);
  if (filter.status) filtered = filtered.filter(r => r.status === filter.status);
  if (filter.agentId) filtered = filtered.filter(r => r.agentId === filter.agentId);
  // Matches the hosted SaaS/SDK docs' documented default ("failures only" unless polarity is
  // passed): unfiltered defaults to "failure" rather than returning everything, so the
  // "healthy-response" tally runMonitorCheck now records (see detect.ts) doesn't show up in
  // existing triage views (dashboard or `client.monitor.signals.list()`) that predate its
  // existence and never pass polarity at all. Explicit "all" opts into both.
  const effectivePolarity = filter.polarity ?? "failure";
  if (effectivePolarity !== "all") filtered = filtered.filter(r => r.polarity === effectivePolarity);
  filtered.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  const page = filtered.slice(0, limit);
  return Promise.all(page.map(async row => toWire(row, await listOccurrencesForSignal(db, row.id))));
}

export async function getSignal(db: Db, id: string) {
  let row: SignalRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorSignals).where(eq(db.schema.monitorSignals.id, id)).all()[0] as
      | SignalRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorSignals).where(eq(db.schema.monitorSignals.id, id)))[0] as
      | SignalRow
      | undefined;
  }
  return row ? toWire(row, await listOccurrencesForSignal(db, row.id)) : null;
}

export async function getSignalRow(db: Db, id: string): Promise<SignalRow | null> {
  let row: SignalRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorSignals).where(eq(db.schema.monitorSignals.id, id)).all()[0] as
      | SignalRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorSignals).where(eq(db.schema.monitorSignals.id, id)))[0] as
      | SignalRow
      | undefined;
  }
  return row ?? null;
}

export type UpdateSignalInput = Partial<{
  status: string;
  severity: string;
  reviewStatus: string;
  recommendedActions: string[];
}>;

// Every current caller (SignalRow.tsx in AgentX-web-front) only ever sends `status`
// (triaged/resolved) — severity/reviewStatus/recommendedActions are part of the frontend's type
// contract but have no live caller yet, see the investigation this was scoped from. Accepted here
// anyway since it costs nothing extra to support the full contract.
export async function updateSignal(db: Db, id: string, patch: UpdateSignalInput) {
  const existing = await getSignalRow(db, id);
  if (!existing) {
    return null;
  }
  const updated: SignalRow = {
    ...existing,
    status: patch.status ?? existing.status,
    severity: patch.severity ?? existing.severity,
    reviewStatus: patch.reviewStatus ?? existing.reviewStatus,
    recommendedActions: patch.recommendedActions ?? existing.recommendedActions,
  };
  const setValues = {
    status: updated.status,
    severity: updated.severity,
    reviewStatus: updated.reviewStatus,
    recommendedActions: updated.recommendedActions,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(eq(db.schema.monitorSignals.id, id));
  } else {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(eq(db.schema.monitorSignals.id, id));
  }
  return toWire(updated);
}
