import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { recordEvent } from "./events.js";
import { loadScorerSpans, runScriptScorer, type ScorerSpan } from "./scriptScorer.js";
import { getTraceRow } from "../trace/ingest.js";
import { upsertSignal } from "./signals.js";
import { logger } from "../../log.js";

// Promoted out of core/monitor/conditions.ts's Pattern-condition "external" detector - same
// call-out-and-await-a-verdict shape as Online Evaluators (onlineEvaluators.ts), just with a URL
// instead of an evaluationSettingsId as the thing being invoked. One Custom Evaluator = one URL,
// no AND/OR/NOR composition the way a Pattern's condition list has - that composition only ever
// made sense for phrase/regex/semantic rows checked against pattern-specific match targets; a
// standalone evaluator just gets the whole trace every time.
export type CreateCustomEvaluatorInput = {
  name: string;
  // External kind: the endpoint. Code kind: unused (empty string stored).
  url?: string;
  sampleRate?: number;
  scopeMode?: string;
  agentIds?: string[];
  enabled?: boolean;
  // The endpoint's verdict is a boolean (`matches`), not a numeric rating like an Online
  // Evaluator's judge score - this is the analogous "does a hit raise a Signal" knob, mirroring
  // the old per-condition `negate` flag from the Pattern builder it was extracted from.
  invertMatch?: boolean;
  severity?: string;
  // "external" (default, HTTP endpoint) or "code" (user script run in-engine).
  kind?: string;
  // Code kind: "javascript" | "python", and the script body defining `handler`.
  language?: string;
  script?: string;
  // Code kind: a returned score below this raises a Signal (0..1, default 0.5).
  alertBelow?: number;
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
  kind: string;
  language: string | null;
  script: string | null;
  alertBelow: number | null;
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
    kind: row.kind,
    language: row.language ?? undefined,
    script: row.script ?? undefined,
    alertBelow: row.alertBelow ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function clampAlertBelow(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export async function createCustomEvaluator(db: Db, input: CreateCustomEvaluatorInput) {
  const row: CustomEvaluatorRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    url: input.url ?? "",
    // Same reasoning as Online Evaluators' default: every check is a real outbound HTTP call
    // (external) or a script execution (code), so sampling isn't optional the way it arguably
    // is for a free phrase/regex match.
    sampleRate: input.sampleRate ?? 0.1,
    scopeMode: input.scopeMode ?? "all",
    agentIds: input.agentIds ?? null,
    enabled: input.enabled ?? true,
    invertMatch: input.invertMatch ?? false,
    severity: input.severity ?? "medium",
    kind: input.kind === "code" ? "code" : "external",
    language: input.kind === "code" ? (input.language === "python" ? "python" : "javascript") : null,
    script: input.kind === "code" ? input.script ?? null : null,
    alertBelow: input.kind === "code" ? clampAlertBelow(input.alertBelow) : null,
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
    // kind is immutable after creation - an external scorer doesn't become a code scorer.
    language: existing.kind === "code" && input.language ? (input.language === "python" ? "python" : "javascript") : existing.language,
    script: existing.kind === "code" && input.script !== undefined ? input.script : existing.script,
    alertBelow: existing.kind === "code" && input.alertBelow !== undefined ? clampAlertBelow(input.alertBelow) : existing.alertBelow,
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
    language: updated.language,
    script: updated.script,
    alertBelow: updated.alertBelow,
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
// The HTTP call itself - moved from conditions.ts's callExternalValidator, simplified for a
// standalone evaluator (no more Pattern-condition `sources`/match-target concept to thread
// through: a Custom Evaluator always sees the whole trace).
// ---------------------------------------------------------------------------

// Contract v2: the external scorer sees the FULL traced span, not a four-field summary. The
// legacy keys (input/output/error/toolCalls) keep their exact positions inside `trace` so v1
// consumers keep working; everything else the tracer records rides alongside them, and the
// trace's own span subtree (root first, start-time ordered, each with a derived `type` of
// llm/tool/retrieval/span) arrives as `spans`. schemaVersion identifies the shape.
export type CustomEvaluatorRequest = {
  schemaVersion: 2;
  evaluatorId: string | null;
  evaluatorName: string;
  agentId: string | null;
  traceId: string | null;
  trace: {
    input: unknown;
    output: unknown;
    error: string | null;
    toolCalls: unknown;
    name: string | null;
    model: string | null;
    framework: string | null;
    sessionId: string | null;
    spanId: string | null;
    latencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    metadata: unknown;
    startedAt: string | null;
    createdAt: string | null;
  };
  spans: ScorerSpan[];
};

// `score` is optional metadata, not a second way to decide the verdict - `matches` alone still
// determines whether a Signal is raised (see runCustomEvaluators below). When present, it's
// recorded alongside the event and surfaced on the resulting Signal's summary, for evaluators that
// want to report a graded number (e.g. a confidence or severity score) without taking on a
// threshold config the way an Online Evaluator does.
export type CustomEvaluatorResponse = { matches: boolean; reason?: string; score?: number };

const CUSTOM_EVALUATOR_TIMEOUT_MS = 8000;

// Throws on any failure (network error, timeout, non-2xx, missing/non-boolean `matches`) -
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
// of that trace's own `monitor` flag - same "opt in by creating one" posture as
// runOnlineEvaluators, which this mirrors closely. Callers MUST wrap this in a try/catch: a dead
// endpoint must never break trace ingestion.
export async function runCustomEvaluators(
  db: Db,
  trace: ScorableTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  const evaluators = await listCustomEvaluatorRows(db);
  const active = evaluators.filter(e => e.enabled && matchesAgentScope(e, ctx.agentId));
  if (active.length === 0) return;

  // Loaded once per trace, shared by every scorer that runs on it: the full stored row (for the
  // v2 external payload) and the span subtree (for both kinds).
  const row = ctx.traceId ? await getTraceRow(db, ctx.traceId) : undefined;
  const spans = await loadScorerSpans(db, ctx.traceId);

  for (const evaluator of active) {
    if (!passesSampleRate(evaluator.sampleRate)) continue;

    if (evaluator.kind === "code") {
      await runCodeKind(db, evaluator, trace, spans, ctx);
      continue;
    }

    let result: CustomEvaluatorResponse;
    try {
      result = await callCustomEvaluator(evaluator.url, {
        schemaVersion: 2,
        evaluatorId: evaluator.id,
        evaluatorName: evaluator.name,
        agentId: ctx.agentId,
        traceId: ctx.traceId,
        trace: {
          input: trace.input ?? null,
          output: trace.output ?? null,
          error: trace.error ?? null,
          toolCalls: trace.toolCalls ?? null,
          name: row?.name ?? null,
          model: row?.model ?? null,
          framework: row?.framework ?? null,
          sessionId: row?.sessionId ?? null,
          spanId: row?.spanId ?? null,
          latencyMs: row?.latencyMs ?? null,
          inputTokens: row?.inputTokens ?? null,
          outputTokens: row?.outputTokens ?? null,
          cacheReadTokens: row?.cacheReadTokens ?? null,
          cacheWriteTokens: row?.cacheWriteTokens ?? null,
          metadata: row?.metadata ?? null,
          startedAt: row?.startedAt ? row.startedAt.toISOString() : null,
          createdAt: row?.createdAt ? row.createdAt.toISOString() : null,
        },
        spans,
      });
    } catch (err) {
      // One dead endpoint must not skip every other evaluator after it for this trace - isolated
      // per-evaluator, same reasoning as onlineEvaluators.ts / detect.ts's per-pattern isolation.
      // No Signal is raised for the evaluator's own call failure, same posture a broken judge
      // config already has in runOnlineEvaluators.
      logger.error({ err: err instanceof Error ? err.message : err }, `Custom evaluator "${evaluator.name}" failed to call ${evaluator.url}:`);
      continue;
    }

    const hit = evaluator.invertMatch ? !result.matches : result.matches;
    // score is metadata only - never part of the hit/no-hit decision above, just appended to the
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

    // Recorded whether or not it raised a Signal, mirroring runOnlineEvaluators - gives a full
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

// The Code kind: run the user's script in-engine (core/monitor/scriptScorer.ts) and translate
// its 0..1 score into the same signal/event stream the external kind feeds. A null score (the
// handler returned null/None, or the script failed) records nothing signal-worthy: failures log
// an event with the error as justification so the evaluator's history shows them, but never
// raise a Signal - a broken scorer is an operator problem, not an agent problem.
async function runCodeKind(
  db: Db,
  evaluator: CustomEvaluatorRow,
  trace: ScorableTrace,
  spans: ScorerSpan[],
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  const result = await runScriptScorer(
    { name: evaluator.name, language: evaluator.language ?? "javascript", script: evaluator.script ?? "" },
    {
      input: trace.input ?? null,
      output: trace.output ?? null,
      expected: null,
      metadata: (trace as { metadata?: unknown }).metadata ?? null,
      spans,
    }
  );

  if (result.error) {
    logger.error({ err: result.error }, `Code scorer "${evaluator.name}" failed:`);
    await recordEvent(db, {
      signalId: null,
      patternKey: `custom-eval:${evaluator.id}`,
      type: "custom_eval_check",
      severity: "low",
      polarity: "score",
      agentId: ctx.agentId,
      traceId: ctx.traceId,
      customEvaluatorId: evaluator.id,
      matched: null,
      score: null,
      justification: `scorer error: ${result.error}`,
    });
    return;
  }
  if (result.score === null) {
    // Handler chose to skip this trace - by contract, no event, no signal.
    return;
  }

  const threshold = evaluator.alertBelow ?? 0.5;
  const hit = result.score < threshold;
  const displayName = result.name ?? evaluator.name;
  let signalId: string | null = null;
  if (hit) {
    const signal = await upsertSignal(
      db,
      {
        type: "custom_evaluator_match",
        severity: evaluator.severity,
        polarity: "failure",
        summary: `"${displayName}" scored this response ${result.score.toFixed(2)}, below the ${threshold.toFixed(2)} alert threshold`,
        patternKey: `custom-eval:${evaluator.id}`,
        rootCause: evaluator.name,
      },
      { agentId: ctx.agentId, traceId: ctx.traceId, evidence: { input: trace.input, output: trace.output } }
    );
    signalId = signal._id;
  }

  await recordEvent(db, {
    signalId,
    patternKey: `custom-eval:${evaluator.id}`,
    type: "custom_eval_check",
    severity: "low",
    polarity: "score",
    agentId: ctx.agentId,
    traceId: ctx.traceId,
    customEvaluatorId: evaluator.id,
    matched: hit,
    score: result.score,
    justification: result.metadata !== undefined ? JSON.stringify(result.metadata).slice(0, 2000) : null,
  });
}
