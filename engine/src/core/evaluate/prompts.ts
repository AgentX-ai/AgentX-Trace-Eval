import { nanoid } from "nanoid";
import { eq, and, gte, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { getDataset } from "./datasets.js";
import { getTraceRow } from "../trace/ingest.js";
import type { MonitoringWindow } from "../monitor/events.js";

// The external-agent prompt registry: how LangSmith (Prompt Hub) and Langfuse (Prompt
// Management) close the "we don't own the agent's code" gap — AgentX becomes the prompt's
// source of truth, the SDK pulls it at runtime (client.evaluations.prompts.get(name)), and a
// human-approved "propose improvement" step (proposePromptImprovement below) writes new
// versions here, never into the caller's own code. See the plan's Context section for the full
// comparison.

export type PromptRow = {
  id: string;
  name: string;
  description: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PromptVersionRow = {
  id: string;
  promptId: string;
  version: number;
  text: string;
  source: string;
  reasoning: string | null;
  basedOnVersion: number | null;
  createdAt: Date;
};

// Same free-form `evaluationSubject.metadata` trick as runs.ts's extractVersion — a run tagged
// via `subject={"metadata": {"promptName": "...", "version": "name@vN"}}` needs zero SDK changes
// to be discoverable here.
function extractPromptName(evaluationSubject: unknown): string | null {
  if (!evaluationSubject || typeof evaluationSubject !== "object") {
    return null;
  }
  const subject = evaluationSubject as { metadata?: { promptName?: unknown } };
  if (typeof subject.metadata?.promptName === "string" && subject.metadata.promptName.trim()) {
    return subject.metadata.promptName.trim();
  }
  return null;
}

function promptToWire(row: PromptRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function versionToWire(row: PromptVersionRow) {
  return {
    version: row.version,
    text: row.text,
    source: row.source,
    reasoning: row.reasoning ?? undefined,
    basedOnVersion: row.basedOnVersion ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createPrompt(db: Db, input: { name: string; text: string; description?: string }) {
  const now = new Date();
  const promptRow: PromptRow = {
    id: nanoid(),
    name: input.name,
    description: input.description ?? null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const versionRow: PromptVersionRow = {
    id: nanoid(),
    promptId: promptRow.id,
    version: 1,
    text: input.text,
    source: "manual",
    reasoning: null,
    basedOnVersion: null,
    createdAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.prompts).values(promptRow);
    await db.db.insert(db.schema.promptVersions).values(versionRow);
  } else {
    await db.db.insert(db.schema.prompts).values(promptRow);
    await db.db.insert(db.schema.promptVersions).values(versionRow);
  }
  return { ...promptToWire(promptRow), version: versionRow.version, text: versionRow.text };
}

export async function getPromptRow(db: Db, id: string): Promise<PromptRow | null> {
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.prompts).where(eq(db.schema.prompts.id, id)).all()[0] as PromptRow | undefined)
      : ((await db.db.select().from(db.schema.prompts).where(eq(db.schema.prompts.id, id)))[0] as PromptRow | undefined);
  return row ?? null;
}

async function getPromptRowByName(db: Db, name: string): Promise<PromptRow | null> {
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.prompts).where(eq(db.schema.prompts.name, name)).all()[0] as PromptRow | undefined)
      : ((await db.db.select().from(db.schema.prompts).where(eq(db.schema.prompts.name, name)))[0] as PromptRow | undefined);
  return row ?? null;
}

export async function getPromptVersionRow(db: Db, promptId: string, version: number): Promise<PromptVersionRow | null> {
  const cond = and(eq(db.schema.promptVersions.promptId, promptId), eq(db.schema.promptVersions.version, version));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.promptVersions).where(cond).all()[0] as PromptVersionRow | undefined)
      : ((await db.db.select().from(db.schema.promptVersions).where(cond))[0] as PromptVersionRow | undefined);
  return row ?? null;
}

export async function listPromptVersionRows(db: Db, promptId: string): Promise<PromptVersionRow[]> {
  const cond = eq(db.schema.promptVersions.promptId, promptId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.promptVersions).where(cond).all()
      : await db.db.select().from(db.schema.promptVersions).where(cond)
  ) as PromptVersionRow[];
  rows.sort((a, b) => b.version - a.version);
  return rows;
}

export async function listPromptRows(db: Db): Promise<PromptRow[]> {
  const rows = (
    db.kind === "sqlite" ? db.db.select().from(db.schema.prompts).all() : await db.db.select().from(db.schema.prompts)
  ) as PromptRow[];
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows;
}

export async function listPromptsWire(db: Db) {
  return (await listPromptRows(db)).map(promptToWire);
}

export async function getPromptWithVersionsWire(db: Db, id: string) {
  const row = await getPromptRow(db, id);
  if (!row) return null;
  const versions = await listPromptVersionRows(db, id);
  return { ...promptToWire(row), versions: versions.map(versionToWire) };
}

// SDK-facing pull: `client.evaluations.prompts.get(name, version=None)`. Defaults to the
// current published version; an explicit version pulls that historical text (e.g. for
// re-running an older prompt against a dataset for comparison).
export async function getPromptForSdk(db: Db, name: string, version?: number) {
  const row = await getPromptRowByName(db, name);
  if (!row) return null;
  const versionRow = await getPromptVersionRow(db, row.id, version ?? row.currentVersion);
  if (!versionRow) return null;
  return { ...promptToWire(row), version: versionRow.version, text: versionRow.text };
}

export async function listPromptsForSdk(db: Db) {
  const rows = await listPromptRows(db);
  const allVersions = (
    db.kind === "sqlite" ? db.db.select().from(db.schema.promptVersions).all() : await db.db.select().from(db.schema.promptVersions)
  ) as PromptVersionRow[];
  const versionMap = new Map(allVersions.map(v => [`${v.promptId}:${v.version}`, v]));
  return rows.map(row => {
    const versionRow = versionMap.get(`${row.id}:${row.currentVersion}`);
    return { ...promptToWire(row), version: row.currentVersion, text: versionRow?.text ?? "" };
  });
}

// The only write path for a version — used both for a manual edit and for accepting a proposal
// (source: "proposed", reasoning/basedOnVersion set), keeping propose/publish as two separate
// calls so a proposal never reaches storage without a human explicitly approving it.
export async function publishPromptVersion(
  db: Db,
  promptId: string,
  input: { text: string; source?: string; reasoning?: string; basedOnVersion?: number }
) {
  const prompt = await getPromptRow(db, promptId);
  if (!prompt) return null;
  const now = new Date();
  const nextVersion = prompt.currentVersion + 1;
  const versionRow: PromptVersionRow = {
    id: nanoid(),
    promptId,
    version: nextVersion,
    text: input.text,
    source: input.source ?? "manual",
    reasoning: input.reasoning ?? null,
    basedOnVersion: input.basedOnVersion ?? null,
    createdAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.promptVersions).values(versionRow);
    await db.db.update(db.schema.prompts).set({ currentVersion: nextVersion, updatedAt: now }).where(eq(db.schema.prompts.id, promptId));
  } else {
    await db.db.insert(db.schema.promptVersions).values(versionRow);
    await db.db.update(db.schema.prompts).set({ currentVersion: nextVersion, updatedAt: now }).where(eq(db.schema.prompts.id, promptId));
  }
  return { ...promptToWire({ ...prompt, currentVersion: nextVersion, updatedAt: now }), version: versionRow.version, text: versionRow.text };
}

export async function deletePrompt(db: Db, id: string): Promise<boolean> {
  const existing = await getPromptRow(db, id);
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.promptVersions).where(eq(db.schema.promptVersions.promptId, id));
    await db.db.delete(db.schema.prompts).where(eq(db.schema.prompts.id, id));
  } else {
    await db.db.delete(db.schema.promptVersions).where(eq(db.schema.promptVersions.promptId, id));
    await db.db.delete(db.schema.prompts).where(eq(db.schema.prompts.id, id));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Propose improvement — the actual "autotune" step. Never writes on its own; the dashboard
// shows the result and a human calls publishPromptVersion (source: "proposed") to accept it.
// ---------------------------------------------------------------------------

export type WorstRatedExample = {
  // "eval_run": a deliberate, on-demand Evaluate run against a dataset. "online_evaluator": a
  // continuous LLM-judge rating of real production traffic (core/monitor/onlineEvaluators.ts) —
  // no dataset behind it, so never has expectedResults.
  source: "eval_run" | "online_evaluator";
  input: string;
  output: string;
  rating: number;
  justification: string | null;
  // The dataset author's golden answer for this example's question, when resolvable (see
  // getWorstRatedExamples) — lets the rewriting judge compare actual-vs-expected directly instead
  // of only through the original grading judge's paraphrase (`justification`).
  expectedResults?: string;
};
export type WorstRatedExamplesResult = {
  promptName: string;
  currentVersion: number;
  currentText: string;
  examples: WorstRatedExample[];
  // What was actually used to gather `examples`, so a caller (the dashboard) can show it instead
  // of the scope silently changing — see getWorstRatedExamples's auto-widen fallback.
  scope: { versionScoped: boolean; window: MonitoringWindow };
};

// The data half of "propose an improvement," with no judge call — reused by
// proposePromptImprovement (server-side judge path, below) AND the GET /prompts/:id/examples
// route (routes/evaluateDashboard.ts), which hands the same real evidence to a Claude Code skill
// instead: the skill's own reasoning stands in for the judge call, so a self-host install with no
// OPENAI_API_KEY/ANTHROPIC_API_KEY configured on the engine can still drive the exact same
// propose -> human-approve -> publish loop. One implementation, two callers.
// Merges both sources' examples (worst first) and caps the total — same 20-example cap either
// side used individually before this merge existed.
function mergeAndCap(examples: WorstRatedExample[]): WorstRatedExample[] {
  return examples
    .slice()
    .sort((a, b) => a.rating - b.rating)
    .slice(0, 20);
}

export async function getWorstRatedExamples(
  db: Db,
  promptId: string,
  opts: { datasetId?: string; includeAllVersions?: boolean; window?: MonitoringWindow } = {}
): Promise<WorstRatedExamplesResult | null> {
  const prompt = await getPromptRow(db, promptId);
  if (!prompt) return null;
  const currentVersionRow = await getPromptVersionRow(db, promptId, prompt.currentVersion);
  if (!currentVersionRow) return null;

  const window = opts.window ?? "7d";
  // Same two-line cutoff-math convention core/monitor/events.ts's private windowConfig() (and
  // every one of its callers) already uses — not exported there, so replicated here rather than
  // forcing a new export for one caller.
  const windowDays = window === "24h" ? 1 : window === "30d" ? 30 : 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // --- Eval-run half: deliberate, on-demand Evaluate runs tagged with this prompt's name --------
  const gatherEvalRunExamples = async (includeAllVersions: boolean): Promise<WorstRatedExample[]> => {
    const runsCond = opts.datasetId ? eq(db.schema.evaluationRuns.datasetId, opts.datasetId) : undefined;
    const allRuns = (
      db.kind === "sqlite"
        ? runsCond
          ? db.db.select().from(db.schema.evaluationRuns).where(runsCond).all()
          : db.db.select().from(db.schema.evaluationRuns).all()
        : runsCond
          ? await db.db.select().from(db.schema.evaluationRuns).where(runsCond)
          : await db.db.select().from(db.schema.evaluationRuns)
    ) as { id: string; datasetId: string; version: string | null; evaluationSubject: unknown }[];

    // Matches PromptClient's documented tagging convention (subject.metadata.version =
    // "{name}@v{version}") — same string the sample script and every caller of prompts.get()
    // is expected to use. Without this, a v3 prompt's rewrite gets polluted by v1 complaints
    // that v2/v3 may have already fixed.
    const currentVersionTag = `${prompt.name}@v${prompt.currentVersion}`;
    let matchingRuns = allRuns.filter(r => extractPromptName(r.evaluationSubject) === prompt.name);
    if (!includeAllVersions) {
      matchingRuns = matchingRuns.filter(r => r.version === currentVersionTag);
    }
    const matchingRunIds = matchingRuns.map(r => r.id);
    const datasetIdByRunId = new Map(matchingRuns.map(r => [r.id, r.datasetId]));
    if (matchingRunIds.length === 0) {
      return [];
    }

    const resultsCond = inArray(db.schema.evaluationRunResults.runId, matchingRunIds);
    const results = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.evaluationRunResults).where(resultsCond).all()
        : await db.db.select().from(db.schema.evaluationRunResults).where(resultsCond)
    ) as {
      runId: string;
      questionIndex: number | null;
      input: unknown;
      output: unknown;
      rating: number | null;
      justification: string | null;
    }[];

    const rated = results
      .filter((r): r is typeof r & { rating: number } => r.rating !== null)
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 20);

    // Resolve each example's expected result (the dataset author's golden answer for that
    // question) so the rewriting judge can compare actual-vs-expected directly — see
    // WorstRatedExample's comment. Only resolves main questions
    // (questions[i].main_question.expectedResults); follow-up questions aren't separately
    // indexed by the SDK's current run-building logic, so this covers every example in practice
    // today. Cached per dataset id so a batch of examples from the same dataset (the common
    // case) only fetches it once.
    const datasetCache = new Map<string, Awaited<ReturnType<typeof getDataset>>>();
    const resolveExpectedResults = async (runId: string, questionIndex: number | null): Promise<string | undefined> => {
      if (questionIndex == null) return undefined;
      const datasetId = datasetIdByRunId.get(runId);
      if (!datasetId) return undefined;
      if (!datasetCache.has(datasetId)) {
        datasetCache.set(datasetId, await getDataset(db, datasetId));
      }
      const dataset = datasetCache.get(datasetId);
      const questions = (dataset?.questions ?? []) as Array<{ main_question?: { expectedResults?: string } }>;
      const expected = questions[questionIndex]?.main_question?.expectedResults;
      return typeof expected === "string" && expected.trim() ? expected : undefined;
    };

    return Promise.all(
      rated.map(async r => ({
        source: "eval_run" as const,
        input: extractText(r.input),
        output: extractText(r.output),
        rating: r.rating,
        justification: r.justification,
        expectedResults: await resolveExpectedResults(r.runId, r.questionIndex),
      }))
    );
  };

  // --- Online Evaluator half: continuous LLM-judge ratings of real production traffic -----------
  // monitor_events has no input/output text (see core/monitor/onlineEvaluators.ts's recordEvent
  // call — only rating/justification/traceId), so this joins back to `traces` via getTraceRow
  // (core/trace/ingest.ts, already used by portability.ts for the same "need the raw
  // input/metadata" need). Filtering by the time window first (monitor_events has an index on
  // created_at) keeps the join count bounded without needing a new promptName column anywhere.
  const gatherOnlineEvaluatorExamples = async (): Promise<WorstRatedExample[]> => {
    const cond = and(gte(db.schema.monitorEvents.createdAt, since), eq(db.schema.monitorEvents.type, "online_eval_score"));
    const events = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
        : await db.db.select().from(db.schema.monitorEvents).where(cond)
    ) as { traceId: string | null; rating: number | null; justification: string | null }[];

    const rated = events
      .filter((e): e is typeof e & { rating: number; traceId: string } => e.rating !== null && e.traceId !== null)
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 20);

    const resolved = await Promise.all(
      rated.map(async e => {
        const trace = await getTraceRow(db, e.traceId);
        const metadata = trace?.metadata as { promptName?: unknown } | null | undefined;
        if (!trace || metadata?.promptName !== prompt.name) {
          return null;
        }
        const example: WorstRatedExample = {
          source: "online_evaluator",
          input: extractText(trace.input),
          output: extractText(trace.output),
          rating: e.rating,
          justification: e.justification,
        };
        return example;
      })
    );
    return resolved.filter((e): e is WorstRatedExample => e !== null);
  };

  const onlineEvaluatorExamples = await gatherOnlineEvaluatorExamples();

  // Default to the current published version only; auto-widen to every version if that's too
  // thin to be useful, rather than silently mixing possibly-already-fixed old-version issues in
  // from the start. The caller (dashboard) reads `scope.versionScoped` back to show which
  // actually happened instead of guessing.
  let versionScoped = !opts.includeAllVersions;
  let evalRunExamples = await gatherEvalRunExamples(!versionScoped);
  let merged = mergeAndCap([...evalRunExamples, ...onlineEvaluatorExamples]);
  if (versionScoped && merged.length < 3) {
    versionScoped = false;
    evalRunExamples = await gatherEvalRunExamples(true);
    merged = mergeAndCap([...evalRunExamples, ...onlineEvaluatorExamples]);
  }

  return {
    promptName: prompt.name,
    currentVersion: prompt.currentVersion,
    currentText: currentVersionRow.text,
    examples: merged,
    scope: { versionScoped, window },
  };
}

export type ProposalResult = {
  hasExamples: boolean;
  exampleCount: number;
  // How many of `exampleCount` came from each source — the dashboard shows this so "based on
  // real evaluation feedback" isn't just the merged total, both contributions stay visible.
  sourceBreakdown: { evalRun: number; onlineEvaluator: number };
  basedOnVersion: number;
  revisedText: string | null;
  reasoning: string | null;
  scope: { versionScoped: boolean; window: MonitoringWindow };
};

function countBySource(examples: WorstRatedExample[]): { evalRun: number; onlineEvaluator: number } {
  return {
    evalRun: examples.filter(e => e.source === "eval_run").length,
    onlineEvaluator: examples.filter(e => e.source === "online_evaluator").length,
  };
}

export async function proposePromptImprovement(
  db: Db,
  promptId: string,
  opts: { datasetId?: string; includeAllVersions?: boolean; window?: MonitoringWindow } = {}
): Promise<ProposalResult | null> {
  const gathered = await getWorstRatedExamples(db, promptId, opts);
  if (!gathered) return null;

  const notEnoughData: ProposalResult = {
    hasExamples: false,
    exampleCount: 0,
    sourceBreakdown: { evalRun: 0, onlineEvaluator: 0 },
    basedOnVersion: gathered.currentVersion,
    revisedText: null,
    reasoning: null,
    scope: gathered.scope,
  };
  if (gathered.examples.length === 0) {
    return notEnoughData;
  }

  const examplesText = gathered.examples
    .map((r, i) => {
      const expectedLine = r.expectedResults ? `\nExpected: ${r.expectedResults}` : "";
      const sourceLabel = r.source === "online_evaluator" ? "production monitoring" : "eval dataset run";
      return `Example ${i + 1} [${sourceLabel}] (rating ${r.rating}/10):\nInput: ${r.input}\nOutput: ${r.output}${expectedLine}\nJudge feedback: ${r.justification ?? "N/A"}`;
    })
    .join("\n\n");

  const userMessage = `You are improving an AI agent's system prompt/instructions based on real evaluation feedback.

Current prompt:
"""
${gathered.currentText}
"""

Below are the worst-rated examples of this agent's actual behavior when using this prompt, each with a judge's rating (0-10), the expected/golden answer when one was authored for that question, and feedback explaining what went wrong. "[eval dataset run]" examples are from deliberate test runs against a hand-authored dataset; "[production monitoring]" examples are from real live traffic, sampled and scored continuously — weigh both as real evidence of how this prompt performs.

${examplesText}

Where an "Expected" answer is given, use it as ground truth for what the response should have looked like, not just the judge feedback's paraphrase of it. Rewrite the prompt to address the recurring issues shown above. Return the complete revised prompt text (not a diff or partial edit) and a short explanation of what changed and why.`;

  const judgeResult = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    userMessage,
    jsonSchema: {
      type: "object",
      properties: {
        revisedPrompt: { type: "string", description: "The complete rewritten prompt text" },
        reasoning: { type: "string", description: "What changed and why, based on the examples" },
      },
      required: ["revisedPrompt", "reasoning"],
    },
  });

  const payload = judgeResult.payload as { revisedPrompt: string; reasoning: string } | null;
  if (!payload) {
    throw new Error("Judge model returned no proposal");
  }

  return {
    hasExamples: true,
    exampleCount: gathered.examples.length,
    sourceBreakdown: countBySource(gathered.examples),
    basedOnVersion: gathered.currentVersion,
    revisedText: payload.revisedPrompt,
    reasoning: payload.reasoning,
    scope: gathered.scope,
  };
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as { query?: string; text?: string };
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.text === "string") return obj.text;
  }
  return JSON.stringify(value ?? "");
}
