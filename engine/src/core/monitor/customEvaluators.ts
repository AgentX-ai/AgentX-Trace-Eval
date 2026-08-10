import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { recordEvent } from "./events.js";
import { upsertSignal } from "./signals.js";

// Promoted out of core/monitor/conditions.ts's Pattern-condition "external" detector — same
// call-out-and-await-a-verdict shape as Online Evaluators (onlineEvaluators.ts), just with a URL
// instead of an evaluationSettingsId as the thing being invoked. One Custom Evaluator = one URL,
// no AND/OR/NOR composition the way a Pattern's condition list has — that composition only ever
// made sense for phrase/regex/semantic rows checked against pattern-specific match targets; a
// standalone evaluator just gets the whole trace every time.
export type CreateCustomEvaluatorInput = {
  name: string;
  url: string;
  sampleRate?: number;
  scopeMode?: string;
  agentIds?: string[];
  enabled?: boolean;
  // The endpoint's verdict is a boolean (`matches`), not a numeric rating like an Online
  // Evaluator's judge score — this is the analogous "does a hit raise a Signal" knob, mirroring
  // the old per-condition `negate` flag from the Pattern builder it was extracted from.
  invertMatch?: boolean;
  severity?: string;
};

export type UpdateCustomEvaluatorInput = Partial<CreateCustomEvaluatorInput>;

export type CustomEvaluatorRow = {
  id: string;
  projectId: string | null;
  name: string;
  url: string;
  sampleRate: number;
  scopeMode: string;
  agentIds: unknown;
  enabled: boolean;
  invertMatch: boolean;
  severity: string;
  createdAt: Date;
};

function toWire(row: CustomEvaluatorRow) {
  return {
    _id: row.id,
    name: row.name,
    url: row.url,
    sampleRate: row.sampleRate,
    scopeMode: row.scopeMode,
    agentIds: (row.agentIds as string[] | null) ?? [],
    enabled: row.enabled,
    invertMatch: row.invertMatch,
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createCustomEvaluator(db: Db, input: CreateCustomEvaluatorInput) {
  const row: CustomEvaluatorRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    url: input.url,
    // Same reasoning as Online Evaluators' default: every check is a real outbound HTTP call
    // against a URL the user controls, so sampling isn't optional the way it arguably is for a
    // free phrase/regex match.
    sampleRate: input.sampleRate ?? 0.1,
    scopeMode: input.scopeMode ?? "all",
    agentIds: input.agentIds ?? null,
    enabled: input.enabled ?? true,
    invertMatch: input.invertMatch ?? false,
    severity: input.severity ?? "medium",
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.customEvaluators).values(row);
  } else {
    await db.db.insert(db.schema.customEvaluators).values(row);
  }
  return toWire(row);
}

export async function getCustomEvaluatorRow(db: Db, id: string): Promise<CustomEvaluatorRow | null> {
  const cond = and(eq(db.schema.customEvaluators.id, id), eq(db.schema.customEvaluators.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.customEvaluators).where(cond).all()[0] as CustomEvaluatorRow | undefined)
      : ((await db.db.select().from(db.schema.customEvaluators).where(cond))[0] as CustomEvaluatorRow | undefined);
  return row ?? null;
}

export async function getCustomEvaluator(db: Db, id: string) {
  const row = await getCustomEvaluatorRow(db, id);
  return row ? toWire(row) : null;
}

export async function listCustomEvaluatorRows(db: Db): Promise<CustomEvaluatorRow[]> {
  const cond = eq(db.schema.customEvaluators.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.customEvaluators).where(cond).all()
      : await db.db.select().from(db.schema.customEvaluators).where(cond);
  return rows as CustomEvaluatorRow[];
}

export async function listCustomEvaluatorsWire(db: Db) {
  return (await listCustomEvaluatorRows(db)).map(toWire);
}

export async function updateCustomEvaluator(db: Db, id: string, input: UpdateCustomEvaluatorInput) {
  const existing = await getCustomEvaluatorRow(db, id);
  if (!existing) {
    return null;
  }
  const updated: CustomEvaluatorRow = {
    ...existing,
    name: input.name ?? existing.name,
    url: input.url ?? existing.url,
    sampleRate: input.sampleRate ?? existing.sampleRate,
    scopeMode: input.scopeMode ?? existing.scopeMode,
    agentIds: input.agentIds !== undefined ? input.agentIds : existing.agentIds,
    enabled: input.enabled ?? existing.enabled,
    invertMatch: input.invertMatch ?? existing.invertMatch,
    severity: input.severity ?? existing.severity,
  };
  const setValues = {
    name: updated.name,
    url: updated.url,
    sampleRate: updated.sampleRate,
    scopeMode: updated.scopeMode,
    agentIds: updated.agentIds,
    enabled: updated.enabled,
    invertMatch: updated.invertMatch,
    severity: updated.severity,
  };
  const updateCond = and(eq(db.schema.customEvaluators.id, id), eq(db.schema.customEvaluators.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.customEvaluators).set(setValues).where(updateCond);
  } else {
    await db.db.update(db.schema.customEvaluators).set(setValues).where(updateCond);
  }
  return toWire(updated);
}

export async function deleteCustomEvaluator(db: Db, id: string): Promise<boolean> {
  const existing = await getCustomEvaluatorRow(db, id);
  if (!existing) {
    return false;
  }
  const deleteCond = and(eq(db.schema.customEvaluators.id, id), eq(db.schema.customEvaluators.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.customEvaluators).where(deleteCond);
  } else {
    await db.db.delete(db.schema.customEvaluators).where(deleteCond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The HTTP call itself — moved from conditions.ts's callExternalValidator, simplified for a
// standalone evaluator (no more Pattern-condition `sources`/match-target concept to thread
// through: a Custom Evaluator always sees the whole trace).
// ---------------------------------------------------------------------------

export type CustomEvaluatorRequest = {
  evaluatorId: string | null;
  evaluatorName: string;
  agentId: string | null;
  traceId: string | null;
  trace: { input: unknown; output: unknown; error: string | null; toolCalls: unknown };
};

// `score` is optional metadata, not a second way to decide the verdict — `matches` alone still
// determines whether a Signal is raised (see runCustomEvaluators below). When present, it's
// recorded alongside the event and surfaced on the resulting Signal's summary, for evaluators that
// want to report a graded number (e.g. a confidence or severity score) without taking on a
// threshold config the way an Online Evaluator does.
export type CustomEvaluatorResponse = { matches: boolean; reason?: string; score?: number };

const CUSTOM_EVALUATOR_TIMEOUT_MS = 8000;

// Throws on any failure (network error, timeout, non-2xx, missing/non-boolean `matches`) —
// deliberately not swallowed here, same posture as the callExternalValidator this was extracted
// from. Callers (runCustomEvaluators below, and the dashboard's dry-run route) decide how to
// present/isolate a failure; this function's only job is the call + response validation.
export async function callCustomEvaluator(url: string, payload: CustomEvaluatorRequest): Promise<CustomEvaluatorResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CUSTOM_EVALUATOR_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Custom evaluator endpoint ${url} responded ${res.status}`);
  }
  const body = (await res.json()) as { matches?: unknown; reason?: unknown; score?: unknown };
  if (typeof body.matches !== "boolean") {
    throw new Error(`Custom evaluator endpoint ${url} response missing a boolean "matches" field`);
  }
  return {
    matches: body.matches,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    score: typeof body.score === "number" && Number.isFinite(body.score) ? body.score : undefined,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type ScorableTrace = {
  input?: unknown;
  output?: unknown;
  error?: string | null;
  toolCalls?: unknown;
};

// Called from both ingest paths (routes/ingest.ts, routes/otlp.ts) after every trace, independent
// of that trace's own `monitor` flag — same "opt in by creating one" posture as
// runOnlineEvaluators, which this mirrors closely. Callers MUST wrap this in a try/catch: a dead
// endpoint must never break trace ingestion.
export async function runCustomEvaluators(
  db: Db,
  trace: ScorableTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  const evaluators = await listCustomEvaluatorRows(db);

  for (const evaluator of evaluators) {
    if (!evaluator.enabled) continue;
    if (!matchesAgentScope(evaluator, ctx.agentId)) continue;
    if (!passesSampleRate(evaluator.sampleRate)) continue;

    let result: CustomEvaluatorResponse;
    try {
      result = await callCustomEvaluator(evaluator.url, {
        evaluatorId: evaluator.id,
        evaluatorName: evaluator.name,
        agentId: ctx.agentId,
        traceId: ctx.traceId,
        trace: {
          input: trace.input ?? null,
          output: trace.output ?? null,
          error: trace.error ?? null,
          toolCalls: trace.toolCalls ?? null,
        },
      });
    } catch (err) {
      // One dead endpoint must not skip every other evaluator after it for this trace — isolated
      // per-evaluator, same reasoning as onlineEvaluators.ts / detect.ts's per-pattern isolation.
      // No Signal is raised for the evaluator's own call failure, same posture a broken judge
      // config already has in runOnlineEvaluators.
      console.error(`Custom evaluator "${evaluator.name}" failed to call ${evaluator.url}:`, err instanceof Error ? err.message : err);
      continue;
    }

    const hit = evaluator.invertMatch ? !result.matches : result.matches;
    // score is metadata only — never part of the hit/no-hit decision above, just appended to the
    // summary/event for visibility (see CustomEvaluatorResponse's comment).
    const scoreSuffix = result.score !== undefined ? ` (score: ${result.score})` : "";

    let signalId: string | null = null;
    if (hit) {
      const signal = await upsertSignal(
        db,
        {
          type: "custom_evaluator_match",
          severity: evaluator.severity,
          polarity: "failure",
          summary: `"${evaluator.name}" flagged this response${scoreSuffix}${result.reason ? `: ${result.reason}` : ""}`,
          patternKey: `custom-eval:${evaluator.id}`,
          rootCause: evaluator.name,
        },
        { agentId: ctx.agentId, traceId: ctx.traceId, evidence: { input: trace.input, output: trace.output } }
      );
      signalId = signal._id;
    }

    // Recorded whether or not it raised a Signal, mirroring runOnlineEvaluators — gives a full
    // call history (getCustomEvaluatorEvents) to review even for a Custom Evaluator that's never
    // actually flagged anything yet.
    await recordEvent(db, {
      signalId,
      patternKey: `custom-eval:${evaluator.id}`,
      type: "custom_eval_check",
      severity: "low",
      polarity: "score",
      agentId: ctx.agentId,
      traceId: ctx.traceId,
      customEvaluatorId: evaluator.id,
      matched: result.matches,
      score: result.score ?? null,
      justification: result.reason ?? null,
    });
  }
}
