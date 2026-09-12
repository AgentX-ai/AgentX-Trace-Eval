import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getEvaluationSettingsRow } from "../evaluate/evaluationSettings.js";
import { scoreAgainstCriteria, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { getPatternRow } from "./patterns.js";
import { evaluatePatternConditions, type PatternCondition, type TraceLike } from "./conditions.js";
import { llmSemanticJudge } from "./detect.js";
import { getCustomEvaluatorRow, callCustomEvaluator, type CustomEvaluatorRow } from "./customEvaluators.js";
import { runScriptScorer, loadScorerSpans } from "./scriptScorer.js";
import { passesSampleRate } from "./routing.js";
import { recordEvent } from "./events.js";
import { upsertSignal } from "./signals.js";
import { getProfileRow } from "./profiles.js";
import { notifyWebhooks, extractWebhookUrls } from "./webhooks.js";
import { reserveOnlineJudgeCall } from "./onlineEvaluators.js";
import { logger } from "../../log.js";

// A Scorer group: several scorers of ANY kind - LLM judges, patterns (templates included), and
// custom code/external scorers - composed into ONE 0-10 score via per-member weights and
// optional must-pass gates. This is the run-level composition unit the judge-embedded "attached
// code checks" could not express: members are stored by REFERENCE, so one group reuses the
// scorers the project already has, and the group itself is what a run (or live traffic) is
// graded with.
//
// Scale unification happens here and only here: every member keeps its native contract (judges
// 0-10, patterns matched/not + polarity, custom scorers 0..1) and is normalized to a 0-1
// "goodness" for weighting - a failure-polarity pattern that matched is goodness 0, a proper-
// polarity one that matched is goodness 1. The aggregate is then reported on 0-10 so a group
// score reads like a rating everywhere ratings already live (run rating column, CI gates,
// live alert thresholds).

export type ScorerGroupMember = {
  kind: "judge" | "pattern" | "custom";
  refId: string;
  // Relative weight, >= 0. Weights renormalize over the members that actually produced a score,
  // so one failed/deleted member shrinks the denominator instead of dragging the score down.
  weight: number;
  // Must-pass: if this member's goodness lands below 0.5 (a matched failure pattern, a judge
  // under 5/10, a custom score under 0.5), the whole group scores 0 regardless of the blend.
  gate: boolean;
};

export type ScorerGroupOnline = {
  enabled: boolean;
  sampleRate: number;
  // On the GROUP score, 0-10. Null = never raise a Signal (chart-only).
  alertThreshold: number | null;
  severity: string;
  // "trace" (default) scores each sampled ingested trace; "session" scores whole multi-turn
  // sessions once they have been idle for idleSeconds - the same trigger session-scoped online
  // evaluators use (see sessionSweep.ts, which owns the group-session loop).
  scope?: "trace" | "session";
  idleSeconds?: number;
};

export type ScorerGroupRow = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  members: ScorerGroupMember[];
  online: ScorerGroupOnline | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MemberScore = {
  kind: ScorerGroupMember["kind"];
  refId: string;
  name: string;
  weight: number;
  gate: boolean;
  // 0-1 normalized; null = this member could not score (deleted ref, judge failure, ...).
  goodness: number | null;
  // The member's native-scale value, for display ("7.5/10", "matched", "0.82").
  detail: string;
  error?: string;
};

export type GroupScore = {
  // 0-10, null when no member produced a score.
  score: number | null;
  // Name of the gating member that zeroed the score, if any.
  gatedBy: string | null;
  members: MemberScore[];
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function toRow(raw: Record<string, unknown>): ScorerGroupRow {
  return {
    id: String(raw.id),
    projectId: (raw.projectId as string | null) ?? null,
    name: String(raw.name),
    description: (raw.description as string | null) ?? null,
    members: (raw.members as ScorerGroupMember[] | null) ?? [],
    online: (raw.online as ScorerGroupOnline | null) ?? null,
    createdAt: raw.createdAt as Date,
    updatedAt: raw.updatedAt as Date,
  };
}

// Create/update-time member validation: a typo'd refId used to 201 and produce a group that
// permanently scores null (silently, one "Scorer no longer exists" member at a time), and a
// reference-centric judge (requiresExpected) could ride a group straight past the guard that
// 409s it as a standalone online evaluator. Returns human-readable problems; empty = valid.
export async function validateGroupMembers(
  db: Db,
  members: ScorerGroupMember[],
  options: { onlineEnabled: boolean; grandfathered?: Set<string> }
): Promise<string[]> {
  const problems: string[] = [];
  for (const member of members) {
    // A ref that is ALREADY stored on this group is never rejected: a scorer deleted after the
    // group was built legitimately dangles (scoring degrades it to "not scored"), and the
    // dashboard round-trips the full member list on every save - refusing the dangling entry
    // would make the whole group uneditable. Only NEW refs must resolve.
    const stored = options.grandfathered?.has(`${member.kind}:${member.refId}`) ?? false;
    if (member.kind === "judge") {
      const settings = await getEvaluationSettingsRow(db, member.refId);
      if (!settings) {
        if (!stored) problems.push(`Unknown judge scorer id "${member.refId}"`);
      } else if (options.onlineEnabled && settings.requiresExpected) {
        problems.push(
          `"${settings.name}" needs a reference answer (requiresExpected) and cannot grade live traffic - disable requiresExpected or keep the group's live scoring off`
        );
      }
    } else if (member.kind === "pattern") {
      if (!stored && !(await getPatternRow(db, member.refId))) problems.push(`Unknown pattern id "${member.refId}"`);
    } else {
      if (!stored && !(await getCustomEvaluatorRow(db, member.refId))) problems.push(`Unknown scorer id "${member.refId}"`);
    }
  }
  return problems;
}

export function normalizeMembers(raw: unknown): ScorerGroupMember[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map(m => ({
      kind: (["judge", "pattern", "custom"] as const).includes(m.kind as never)
        ? (m.kind as ScorerGroupMember["kind"])
        : "judge",
      refId: String(m.refId ?? ""),
      weight: Math.max(0, Number(m.weight ?? 1) || 0),
      gate: m.gate === true,
    }))
    .filter(m => m.refId);
}

export async function listScorerGroups(db: Db): Promise<ScorerGroupRow[]> {
  const cond = eq(db.schema.scorerGroups.projectId, db.projectId);
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.scorerGroups).where(cond).all()
      : await db.db.select().from(db.schema.scorerGroups).where(cond);
  return (rows as Record<string, unknown>[]).map(toRow);
}

export async function getScorerGroup(db: Db, id: string): Promise<ScorerGroupRow | null> {
  const cond = and(eq(db.schema.scorerGroups.id, id), eq(db.schema.scorerGroups.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.scorerGroups).where(cond).all()
      : await db.db.select().from(db.schema.scorerGroups).where(cond);
  const row = (rows as Record<string, unknown>[])[0];
  return row ? toRow(row) : null;
}

export async function createScorerGroup(
  db: Db,
  input: { name: string; description?: string; members: unknown; online?: ScorerGroupOnline | null }
): Promise<ScorerGroupRow> {
  const now = new Date();
  const values = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    description: input.description ?? null,
    members: normalizeMembers(input.members),
    online: input.online ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (db.kind === "sqlite") {
    db.db.insert(db.schema.scorerGroups).values(values).run();
  } else {
    await db.db.insert(db.schema.scorerGroups).values(values);
  }
  return toRow(values as unknown as Record<string, unknown>);
}

export async function updateScorerGroup(
  db: Db,
  id: string,
  input: { name?: string; description?: string | null; members?: unknown; online?: ScorerGroupOnline | null }
): Promise<ScorerGroupRow | null> {
  const existing = await getScorerGroup(db, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.members !== undefined) patch.members = normalizeMembers(input.members);
  if (input.online !== undefined) {
    // Merge, don't replace: a client that predates scope/idleSeconds (round-tripping only
    // {enabled, sampleRate, alertThreshold, severity}) must not silently flip a session group
    // back to per-trace scoring. online:null still detaches explicitly.
    patch.online =
      input.online === null ? null : ({ ...(existing.online ?? {}), ...input.online } as ScorerGroupOnline);
  }
  const cond = and(eq(db.schema.scorerGroups.id, id), eq(db.schema.scorerGroups.projectId, db.projectId));
  if (db.kind === "sqlite") {
    db.db.update(db.schema.scorerGroups).set(patch).where(cond).run();
  } else {
    await db.db.update(db.schema.scorerGroups).set(patch).where(cond);
  }
  return getScorerGroup(db, id);
}

export async function deleteScorerGroup(db: Db, id: string): Promise<boolean> {
  const existing = await getScorerGroup(db, id);
  if (!existing) return false;
  const cond = and(eq(db.schema.scorerGroups.id, id), eq(db.schema.scorerGroups.projectId, db.projectId));
  if (db.kind === "sqlite") {
    db.db.delete(db.schema.scorerGroups).where(cond).run();
  } else {
    await db.db.delete(db.schema.scorerGroups).where(cond);
  }
  return true;
}

export function toScorerGroupWire(row: ScorerGroupRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    members: row.members,
    online: row.online,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// The gate line: goodness below this fails a gated member (a judge under 5/10, a matched
// failure pattern, a custom score under 0.5).
const GATE_FLOOR = 0.5;

// One doctrine for the online judge budget, both scopes: reserve LAZILY (one slot per call
// actually made - up-front reservation burned slots for members that turned out unscoreable
// and could starve every other evaluator for the day), and a panel cut short by the budget
// produces NO score - renormalizing the survivors would report a confident blend computed
// from a recipe the operator never configured.
export const BUDGET_EXHAUSTED_ERROR = "Online judge budget exhausted";
export const SCORER_MISSING_ERROR = "Scorer no longer exists";

// Judge members that RESERVED a budget slot and then failed to score - the spend happened, so
// the restart-time budget seed must see a failure event for each. Members that never reserved
// (deleted ref, budget refusal itself) are excluded; both callers share this one definition so
// the two scopes cannot drift apart again.
export function spentFailedJudgeMembers(members: MemberScore[]): MemberScore[] {
  return members.filter(
    m =>
      m.kind === "judge" &&
      m.goodness === null &&
      m.error !== SCORER_MISSING_ERROR &&
      m.error !== BUDGET_EXHAUSTED_ERROR
  );
}

export function aggregateGroupScore(members: MemberScore[]): { score: number | null; gatedBy: string | null } {
  const gated = members.find(m => m.gate && m.goodness !== null && m.goodness < GATE_FLOOR);
  if (gated) return { score: 0, gatedBy: gated.name };
  // Fail-closed: a must-pass member that could NOT score (judge outage, deleted ref, scorer
  // 500) means the configured recipe was not evaluated - producing a blend without the gate
  // would report "passed" for a safety check that never ran. No score is the honest answer.
  if (members.some(m => m.gate && m.goodness === null)) return { score: null, gatedBy: null };
  // Same honesty for a budget-truncated panel: see BUDGET_EXHAUSTED_ERROR's comment.
  if (members.some(m => m.error === BUDGET_EXHAUSTED_ERROR)) return { score: null, gatedBy: null };
  let total = 0;
  let weightUsed = 0;
  for (const m of members) {
    if (m.goodness === null || m.weight <= 0) continue;
    total += m.goodness * m.weight;
    weightUsed += m.weight;
  }
  if (weightUsed === 0) return { score: null, gatedBy: null };
  return { score: Math.round((total / weightUsed) * 100) / 10, gatedBy: null };
}

export function describeGroupScore(result: { score: number | null; gatedBy: string | null }, members: MemberScore[]): string {
  if (result.gatedBy) return `Gated to 0 by "${result.gatedBy}" (must-pass member failed).`;
  const gateErrored = members.find(m => m.gate && m.goodness === null);
  if (gateErrored) {
    return `No score: must-pass member "${gateErrored.name}" could not score (${gateErrored.error ?? "scorer failed"}).`;
  }
  if (members.some(m => m.error === BUDGET_EXHAUSTED_ERROR)) {
    return "No score: the online judge budget ran out mid-panel - a partial blend would misrepresent the configured recipe.";
  }
  const parts = members
    .filter(m => m.goodness !== null && m.weight > 0)
    .map(m => `${m.name} ${m.detail} ×${m.weight}`);
  return parts.length > 0 ? `Weighted blend: ${parts.join(", ")}.` : "No member produced a score.";
}

export type GroupScoringContent = {
  input: string;
  output: string;
  expected?: string;
  traceId?: string | null;
  toolCalls?: unknown;
};

// Scores every member of a group against one piece of content (an eval-run result, or a live
// trace) and aggregates. Failures isolate per member - one deleted scorer or judge outage
// degrades that member to goodness null (renormalized away) rather than failing the group.
export async function computeGroupScore(
  db: Db,
  group: ScorerGroupRow,
  content: GroupScoringContent,
  options: { reserveOnlineBudget?: boolean } = {}
): Promise<GroupScore> {
  const members: MemberScore[] = [];

  for (const member of group.members) {
    if (member.kind === "judge") {
      members.push(await scoreJudgeMember(db, member, content, options));
    } else if (member.kind === "pattern") {
      members.push(await scorePatternMember(db, member, content));
    } else {
      members.push(await scoreCustomMember(db, member, content));
    }
  }

  const { score, gatedBy } = aggregateGroupScore(members);
  return { score, gatedBy, members };
}

async function scoreJudgeMember(
  db: Db,
  member: ScorerGroupMember,
  content: GroupScoringContent,
  options: { reserveOnlineBudget?: boolean } = {}
): Promise<MemberScore> {
  const base = { kind: member.kind, refId: member.refId, weight: member.weight, gate: member.gate };
  const settings = await getEvaluationSettingsRow(db, member.refId);
  if (!settings) {
    return { ...base, name: member.refId, goodness: null, detail: "-", error: SCORER_MISSING_ERROR };
  }
  const name = settings.name ?? member.refId;
  // Lazily, per call actually made - see BUDGET_EXHAUSTED_ERROR's comment.
  if (options.reserveOnlineBudget && !(await reserveOnlineJudgeCall(db))) {
    return { ...base, name, goodness: null, detail: "-", error: BUDGET_EXHAUSTED_ERROR };
  }
  try {
    const { rating, justification } = await scoreAgainstCriteria(
      {
        acceptanceCriteria: settings.acceptanceCriteria ?? "",
        rejectionCriteria: settings.rejectionCriteria ?? "",
        evaluationCriteria: settings.evaluationCriteria ?? "",
        judgePrompt: (settings.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
        judgeModel: settings.judgeModel ?? DEFAULT_JUDGE_MODEL,
      },
      { input: content.input, output: content.output, expected: content.expected }
    );
    const clamped = Math.max(0, Math.min(10, rating));
    return { ...base, name, goodness: clamped / 10, detail: `${clamped}/10 (${justification.slice(0, 140)})` };
  } catch (err) {
    return { ...base, name, goodness: null, detail: "-", error: err instanceof Error ? err.message : "Judge failed" };
  }
}

export async function scorePatternMember(db: Db, member: ScorerGroupMember, content: GroupScoringContent): Promise<MemberScore> {
  const base = { kind: member.kind, refId: member.refId, weight: member.weight, gate: member.gate };
  const pattern = await getPatternRow(db, member.refId);
  if (!pattern) {
    return { ...base, name: member.refId, goodness: null, detail: "-", error: "Pattern no longer exists" };
  }
  try {
    const trace: TraceLike = { input: content.input, output: content.output, error: null, toolCalls: content.toolCalls as TraceLike["toolCalls"] };
    const outcome = await evaluatePatternConditions({
      conditions: pattern.conditions as PatternCondition[],
      responseText: content.output,
      trace,
      semanticJudge: llmSemanticJudge,
    });
    // Polarity decides which way "matched" points: a matched failure pattern is goodness 0,
    // a matched proper ("contains disclaimer") pattern is goodness 1.
    const failureLike = pattern.polarity !== "proper";
    const goodness = outcome.overall === failureLike ? 0 : 1;
    const detail = outcome.overall ? `matched${outcome.reasons.length ? ` (${outcome.reasons[0]})` : ""}` : "no match";
    return { ...base, name: pattern.name, goodness, detail };
  } catch (err) {
    return {
      ...base,
      name: pattern.name,
      goodness: null,
      detail: "-",
      error: err instanceof Error ? err.message : "Pattern check failed",
    };
  }
}

export async function scoreCustomMember(db: Db, member: ScorerGroupMember, content: GroupScoringContent): Promise<MemberScore> {
  const base = { kind: member.kind, refId: member.refId, weight: member.weight, gate: member.gate };
  const evaluator = (await getCustomEvaluatorRow(db, member.refId)) as CustomEvaluatorRow | null;
  if (!evaluator) {
    return { ...base, name: member.refId, goodness: null, detail: "-", error: "Scorer no longer exists" };
  }
  try {
    if (evaluator.kind === "code") {
      const scriptSpans = await loadScorerSpans(db, content.traceId ?? null);
      const result = await runScriptScorer(
        { name: evaluator.name, language: evaluator.language === "python" ? "python" : "javascript", script: evaluator.script ?? "" },
        { input: content.input, output: content.output, expected: content.expected ?? null, metadata: null, spans: scriptSpans }
      );
      if (result.score === null || result.score === undefined) {
        return { ...base, name: evaluator.name, goodness: null, detail: "-", error: result.error ?? "Scorer returned no score" };
      }
      const clamped = Math.max(0, Math.min(1, result.score));
      return { ...base, name: evaluator.name, goodness: clamped, detail: clamped.toFixed(2) };
    }
    // External (HTTP) scorer - schemaVersion 2 payload with the content standing in for a trace.
    const spans = await loadScorerSpans(db, content.traceId ?? null);
    const response = await callCustomEvaluator(evaluator.url, {
      schemaVersion: 2,
      evaluatorId: evaluator.id,
      evaluatorName: evaluator.name,
      agentId: null,
      traceId: content.traceId ?? null,
      trace: {
        input: content.input,
        output: content.output,
        error: null,
        toolCalls: (content.toolCalls as null) ?? null,
        name: null,
        model: null,
        framework: null,
        sessionId: null,
        spanId: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        metadata: null,
        startedAt: null,
        createdAt: null,
      },
      spans,
    });
    if (typeof response.score === "number" && Number.isFinite(response.score)) {
      const clamped = Math.max(0, Math.min(1, response.score));
      return { ...base, name: evaluator.name, goodness: clamped, detail: clamped.toFixed(2) };
    }
    if (typeof response.matches === "boolean") {
      // Boolean external verdicts follow invertMatch the way live scoring does: matches===true
      // raising a Signal means "matched = bad" unless inverted.
      const bad = evaluator.invertMatch ? !response.matches : response.matches;
      return { ...base, name: evaluator.name, goodness: bad ? 0 : 1, detail: bad ? "flagged" : "clean" };
    }
    return { ...base, name: evaluator.name, goodness: null, detail: "-", error: "Scorer returned no usable score" };
  } catch (err) {
    return {
      ...base,
      name: evaluator.name,
      goodness: null,
      detail: "-",
      error: err instanceof Error ? err.message : "Scorer failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Live traffic
// ---------------------------------------------------------------------------

// Ingest-time group scoring - the group-level sibling of runOnlineEvaluators: sampled per group,
// the GROUP score (0-10) is the recorded rating, and a score below the group's alertThreshold
// raises/updates a Signal exactly like a low online-evaluator verdict. patternKey
// `scorer-group:<id>` keys the events, so history survives member edits.
export async function runScorerGroupsOnline(
  db: Db,
  trace: { input: unknown; output: unknown; toolCalls?: unknown },
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  // Session-scoped groups are the idle-session sweep's job (sessionSweep.ts) - scoring them
  // here too would judge every individual trace of a conversation a second time.
  const groups = (await listScorerGroups(db)).filter(
    g => g.online?.enabled && (g.online.scope ?? "trace") !== "session"
  );
  if (groups.length === 0) return;
  const inputText = typeof trace.input === "string" ? trace.input : JSON.stringify(trace.input ?? "");
  const outputText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
  // Same webhook fan-out low online-evaluator scores get - a below-threshold group score is a
  // failure detection, and it pages the same channels.
  const alertProfile = ctx.agentId ? await getProfileRow(db, ctx.agentId) : null;

  for (const group of groups) {
    const online = group.online!;
    if (!passesSampleRate(online.sampleRate)) continue;
    try {
      // Judge members draw from the shared online judge budget, reserved lazily per call
      // inside scoreJudgeMember; a truncated panel aggregates to no score at all.
      const result = await computeGroupScore(
        db,
        group,
        {
          input: inputText,
          output: outputText,
          traceId: ctx.traceId,
          toolCalls: trace.toolCalls,
        },
        { reserveOnlineBudget: true }
      );
      // Judge members that reserved a slot and failed still SPENT the call - recorded before
      // the score-null bail below, because a full judge outage is exactly the case where the
      // aggregate is null and exactly the spend the restart-time budget seed must not miss.
      for (const member of spentFailedJudgeMembers(result.members)) {
        await recordEvent(db, {
          signalId: null,
          patternKey: `scorer-group:${group.id}:judge:${member.refId}`,
          type: "online_eval_judge_failure",
          severity: "low",
          polarity: "score",
          agentId: ctx.agentId,
          traceId: ctx.traceId,
          onlineEvaluatorId: null,
          rating: null,
          justification: member.error ?? "Judge member failed",
        });
      }
      if (result.score === null) continue;
      const justification = describeGroupScore(result, result.members);

      let signalId: string | null = null;
      if (online.alertThreshold !== null && result.score < online.alertThreshold) {
        const summary = `Scorer group "${group.name}" scored this response ${result.score.toFixed(1)}/10 (below the ${online.alertThreshold} threshold): ${justification}`;
        const signal = await upsertSignal(
          db,
          {
            type: "scorer_group_low_score",
            severity: online.severity,
            polarity: "failure",
            summary,
            patternKey: `scorer-group:${group.id}`,
            rootCause: group.name,
          },
          { agentId: ctx.agentId, traceId: ctx.traceId, evidence: { input: trace.input, output: trace.output } }
        );
        signalId = signal._id;
        notifyWebhooks(extractWebhookUrls(alertProfile?.channels), {
          summary,
          severity: online.severity,
          patternKey: `scorer-group:${group.id}`,
          agentId: ctx.agentId,
          rootCause: group.name,
        });
      }

      await recordEvent(db, {
        signalId,
        patternKey: `scorer-group:${group.id}`,
        type: "scorer_group_score",
        severity: "low",
        polarity: "score",
        agentId: ctx.agentId,
        traceId: ctx.traceId,
        onlineEvaluatorId: null,
        rating: result.score,
        justification,
      });

      // One event per scored member alongside the aggregate - the "detailed Judge scores"
      // behind a group score in the Trace Details popup (listTraceEvaluations decodes the JSON
      // payload). Rating is the member's goodness on 0-10 so every kind reads on one scale.
      for (const member of result.members) {
        if (member.goodness === null) continue;
        await recordEvent(db, {
          signalId: null,
          patternKey: `scorer-group:${group.id}:${member.kind}:${member.refId}`,
          type: "scorer_group_member_score",
          severity: "low",
          polarity: "score",
          agentId: ctx.agentId,
          traceId: ctx.traceId,
          onlineEvaluatorId: null,
          rating: Math.round(member.goodness * 100) / 10,
          justification: JSON.stringify({ name: member.name, detail: member.detail }),
        });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, `Scorer group "${group.name}" failed to score`);
    }
  }
}
