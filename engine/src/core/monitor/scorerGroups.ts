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
  if (input.online !== undefined) patch.online = input.online;
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

export function aggregateGroupScore(members: MemberScore[]): { score: number | null; gatedBy: string | null } {
  const gated = members.find(m => m.gate && m.goodness !== null && m.goodness < GATE_FLOOR);
  if (gated) return { score: 0, gatedBy: gated.name };
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
export async function computeGroupScore(db: Db, group: ScorerGroupRow, content: GroupScoringContent): Promise<GroupScore> {
  const members: MemberScore[] = [];

  for (const member of group.members) {
    if (member.kind === "judge") {
      members.push(await scoreJudgeMember(db, member, content));
    } else if (member.kind === "pattern") {
      members.push(await scorePatternMember(db, member, content));
    } else {
      members.push(await scoreCustomMember(db, member, content));
    }
  }

  const { score, gatedBy } = aggregateGroupScore(members);
  return { score, gatedBy, members };
}

async function scoreJudgeMember(db: Db, member: ScorerGroupMember, content: GroupScoringContent): Promise<MemberScore> {
  const base = { kind: member.kind, refId: member.refId, weight: member.weight, gate: member.gate };
  const settings = await getEvaluationSettingsRow(db, member.refId);
  if (!settings) {
    return { ...base, name: member.refId, goodness: null, detail: "-", error: "Scorer no longer exists" };
  }
  const name = settings.name ?? member.refId;
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
    return { ...base, name, goodness: rating / 10, detail: `${rating}/10 (${justification.slice(0, 140)})` };
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
    // Judge members are real LLM spend at the sample rate, so they draw from the SAME online
    // judge budget evaluators reserve from (reserveOnlineJudgeCall) - one slot per judge member,
    // taken up front. A refused reservation skips the whole group for this trace: a partial
    // panel would score the group on a different recipe than the one configured.
    const judgeMemberCount = group.members.filter(m => m.kind === "judge").length;
    let budgetOk = true;
    for (let i = 0; i < judgeMemberCount; i++) {
      if (!(await reserveOnlineJudgeCall(db))) {
        budgetOk = false;
        break;
      }
    }
    if (!budgetOk) return;
    try {
      const result = await computeGroupScore(db, group, {
        input: inputText,
        output: outputText,
        traceId: ctx.traceId,
        toolCalls: trace.toolCalls,
      });
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
