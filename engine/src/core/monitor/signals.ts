import { nanoid } from "nanoid";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listOccurrencesForSignal, extractText, type EventRow } from "./events.js";
import { logger } from "../../log.js";
import { getTraceRow } from "../trace/ingest.js";
import { getAgentNamesById } from "./agents.js";

// Matches AgentX-Python's MonitorSignal field aliases (agentx/monitor/models.py).
export type SignalRow = {
  id: string;
  projectId: string | null;
  patternKey: string;
  type: string;
  severity: string;
  polarity: string;
  status: string;
  reviewStatus: string | null;
  // "fixed" | "false_positive" | "wont_fix" while status is resolved; null otherwise.
  resolutionReason: string | null;
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
// AgentMonitoringSignal (src/types/agentMonitoring.ts) - workspaceId/createdAt/updatedAt are
// required by the latter but not the former; self-host has no separate created-vs-first-seen
// timestamp to report, so createdAt/updatedAt alias firstSeenAt/lastSeenAt.
//
// `occurrences` is optional here (populated by the two callers below via listOccurrencesForSignal
// - a DB round-trip toWire() itself can't do since it's a sync function) - AgentX-web-front's
// SignalRow.tsx renders exactly this array as the per-occurrence list under "N occurrences"; a
// missing/empty array there silently collapses to a single synthesized fallback row, which is the
// "shows 4 occurrences but only 1 in the list" bug this closes.
//
// occurrenceEvidence (keyed by event id) is a separate, optional pass: upsertSignal overwrites the
// signal's own summary/evidence on every repeat match (last-write-wins, see upsertSignal below), so
// occurrence #1 and #2's captured text is otherwise gone the moment #3 arrives - only getSignal
// (one signal, bounded cost) resolves it via resolveOccurrenceEvidence; listSignals (whole table,
// unbounded) intentionally doesn't, to avoid an N-signals x M-occurrences trace-join on every table
// load. rating/justification are cheap either way (already columns on the event row).
type OccurrenceEvidence = { query?: string; responsePreview?: string };

function toWire(
  row: SignalRow,
  occurrences: EventRow[] = [],
  occurrenceEvidence?: Map<string, OccurrenceEvidence>,
  agentNamesById?: Map<string, string>
) {
  return {
    _id: row.id,
    workspaceId: "local",
    patternKey: row.patternKey,
    type: row.type,
    severity: row.severity,
    polarity: row.polarity,
    status: row.status,
    reviewStatus: row.reviewStatus ?? undefined,
    resolutionReason: row.resolutionReason ?? undefined,
    recommendedActions: row.recommendedActions ?? undefined,
    summary: row.summary,
    rootCause: row.rootCause ?? undefined,
    // AgentX-Python's MonitorSignal.agent_id expects the hosted SaaS's populated shape
    // ({_id, name, avatar}, from Mongoose .populate("agentId", "name avatar")), not a bare
    // string. Self-host now has a real registry (core/monitor/agents.ts) - name resolved via the
    // batch lookup callers pass in, falling back to the id itself if somehow not found.
    agentId: row.agentId ? { _id: row.agentId, name: agentNamesById?.get(row.agentId) ?? row.agentId } : undefined,
    evidence: row.evidence ?? undefined,
    occurrenceCount: row.occurrenceCount,
    // Matches AgentMonitoringSignalOccurrence's shape (types/agentMonitoring.ts): self-host has no
    // conversationId/messageId (native-chat-only concepts), but does have a real traceId/agentId
    // per detection.
    occurrences: occurrences.map(e => ({
      id: e.id,
      agentId: e.agentId ? { _id: e.agentId, name: agentNamesById?.get(e.agentId) ?? e.agentId } : undefined,
      traceId: e.traceId ?? undefined,
      // Non-null for session-scoped verdicts (sessionSweep's dual-write): the finding is about the
      // whole conversation, traceId is just its last-root-trace anchor - the dashboard links the
      // session instead of the trace when this is set.
      sessionId: e.sessionId ?? undefined,
      seenAt: e.createdAt.toISOString(),
      query: occurrenceEvidence?.get(e.id)?.query,
      responsePreview: occurrenceEvidence?.get(e.id)?.responsePreview,
      rating: e.rating ?? undefined,
      justification: e.justification ?? undefined,
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
    agentId === null ? isNull(db.schema.monitorSignals.agentId) : eq(db.schema.monitorSignals.agentId, agentId),
    eq(db.schema.monitorSignals.projectId, db.projectId)
  );

  const existing =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.monitorSignals).where(cond).all()[0] as SignalRow | undefined)
      : ((await db.db.select().from(db.schema.monitorSignals).where(cond))[0] as SignalRow | undefined);

  const now = new Date();

  if (!existing) {
    const row: SignalRow = {
      id: nanoid(),
      projectId: db.projectId,
      patternKey: detected.patternKey,
      type: detected.type,
      severity: detected.severity,
      polarity: detected.polarity ?? "failure",
      status: "open",
      reviewStatus: null,
      resolutionReason: null,
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
    // The SELECT above and this INSERT are two statements, so a burst of traces raising the same
    // signal all arrive having seen no row; on Postgres one then violated
    // monitor_signals_pattern_key_agent_id and that detection was lost to a log line. Losing the
    // insert just means someone else created the row - fall through and count against theirs.
    // Signals with no agentId still dedup through the SELECT alone (NULL never conflicts with
    // NULL), unchanged; every signal raised for a real trace has an agent.
    const inserted = (
      db.kind === "sqlite"
        ? db.db.insert(db.schema.monitorSignals).values(row).onConflictDoNothing().returning({ id: db.schema.monitorSignals.id }).all()
        : await db.db.insert(db.schema.monitorSignals).values(row).onConflictDoNothing().returning({ id: db.schema.monitorSignals.id })
    ) as { id: string }[];
    if (inserted[0]) {
      return toWire(row, [], undefined, await getAgentNamesById(db, [row.agentId]));
    }
  }

  // Incremented by the database, not written back from a number read a moment ago: twelve
  // concurrent detections were reported as five, and that count is what operators triage by.
  // RETURNING gives the post-update row without a second read.
  const setValues = {
    summary: detected.summary,
    severity: detected.severity,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx.evidence ? { evidence: ctx.evidence } : {}),
    // Incremented by the database, not read-modify-written here: two checks detecting the same
    // signal at once would otherwise both write the same count and lose one sighting.
    occurrenceCount: sql`${db.schema.monitorSignals.occurrenceCount} + 1`,
    lastSeenAt: now,
    // A closed signal is a shelf, not a grave: re-firing reopens it into the active list
    // whether it was archived OR resolved - a "fixed" claim that recurs is a regression, the
    // single most important thing to surface (Sentry's regressed semantics). The resolution
    // reason clears on reopen; every other status keeps the operator's triage decision.
    ...(existing && (existing.status === "archived" || existing.status === "resolved")
      ? { status: "reopened", resolutionReason: null }
      : { status: existing?.status ?? "open" }),
  };
  // A resolved-as-FIXED signal re-firing is free ops ground truth: the fix claim was wrong.
  // Recorded as a negative outcome on the recurring trace so judge calibration sees it, same
  // stream client.outcomes.report feeds by hand.
  if (existing?.status === "resolved" && existing.resolutionReason === "fixed" && ctx.traceId) {
    const { createOutcomeReport } = await import("../outcomes/outcomeReports.js");
    await createOutcomeReport(db, {
      traceId: ctx.traceId,
      outcome: "signal_regressed",
      isNegative: true,
      reason: `"${existing.summary.slice(0, 140)}" was resolved as fixed but fired again`,
      reportedBy: "engine:signal-regression",
    }).catch(() => undefined);
  }
  const updatedRows = (
    db.kind === "sqlite"
      ? db.db.update(db.schema.monitorSignals).set(setValues).where(cond).returning().all()
      : await db.db.update(db.schema.monitorSignals).set(setValues).where(cond).returning()
  ) as SignalRow[];

  // A row existed a statement ago, so an empty RETURNING means something deleted it in between.
  // Report what this call knows rather than throwing inside a background check nobody awaits.
  const updated: SignalRow = updatedRows[0] ?? {
    id: existing?.id ?? nanoid(),
    projectId: db.projectId,
    patternKey: detected.patternKey,
    type: detected.type,
    severity: detected.severity,
    polarity: detected.polarity ?? "failure",
    status:
      existing && (existing.status === "archived" || existing.status === "resolved")
        ? "reopened"
        : (existing?.status ?? "open"),
    reviewStatus: existing?.reviewStatus ?? null,
    recommendedActions: existing?.recommendedActions ?? null,
    resolutionReason:
      existing && (existing.status === "archived" || existing.status === "resolved")
        ? null
        : (existing?.resolutionReason ?? null),
    summary: detected.summary,
    rootCause: detected.rootCause ?? existing?.rootCause ?? null,
    agentId,
    traceId: ctx.traceId ?? existing?.traceId ?? null,
    evidence: ctx.evidence ?? existing?.evidence ?? null,
    occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  return toWire(updated, [], undefined, await getAgentNamesById(db, [updated.agentId]));
}

// Per-scorer signal tallies for the catalog's Signals column: how many signal rows each
// pattern/template key has raised (dedup unit: one row per patternKey+agent) and how many are
// still open. Sub-keyed detections ("some-key:<detail>") roll up under their base key. The
// healthy tally and "proper" positive matches are not failures, so they don't count.
export async function signalCountsByPatternKey(db: Db): Promise<Map<string, { total: number; open: number }>> {
  const rows = await listSignalRows(db);
  const counts = new Map<string, { total: number; open: number }>();
  for (const row of rows) {
    if (row.polarity !== "failure" || row.patternKey === "healthy-response") continue;
    const baseKey = row.patternKey.split(":")[0]!;
    const entry = counts.get(baseKey) ?? { total: 0, open: 0 };
    entry.total++;
    if (row.status === "open" || row.status === "reopened") entry.open++;
    counts.set(baseKey, entry);
  }
  return counts;
}

export async function listSignalRows(db: Db): Promise<SignalRow[]> {
  const cond = eq(db.schema.monitorSignals.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorSignals).where(cond).all()
      : await db.db.select().from(db.schema.monitorSignals).where(cond);
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
  const occurrencesByRow = await Promise.all(page.map(row => listOccurrencesForSignal(db, row.id)));
  const agentNamesById = await getAgentNamesById(db, [
    ...page.map(row => row.agentId),
    ...occurrencesByRow.flatMap(occurrences => occurrences.map(e => e.agentId)),
  ]);
  return page.map((row, i) => toWire(row, occurrencesByRow[i], undefined, agentNamesById));
}

// Same trace-join pattern as getOnlineEvaluatorEvents (events.ts) - resolves each occurrence's
// traceId back to its trace to recover the real captured input/output, since the event row itself
// only stores the traceId, not the text. One signal's occurrences at a time (bounded), never the
// whole table - see toWire's OccurrenceEvidence comment for why.
async function resolveOccurrenceEvidence(db: Db, events: EventRow[]): Promise<Map<string, OccurrenceEvidence>> {
  const map = new Map<string, OccurrenceEvidence>();
  await Promise.all(
    events.map(async e => {
      if (!e.traceId) {
        return;
      }
      const trace = await getTraceRow(db, e.traceId);
      if (!trace) {
        return;
      }
      map.set(e.id, { query: extractText(trace.input), responsePreview: extractText(trace.output) });
    })
  );
  return map;
}

export async function getSignal(db: Db, id: string) {
  const cond = and(eq(db.schema.monitorSignals.id, id), eq(db.schema.monitorSignals.projectId, db.projectId));
  let row: SignalRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorSignals).where(cond).all()[0] as SignalRow | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorSignals).where(cond))[0] as SignalRow | undefined;
  }
  if (!row) {
    return null;
  }
  const occurrences = await listOccurrencesForSignal(db, row.id);
  const occurrenceEvidence = await resolveOccurrenceEvidence(db, occurrences);
  const agentNamesById = await getAgentNamesById(db, [row.agentId, ...occurrences.map(e => e.agentId)]);
  return toWire(row, occurrences, occurrenceEvidence, agentNamesById);
}

export async function getSignalRow(db: Db, id: string): Promise<SignalRow | null> {
  const cond = and(eq(db.schema.monitorSignals.id, id), eq(db.schema.monitorSignals.projectId, db.projectId));
  let row: SignalRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorSignals).where(cond).all()[0] as SignalRow | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorSignals).where(cond))[0] as SignalRow | undefined;
  }
  return row ?? null;
}

export type UpdateSignalInput = Partial<{
  status: string;
  severity: string;
  reviewStatus: string;
  recommendedActions: string[];
  resolutionReason: string;
}>;

// Every current caller (SignalRow.tsx in AgentX-web-front) only ever sends `status`
// (triaged/resolved) - severity/reviewStatus/recommendedActions are part of the frontend's type
// contract but have no live caller yet, see the investigation this was scoped from. Accepted here
// anyway since it costs nothing extra to support the full contract.
export async function updateSignal(db: Db, id: string, patch: UpdateSignalInput) {
  const existing = await getSignalRow(db, id);
  if (!existing) {
    return null;
  }
  const nextStatus = patch.status ?? existing.status;
  const updated: SignalRow = {
    ...existing,
    status: nextStatus,
    severity: patch.severity ?? existing.severity,
    reviewStatus: patch.reviewStatus ?? existing.reviewStatus,
    recommendedActions: patch.recommendedActions ?? existing.recommendedActions,
    // The reason travels with resolved and only resolved - set alongside it, kept while
    // resolved, cleared the moment the signal is anything else.
    resolutionReason:
      nextStatus === "resolved" ? (patch.resolutionReason ?? existing.resolutionReason) : null,
  };
  const setValues = {
    status: updated.status,
    severity: updated.severity,
    reviewStatus: updated.reviewStatus,
    recommendedActions: updated.recommendedActions,
    resolutionReason: updated.resolutionReason,
  };
  const updateCond = and(eq(db.schema.monitorSignals.id, id), eq(db.schema.monitorSignals.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(updateCond);
  } else {
    await db.db.update(db.schema.monitorSignals).set(setValues).where(updateCond);
  }

  // Human verdicts on judge-raised signals are calibration ground truth, and BOTH directions
  // are recorded here so no client can forget half the loop:
  //   - Confirm (-> triaged): AGREEMENT - "the flag was right". Symmetric labeling is what makes
  //     calibration honest; recording only disagreements lets a judge accumulate evidence
  //     exclusively against itself.
  //   - Wrong judgement (-> resolved/false_positive): DISAGREEMENT baseline - guaranteed even
  //     when the user closes the correction dialog without writing a rationale. The dialog's
  //     detailed correction lands later on the same event and outranks this row in
  //     judgeTuning.ts (explicit corrections > confirms; latest correction wins).
  // Written once per transition, pinned to the newest occurrence's event so the label pairs
  // with the exact verdict.
  const becameTriaged = nextStatus === "triaged" && existing.status !== "triaged";
  // Auto-improve capture: a Confirm verdict IS the accumulation gesture - the confirmed
  // occurrence lands in the project's "Confirmed failures" improvement group, later spent on an
  // improvement report (core/monitor/improvementGroups.ts). Every failure kind counts (pattern
  // hits and low judge scores alike); non-fatal, a capture hiccup must not fail the triage.
  if (becameTriaged && (existing.polarity ?? "failure") === "failure") {
    try {
      const { captureConfirmedFailure } = await import("./improvementGroups.js");
      const occurrences = await listOccurrencesForSignal(db, id);
      const newest = occurrences[occurrences.length - 1];
      const evidence = (existing.evidence ?? {}) as Record<string, unknown>;
      const asText = (value: unknown): string | null =>
        typeof value === "string" ? value : value == null ? null : JSON.stringify(value);
      await captureConfirmedFailure(db, {
        signalId: id,
        patternKey: existing.patternKey,
        summary: existing.summary,
        scorerName: existing.rootCause ?? null,
        eventId: newest?.id ?? null,
        traceId: newest?.traceId ?? existing.traceId ?? null,
        rating: newest?.rating ?? null,
        judgeRationale: newest?.justification ?? null,
        inputText: asText(evidence.query ?? evidence.input),
        outputText: asText(evidence.responsePreview ?? evidence.output),
      });
    } catch (err) {
      logger.error({ err }, "Failed to capture confirmed failure into the improvement group");
    }
  }
  const becameFalsePositive =
    nextStatus === "resolved" &&
    updated.resolutionReason === "false_positive" &&
    !(existing.status === "resolved" && existing.resolutionReason === "false_positive");
  if ((becameTriaged || becameFalsePositive) && existing.patternKey.startsWith("online-eval:")) {
    const occurrences = await listOccurrencesForSignal(db, id); // createdAt ASC - newest last
    const newest = occurrences[occurrences.length - 1];
    if (newest) {
      const { createFeedback, hasCorrectionForEvent } = await import("./feedback.js");
      // A wrong-judgement resolve that followed the correction dialog already has a richer
      // disagreement row on this event - the canned baseline must not overwrite it.
      if (!becameTriaged && (await hasCorrectionForEvent(db, id, newest.id).catch(() => false))) {
        return toWire(updated);
      }
      await createFeedback(db, id, {
        metric: becameTriaged ? "confirmed" : "false-positive",
        rationale: becameTriaged
          ? "Human confirmed the flagged issue during signal review"
          : "Resolved as wrong judgement during signal review",
        occurrenceId: newest.id,
        originalScore: newest.rating ?? undefined,
      }).catch(() => undefined);
    }
  }
  return toWire(updated);
}
