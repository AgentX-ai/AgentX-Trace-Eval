import { nanoid } from "nanoid";
import { eq, and, gte, inArray, lt, max } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { getDataset } from "./datasets.js";
import { getTraceRow } from "../trace/ingest.js";
import { listPlaygroundRunsByPrompt } from "./playgroundRuns.js";
import type { MonitoringWindow } from "../monitor/events.js";

// The external-agent prompt registry: since this engine doesn't own the caller's agent code,
// AgentX becomes the prompt's source of truth instead - the SDK pulls it at runtime
// (client.evaluations.prompts.get(name)), and a human-approved "propose improvement" step
// (proposePromptImprovement below) writes new versions here, never into the caller's own code.

export type PromptRow = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PromptVersionRow = {
  id: string;
  projectId: string | null;
  promptId: string;
  version: number;
  text: string;
  source: string;
  reasoning: string | null;
  basedOnVersion: number | null;
  createdAt: Date;
};

// Same free-form `evaluationSubject.metadata` trick as runs.ts's extractVersion: a run tagged
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
    projectId: db.projectId,
    name: input.name,
    description: input.description ?? null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const versionRow: PromptVersionRow = {
    id: nanoid(),
    projectId: db.projectId,
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

// Description edits from the prompt detail dialog - metadata only, never touches the version
// log (text changes go through publishPromptVersion). Mirrors toolSchemas.ts's updateToolSchemaMeta.
export async function updatePromptMeta(db: Db, id: string, input: { description?: string | null }): Promise<boolean> {
  const prompt = await getPromptRow(db, id);
  if (!prompt) return false;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  const cond = and(eq(db.schema.prompts.id, id), eq(db.schema.prompts.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.prompts).set(patch).where(cond);
  } else {
    await db.db.update(db.schema.prompts).set(patch).where(cond);
  }
  return true;
}

export async function getPromptRow(db: Db, id: string): Promise<PromptRow | null> {
  const cond = and(eq(db.schema.prompts.id, id), eq(db.schema.prompts.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.prompts).where(cond).all()[0] as PromptRow | undefined)
      : ((await db.db.select().from(db.schema.prompts).where(cond))[0] as PromptRow | undefined);
  return row ?? null;
}

async function getPromptRowByName(db: Db, name: string): Promise<PromptRow | null> {
  const cond = and(eq(db.schema.prompts.name, name), eq(db.schema.prompts.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.prompts).where(cond).all()[0] as PromptRow | undefined)
      : ((await db.db.select().from(db.schema.prompts).where(cond))[0] as PromptRow | undefined);
  return row ?? null;
}

// SDK callers may hand back either the human-chosen name they originally pulled by, or the
// prompt.id they got in that same response (e.g. round-tripping an id they stored earlier).
// Names and nanoid ids don't collide in practice, so trying name first and falling back to id
// lets `get()` accept either without needing a second SDK method or route.
async function getPromptRowByNameOrId(db: Db, identifier: string): Promise<PromptRow | null> {
  const byName = await getPromptRowByName(db, identifier);
  if (byName) {
    return byName;
  }
  return getPromptRow(db, identifier);
}

export async function getPromptVersionRow(db: Db, promptId: string, version: number): Promise<PromptVersionRow | null> {
  const cond = and(
    eq(db.schema.promptVersions.promptId, promptId),
    eq(db.schema.promptVersions.version, version),
    eq(db.schema.promptVersions.projectId, db.projectId)
  );
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.promptVersions).where(cond).all()[0] as PromptVersionRow | undefined)
      : ((await db.db.select().from(db.schema.promptVersions).where(cond))[0] as PromptVersionRow | undefined);
  return row ?? null;
}

export async function listPromptVersionRows(db: Db, promptId: string): Promise<PromptVersionRow[]> {
  const cond = and(eq(db.schema.promptVersions.promptId, promptId), eq(db.schema.promptVersions.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.promptVersions).where(cond).all()
      : await db.db.select().from(db.schema.promptVersions).where(cond)
  ) as PromptVersionRow[];
  rows.sort((a, b) => b.version - a.version);
  return rows;
}

export async function listPromptRows(db: Db): Promise<PromptRow[]> {
  const cond = eq(db.schema.prompts.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite" ? db.db.select().from(db.schema.prompts).where(cond).all() : await db.db.select().from(db.schema.prompts).where(cond)
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

// SDK-facing pull: `client.evaluations.prompts.get(name_or_id, version=None)`. Accepts either the
// prompt's name or its id (see getPromptRowByNameOrId), defaults to the current published
// version; an explicit version pulls that historical text (e.g. for re-running an older prompt
// against a dataset for comparison).
export async function getPromptForSdk(db: Db, nameOrId: string, version?: number) {
  const row = await getPromptRowByNameOrId(db, nameOrId);
  if (!row) return null;
  const versionRow = await getPromptVersionRow(db, row.id, version ?? row.currentVersion);
  if (!versionRow) return null;
  return { ...promptToWire(row), version: versionRow.version, text: versionRow.text };
}

export async function listPromptsForSdk(db: Db) {
  const rows = await listPromptRows(db);
  const versionsCond = eq(db.schema.promptVersions.projectId, db.projectId);
  const allVersions = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.promptVersions).where(versionsCond).all()
      : await db.db.select().from(db.schema.promptVersions).where(versionsCond)
  ) as PromptVersionRow[];
  const versionMap = new Map(allVersions.map(v => [`${v.promptId}:${v.version}`, v]));
  return rows.map(row => {
    const versionRow = versionMap.get(`${row.id}:${row.currentVersion}`);
    return { ...promptToWire(row), version: row.currentVersion, text: versionRow?.text ?? "" };
  });
}

// The only write path for a version, used both for a manual edit and for accepting a proposal
// (source: "proposed", reasoning/basedOnVersion set), keeping propose/publish as two separate
// calls so a proposal never reaches storage without a human explicitly approving it.
// Headroom for real contention without spinning if something is genuinely wrong.
const PUBLISH_MAX_ATTEMPTS = 8;

// The next version has to come from the versions table, not from prompts.currentVersion: that
// column is only updated after the insert, so a loser re-reading it computes the number it just
// lost with and burns the whole budget without ever moving forward.
async function nextFreeVersion(db: Db, promptId: string, atLeast: number): Promise<number> {
  const cond = and(eq(db.schema.promptVersions.promptId, promptId), eq(db.schema.promptVersions.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select({ latest: max(db.schema.promptVersions.version) }).from(db.schema.promptVersions).where(cond).all()
      : await db.db.select({ latest: max(db.schema.promptVersions.version) }).from(db.schema.promptVersions).where(cond)
  ) as { latest: number | null }[];
  return Math.max(rows[0]?.latest ?? 0, atLeast) + 1;
}

export async function publishPromptVersion(
  db: Db,
  promptId: string,
  input: { text: string; source?: string; reasoning?: string; basedOnVersion?: number }
) {
  // The version number comes from a separate read, so two simultaneous publishes compute the same
  // one. The unique index stops that becoming two rows claiming v4; this loop stops the loser being
  // told "Internal server error" and losing its edit. Re-read, take the next free number, retry.
  let lastVersion = 0;
  for (let attempt = 0; attempt < PUBLISH_MAX_ATTEMPTS; attempt++) {
    const prompt = await getPromptRow(db, promptId);
    if (!prompt) return null;
    const now = new Date();
    const nextVersion = await nextFreeVersion(db, promptId, prompt.currentVersion);
    lastVersion = nextVersion;
    const versionRow: PromptVersionRow = {
      id: nanoid(),
      projectId: db.projectId,
      promptId,
      version: nextVersion,
      text: input.text,
      source: input.source ?? "manual",
      reasoning: input.reasoning ?? null,
      basedOnVersion: input.basedOnVersion ?? null,
      createdAt: now,
    };
    const inserted = (
      db.kind === "sqlite"
        ? db.db.insert(db.schema.promptVersions).values(versionRow).onConflictDoNothing().returning({ id: db.schema.promptVersions.id }).all()
        : await db.db.insert(db.schema.promptVersions).values(versionRow).onConflictDoNothing().returning({ id: db.schema.promptVersions.id })
    ) as { id: string }[];
    if (!inserted[0]) {
      continue;
    }
    // Only moves forward: a publish finishing second must not drag it back over a higher one.
    const updateCond = and(
      eq(db.schema.prompts.id, promptId),
      eq(db.schema.prompts.projectId, db.projectId),
      lt(db.schema.prompts.currentVersion, nextVersion)
    );
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.prompts).set({ currentVersion: nextVersion, updatedAt: now }).where(updateCond);
    } else {
      await db.db.update(db.schema.prompts).set({ currentVersion: nextVersion, updatedAt: now }).where(updateCond);
    }
    const current = await getPromptRow(db, promptId);
    return {
      ...promptToWire({ ...prompt, currentVersion: current?.currentVersion ?? nextVersion, updatedAt: now }),
      version: versionRow.version,
      text: versionRow.text,
    };
  }
  // Losing a race is the caller's to retry, not a server fault - a 500 here would tell the
  // dashboard the engine broke when it simply lost a scramble for the next number.
  throw Object.assign(
    new Error(`Could not publish a new version of prompt ${promptId} after ${PUBLISH_MAX_ATTEMPTS} attempts (last tried v${lastVersion})`),
    { status: 409 }
  );
}

export async function deletePrompt(db: Db, id: string): Promise<boolean> {
  const existing = await getPromptRow(db, id);
  if (!existing) {
    return false;
  }
  const versionsCond = and(eq(db.schema.promptVersions.promptId, id), eq(db.schema.promptVersions.projectId, db.projectId));
  const promptCond = and(eq(db.schema.prompts.id, id), eq(db.schema.prompts.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.promptVersions).where(versionsCond);
    await db.db.delete(db.schema.prompts).where(promptCond);
  } else {
    await db.db.delete(db.schema.promptVersions).where(versionsCond);
    await db.db.delete(db.schema.prompts).where(promptCond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Propose improvement: the actual "autotune" step. Never writes on its own; the dashboard
// shows the result and a human calls publishPromptVersion (source: "proposed") to accept it.
// ---------------------------------------------------------------------------

export type WorstRatedExample = {
  // Stable id of the underlying row (evaluation_run_results.id for "eval_run",
  // monitor_events.id for "online_evaluator"), lets a caller select a subset of examples (see
  // proposePromptImprovement's exampleIds) by referencing exactly what GET /prompts/:id/examples
  // returned, instead of re-deriving a match from mutable fields like rating/input.
  id: string;
  // "eval_run": a deliberate, on-demand Evaluate run against a dataset. "online_evaluator": a
  // continuous LLM-judge rating of real production traffic (core/monitor/onlineEvaluators.ts):
  // no dataset behind it, so never has expectedResults. "playground": a human reviewer explicitly
  // marked a Playground cell's output "bad" while testing this prompt (core/evaluate/
  // playgroundRuns.ts) - always has a synthetic rating of 0 (see gatherPlaygroundExamples below),
  // since there's no judge score to carry over, only a human verdict.
  source: "eval_run" | "online_evaluator" | "playground";
  input: string;
  output: string;
  rating: number;
  justification: string | null;
  createdAt: string;
  // The dataset author's golden answer for this example's question, when resolvable (see
  // getWorstRatedExamples), lets the rewriting judge compare actual-vs-expected directly instead
  // of only through the original grading judge's paraphrase (`justification`).
  expectedResults?: string;
  // Present when the underlying result/event has one (both sources can, see toResultWire's
  // traceId and monitor_events' own column), lets the dashboard link straight to the trace
  // instead of only showing the input/output text captured at scoring time.
  traceId?: string;
};
export type WorstRatedExamplesResult = {
  promptName: string;
  currentVersion: number;
  currentText: string;
  examples: WorstRatedExample[];
  // What was actually used to gather `examples`, so a caller (the dashboard) can show it instead
  // of the scope silently changing, see getWorstRatedExamples's auto-widen fallback.
  scope: { versionScoped: boolean; window: MonitoringWindow };
};

// The data half of "propose an improvement," with no judge call - reused by
// proposePromptImprovement (server-side judge path, below) AND the GET /prompts/:id/examples
// route (routes/evaluateDashboard.ts), which hands the same real evidence to a Claude Code skill
// instead: the skill's own reasoning stands in for the judge call, so a self-host install with no
// OPENAI_API_KEY/ANTHROPIC_API_KEY configured on the engine can still drive the exact same
// propose -> human-approve -> publish loop. One implementation, two callers.
// Merges both sources' examples (worst first) and caps the total: same 20-example cap either
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
  // every one of its callers) already uses, not exported there, so replicated here rather than
  // forcing a new export for one caller.
  const windowDays = window === "24h" ? 1 : window === "30d" ? 30 : 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // --- Eval-run half: deliberate, on-demand Evaluate runs tagged with this prompt's name --------
  const gatherEvalRunExamples = async (includeAllVersions: boolean): Promise<WorstRatedExample[]> => {
    const runsCond = opts.datasetId
      ? and(eq(db.schema.evaluationRuns.datasetId, opts.datasetId), eq(db.schema.evaluationRuns.projectId, db.projectId))
      : eq(db.schema.evaluationRuns.projectId, db.projectId);
    const allRuns = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.evaluationRuns).where(runsCond).all()
        : await db.db.select().from(db.schema.evaluationRuns).where(runsCond)
    ) as { id: string; datasetId: string; version: string | null; evaluationSubject: unknown }[];

    // Matches PromptClient's documented tagging convention (subject.metadata.version =
    // "{name}@v{version}"), same string the sample script and every caller of prompts.get()
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

    const resultsCond = and(
      inArray(db.schema.evaluationRunResults.runId, matchingRunIds),
      eq(db.schema.evaluationRunResults.projectId, db.projectId)
    );
    const results = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.evaluationRunResults).where(resultsCond).all()
        : await db.db.select().from(db.schema.evaluationRunResults).where(resultsCond)
    ) as {
      id: string;
      runId: string;
      questionIndex: number | null;
      input: unknown;
      output: unknown;
      rating: number | null;
      justification: string | null;
      traceId: string | null;
      createdAt: Date;
    }[];

    const rated = results
      .filter((r): r is typeof r & { rating: number } => r.rating !== null)
      .sort((a, b) => a.rating - b.rating)
      .slice(0, 20);

    // Resolve each example's expected result (the dataset author's golden answer for that
    // question) so the rewriting judge can compare actual-vs-expected directly, see
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
        id: r.id,
        source: "eval_run" as const,
        input: extractText(r.input),
        output: extractText(r.output),
        rating: r.rating,
        justification: r.justification,
        createdAt: r.createdAt.toISOString(),
        expectedResults: await resolveExpectedResults(r.runId, r.questionIndex),
        traceId: r.traceId ?? undefined,
      }))
    );
  };

  // --- Online Evaluator half: continuous LLM-judge ratings of real production traffic -----------
  // monitor_events has no input/output text (see core/monitor/onlineEvaluators.ts's recordEvent
  // call, only rating/justification/traceId), so this joins back to `traces` via getTraceRow
  // (core/trace/ingest.ts, already used by portability.ts for the same "need the raw
  // input/metadata" need). Filtering by the time window first (monitor_events has an index on
  // created_at) keeps the join count bounded without needing a new promptName column anywhere.
  const gatherOnlineEvaluatorExamples = async (): Promise<WorstRatedExample[]> => {
    const cond = and(
      gte(db.schema.monitorEvents.createdAt, since),
      eq(db.schema.monitorEvents.type, "online_eval_score"),
      eq(db.schema.monitorEvents.projectId, db.projectId)
    );
    const events = (
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
        : await db.db.select().from(db.schema.monitorEvents).where(cond)
    ) as {
      id: string;
      traceId: string | null;
      rating: number | null;
      justification: string | null;
      createdAt: Date;
    }[];

    // Worst-first, but the 20-cap applies to MATCHING examples, not raw events: capping before
    // the promptName filter (the original behavior) silently starved any prompt whose traffic
    // wasn't among the instance's 20 worst-rated events overall, so on a busy instance a prompt's
    // production evidence never surfaced at all. The trace join is resolved lazily inside the
    // loop, stopping at 20 matches, so the typical join count stays as bounded as before.
    const rated = events
      .filter((e): e is typeof e & { rating: number; traceId: string } => e.rating !== null && e.traceId !== null)
      .sort((a, b) => a.rating - b.rating);

    const matched: WorstRatedExample[] = [];
    for (const e of rated) {
      if (matched.length >= 20) {
        break;
      }
      const trace = await getTraceRow(db, e.traceId);
      const metadata = trace?.metadata as { promptName?: unknown } | null | undefined;
      if (!trace || metadata?.promptName !== prompt.name) {
        continue;
      }
      matched.push({
        id: e.id,
        source: "online_evaluator",
        input: extractText(trace.input),
        output: extractText(trace.output),
        rating: e.rating,
        justification: e.justification,
        createdAt: e.createdAt.toISOString(),
        traceId: e.traceId,
      });
    }
    return matched;
  };

  const onlineEvaluatorExamples = await gatherOnlineEvaluatorExamples();

  // --- Playground human-review half: a reviewer explicitly marked a cell's output "bad" while ---
  // testing this prompt in Playground (core/evaluate/playgroundRuns.ts's playground_runs, joined
  // by its promptId column). Not time-windowed or version-scoped like the other two sources - a
  // review is tied to one specific reviewed session, not "the last N days of this prompt" - so
  // every run tagged with this promptId contributes regardless of `window`/`includeAllVersions`.
  // `results` is opaque JSON as far as playgroundRuns.ts is concerned (shaped by the frontend's
  // CellState/HumanReview, playgroundChartData.ts); this file has no import path to that package,
  // so the shape is duplicated structurally, read-only, below.
  const gatherPlaygroundExamples = async (): Promise<WorstRatedExample[]> => {
    const runs = await listPlaygroundRunsByPrompt(db, promptId);
    const examples: WorstRatedExample[] = [];
    for (const run of runs) {
      const snapshot = (run.snapshot ?? {}) as { questions?: { index: number; query?: string }[] };
      const cells = (run.results ?? {}) as Record<
        string,
        {
          result?: { output?: string | null } | null;
          humanReview?: { verdict: "good" | "bad"; note?: string; correctedOutput?: string; reviewedAt: string } | null;
        }
      >;
      for (const [key, cell] of Object.entries(cells)) {
        const output = cell.result?.output;
        if (cell.humanReview?.verdict !== "bad" || !output) {
          continue; // a "good" verdict, or a "bad" one on a cell with no output (an errored run), isn't usable evidence
        }
        const questionIndex = Number(key.split("::")[1]);
        const question = snapshot.questions?.find(q => q.index === questionIndex);
        examples.push({
          id: `${run.id}:${key}`,
          source: "playground",
          input: question?.query ?? "",
          output,
          rating: 0,
          justification: cell.humanReview.note ?? null,
          createdAt: cell.humanReview.reviewedAt,
          expectedResults: cell.humanReview.correctedOutput,
        });
      }
    }
    return examples;
  };
  const playgroundExamples = await gatherPlaygroundExamples();

  // Default to the current published version only; auto-widen to every version if that's too
  // thin to be useful, rather than silently mixing possibly-already-fixed old-version issues in
  // from the start. The caller (dashboard) reads `scope.versionScoped` back to show which
  // actually happened instead of guessing.
  let versionScoped = !opts.includeAllVersions;
  let evalRunExamples = await gatherEvalRunExamples(!versionScoped);
  let merged = mergeAndCap([...evalRunExamples, ...onlineEvaluatorExamples, ...playgroundExamples]);
  if (versionScoped && merged.length < 3) {
    versionScoped = false;
    evalRunExamples = await gatherEvalRunExamples(true);
    merged = mergeAndCap([...evalRunExamples, ...onlineEvaluatorExamples, ...playgroundExamples]);
  }

  return {
    promptName: prompt.name,
    currentVersion: prompt.currentVersion,
    currentText: currentVersionRow.text,
    examples: merged,
    scope: { versionScoped, window },
  };
}

// One line of the judge's structured "what changed" summary, replacing a single freeform
// paragraph so the dashboard can render each change as its own tagged row instead of a wall of
// prose. `reasoning` is kept alongside as a short overall summary (also used as the version's
// stored `reasoning` on publish).
export type PromptChange = {
  tag: "added" | "tightened" | "removed";
  text: string;
};

export type ProposalResult = {
  hasExamples: boolean;
  exampleCount: number;
  // How many of `exampleCount` came from each source: the dashboard shows this so "based on
  // real evaluation feedback" isn't just the merged total, all three contributions stay visible.
  sourceBreakdown: { evalRun: number; onlineEvaluator: number; playground: number };
  basedOnVersion: number;
  revisedText: string | null;
  reasoning: string | null;
  changes: PromptChange[];
  // The actual judge model used, echoed back rather than hardcoded client-side, so the dashboard
  // never shows a model name that doesn't match what really produced the proposal.
  judgeModel: string;
  scope: { versionScoped: boolean; window: MonitoringWindow };
  // The exact evidence the judge above was given, worst-rated first, so the dialog can show it
  // instead of just a count, this is what actually produced the rewrite, not a re-fetch that
  // could in principle drift from what the judge saw (a new online-evaluator score landing
  // between two separate calls, say).
  examples: WorstRatedExample[];
};

function countBySource(examples: WorstRatedExample[]): { evalRun: number; onlineEvaluator: number; playground: number } {
  return {
    evalRun: examples.filter(e => e.source === "eval_run").length,
    onlineEvaluator: examples.filter(e => e.source === "online_evaluator").length,
    playground: examples.filter(e => e.source === "playground").length,
  };
}

export async function proposePromptImprovement(
  db: Db,
  promptId: string,
  opts: { datasetId?: string; includeAllVersions?: boolean; window?: MonitoringWindow; exampleIds?: string[] } = {}
): Promise<ProposalResult | null> {
  const gathered = await getWorstRatedExamples(db, promptId, opts);
  if (!gathered) return null;

  // A caller (the dashboard's evidence checklist) can narrow generation down to the examples a
  // human picked as representative, instead of always using every worst-rated example gathered.
  // Ids come from the same GET /prompts/:id/examples response the checklist renders, so this
  // never generates from anything the human didn't actually see.
  const selectedExamples =
    opts.exampleIds && opts.exampleIds.length > 0
      ? gathered.examples.filter(e => opts.exampleIds!.includes(e.id))
      : gathered.examples;

  const notEnoughData: ProposalResult = {
    hasExamples: false,
    exampleCount: 0,
    sourceBreakdown: { evalRun: 0, onlineEvaluator: 0, playground: 0 },
    basedOnVersion: gathered.currentVersion,
    revisedText: null,
    reasoning: null,
    changes: [],
    judgeModel: DEFAULT_JUDGE_MODEL,
    scope: gathered.scope,
    examples: [],
  };
  if (selectedExamples.length === 0) {
    return notEnoughData;
  }

  const examplesText = selectedExamples
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

Below are the worst-rated examples of this agent's actual behavior when using this prompt, each with a judge's rating (0-10), the expected/golden answer when one was authored for that question, and feedback explaining what went wrong. "[eval dataset run]" examples are from deliberate test runs against a hand-authored dataset; "[production monitoring]" examples are from real live traffic, sampled and scored continuously. Weigh both as real evidence of how this prompt performs.

${examplesText}

Where an "Expected" answer is given, use it as ground truth for what the response should have looked like, not just the judge feedback's paraphrase of it. Rewrite the prompt to address the recurring issues shown above. Return the complete revised prompt text (not a diff or partial edit), a short overall explanation of what changed and why, and an itemized list of specific changes, each tagged "added" (a new instruction), "tightened" (an existing instruction clarified or strengthened), or "removed" (an instruction taken out), with a one-sentence description each.`;

  const judgeResult = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    userMessage,
    jsonSchema: {
      type: "object",
      properties: {
        revisedPrompt: { type: "string", description: "The complete rewritten prompt text" },
        reasoning: { type: "string", description: "A short overall summary of what changed and why" },
        changes: {
          type: "array",
          description: "Itemized list of specific changes made",
          items: {
            type: "object",
            properties: {
              tag: { type: "string", enum: ["added", "tightened", "removed"] },
              text: { type: "string", description: "One-sentence description of this specific change" },
            },
            required: ["tag", "text"],
          },
        },
      },
      required: ["revisedPrompt", "reasoning", "changes"],
    },
  });

  const payload = judgeResult.payload as { revisedPrompt: string; reasoning: string; changes?: PromptChange[] } | null;
  if (!payload) {
    throw new Error("Judge model returned no proposal");
  }

  return {
    hasExamples: true,
    exampleCount: selectedExamples.length,
    sourceBreakdown: countBySource(selectedExamples),
    basedOnVersion: gathered.currentVersion,
    revisedText: payload.revisedPrompt,
    reasoning: payload.reasoning,
    changes: Array.isArray(payload.changes) ? payload.changes : [],
    judgeModel: DEFAULT_JUDGE_MODEL,
    scope: gathered.scope,
    examples: selectedExamples,
  };
}

// ---------------------------------------------------------------------------
// Failure theme clustering: a lightweight second judge pass over the same evidence, purely for
// display (see the dashboard's Evidence panel), grouping the worst-rated examples into a handful
// of named recurring failure modes. Never affects the actual rewrite, propose above still reads
// straight from the individual examples' justification, this exists only so a human scanning the
// evidence list gets a "what's actually going wrong, in aggregate" summary instead of having to
// read every justification themselves.
// ---------------------------------------------------------------------------

export type FailureTheme = {
  label: string;
  count: number;
};

export type FailureThemesResult = {
  themes: FailureTheme[];
  scope: { versionScoped: boolean; window: MonitoringWindow };
};

async function clusterFailureThemes(examples: WorstRatedExample[]): Promise<FailureTheme[]> {
  const examplesText = examples
    .map((r, i) => `Example ${i}: ${r.justification ?? `Output: ${r.output}`}`)
    .join("\n");

  const userMessage = `Below are judge justifications for why an AI agent's responses scored poorly, each prefixed with its example number.

${examplesText}

Group these into 3-6 short, specific recurring failure themes (e.g. "Curt or unempathetic tone", "No concrete next step offered"). Every example should belong to at least one theme; an example can belong to more than one if it exhibits multiple problems. Return each theme's short label and the example numbers that exhibit it.`;

  const judgeResult = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    userMessage,
    jsonSchema: {
      type: "object",
      properties: {
        themes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short (3-6 word) name for this failure theme" },
              exampleIndices: { type: "array", items: { type: "number" }, description: "0-based example numbers exhibiting this theme" },
            },
            required: ["label", "exampleIndices"],
          },
        },
      },
      required: ["themes"],
    },
  });

  const payload = judgeResult.payload as { themes?: { label: string; exampleIndices?: number[] }[] } | null;
  if (!payload || !Array.isArray(payload.themes)) {
    return [];
  }

  return payload.themes
    .map(t => ({ label: t.label, count: Array.isArray(t.exampleIndices) ? t.exampleIndices.length : 0 }))
    .filter(t => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

export async function getFailureThemes(
  db: Db,
  promptId: string,
  opts: { datasetId?: string; includeAllVersions?: boolean; window?: MonitoringWindow } = {}
): Promise<FailureThemesResult | null> {
  const gathered = await getWorstRatedExamples(db, promptId, opts);
  if (!gathered) return null;
  if (gathered.examples.length === 0) {
    return { themes: [], scope: gathered.scope };
  }
  const themes = await clusterFailureThemes(gathered.examples);
  return { themes, scope: gathered.scope };
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
