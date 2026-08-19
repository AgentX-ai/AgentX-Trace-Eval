import type { Db } from "../../storage/db.js";
import { runPlayground, type PlaygroundMessage } from "./playground.js";
import { resolveRunConfig } from "./runs.js";
import { getPromptRow, getPromptVersionRow } from "./prompts.js";
import { getToolSchemaRow, getToolSchemaVersionRow, getToolFailureExamples } from "./toolSchemas.js";
import { callModelWithTools, scoreAgainstCriteria, DEFAULT_JUDGE_PROMPT, DEFAULT_JUDGE_MODEL, type ToolDefinition } from "./judge.js";
import { compileUserRegex } from "../monitor/regexSafety.js";

// Propose -> VALIDATE -> publish: runs a proposal's candidate against the same golden dataset the
// current version would be graded on, so the human approving a rewrite approves a measured claim
// ("candidate scored 7.8 vs 6.1 on 18 cases, regressed on 2") instead of a plausible diff.
// Compute-and-return like propose itself - nothing persists; the dashboard appends the verdict to
// the published version's `reasoning` so history keeps the receipt.
//
// Deliberately an approximation, stated honestly in the UI: the dataset cases run against
// (candidate system prompt + chosen model), not the customer's full agent - self-host doesn't own
// their code (same boundary Model Portability documents). Directionally right is the goal:
// baseline and candidate run under identical conditions, so the DELTA is meaningful even where
// absolute scores differ from the real agent's.

const DEFAULT_MAX_CASES = 12;
const CASE_CONCURRENCY = 4;
export const DEFAULT_VALIDATION_MODEL = "gpt-4o-mini";

type VariantOutcome = {
  output: string | null;
  rating: number | null;
  justification: string | null;
  error: string | null;
};

export type ValidationCaseResult = {
  query: string;
  expected: string | null;
  turnCount: number;
  baseline: VariantOutcome;
  candidate: VariantOutcome;
  delta: number | null;
};

export type ValidationVerdict = "improved" | "regressed" | "tie" | "insufficient";

export type ValidationResult = {
  model: string;
  caseCount: number;
  scoredCount: number;
  baselineAvg: number | null;
  candidateAvg: number | null;
  delta: number | null;
  regressions: number;
  verdict: ValidationVerdict;
  summary: string;
  cases: ValidationCaseResult[];
};

type DatasetQuestion = {
  main_question?: { query?: unknown; expectedResults?: unknown; judgeGuideline?: unknown };
  follow_up_questions?: { query?: unknown; expectedResults?: unknown }[];
};

type CaseTurns = { turns: { query: string; expected: string | null; judgeGuideline?: string }[] };

function toCaseTurns(questions: unknown[]): CaseTurns[] {
  const cases: CaseTurns[] = [];
  for (const raw of questions as DatasetQuestion[]) {
    const mainQuery = typeof raw?.main_question?.query === "string" ? raw.main_question.query.trim() : "";
    if (!mainQuery) continue;
    const turns: CaseTurns["turns"] = [
      {
        query: mainQuery,
        expected: typeof raw.main_question?.expectedResults === "string" ? raw.main_question.expectedResults : null,
        judgeGuideline:
          typeof raw.main_question?.judgeGuideline === "string" ? raw.main_question.judgeGuideline : undefined,
      },
    ];
    for (const f of raw.follow_up_questions ?? []) {
      const q = typeof f?.query === "string" ? f.query.trim() : "";
      if (!q) continue;
      turns.push({ query: q, expected: typeof f?.expectedResults === "string" ? f.expectedResults : null });
    }
    cases.push({ turns });
  }
  return cases;
}

// Cases with a ground truth first (they're the ones that produce ratings and therefore a
// verdict), then the rest as capacity allows - a capped validation run shouldn't spend its budget
// on cases that can only ever show outputs.
function pickCases(cases: CaseTurns[], maxCases: number): CaseTurns[] {
  const withExpected = cases.filter(c => c.turns.some(t => t.expected));
  const without = cases.filter(c => !c.turns.some(t => t.expected));
  return [...withExpected, ...without].slice(0, maxCases);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

type JudgeConfig = {
  acceptanceCriteria: string;
  rejectionCriteria: string;
  evaluationCriteria: string;
  judgePrompt: string;
  judgeModel: string;
};

// Plays one case's turns in order under one system prompt: each turn's real reply is threaded
// back as conversation history for the next (via runPlayground, the same cell-runner the
// Playground grid uses). The case's rating is the mean over turns that had a ground truth.
async function runCaseVariant(
  db: Db,
  systemPrompt: string,
  model: string,
  turns: CaseTurns["turns"],
  judge: JudgeConfig
): Promise<VariantOutcome & { turnRatings: number[] }> {
  const messages: PlaygroundMessage[] = [{ role: "system", content: systemPrompt }];
  const turnRatings: number[] = [];
  let lastOutput: string | null = null;
  let lastJustification: string | null = null;
  for (const turn of turns) {
    const result = await runPlayground(db, {
      model,
      messages,
      query: turn.query,
      expected: turn.expected ?? undefined,
      judgeGuideline: turn.judgeGuideline,
      judgeCriteria: judge,
    });
    if (result.error || result.output === null) {
      return {
        output: lastOutput,
        rating: null,
        justification: null,
        error: result.error ?? "Model returned no output",
        turnRatings,
      };
    }
    lastOutput = result.output;
    if (result.rating !== null) {
      turnRatings.push(result.rating);
      lastJustification = result.justification;
    }
    messages.push({ role: "user", content: turn.query }, { role: "assistant", content: result.output });
  }
  const rating = turnRatings.length > 0 ? turnRatings.reduce((a, b) => a + b, 0) / turnRatings.length : null;
  return { output: lastOutput, rating, justification: lastJustification, error: null, turnRatings };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function buildVerdict(cases: ValidationCaseResult[]): Pick<ValidationResult, "scoredCount" | "baselineAvg" | "candidateAvg" | "delta" | "regressions" | "verdict" | "summary"> {
  // Pairwise-scored only: a case counts toward the averages when BOTH variants got a rating, so
  // one variant erroring can't skew the comparison.
  const scored = cases.filter(c => c.baseline.rating !== null && c.candidate.rating !== null);
  const regressions = scored.filter(c => (c.delta ?? 0) < -0.5).length;
  if (scored.length === 0) {
    return {
      scoredCount: 0,
      baselineAvg: null,
      candidateAvg: null,
      delta: null,
      regressions: 0,
      verdict: "insufficient",
      summary: "No cases could be scored on both versions - add expected answers to the dataset, or check the judge/model keys.",
    };
  }
  const baselineAvg = round1(scored.reduce((a, c) => a + (c.baseline.rating ?? 0), 0) / scored.length);
  const candidateAvg = round1(scored.reduce((a, c) => a + (c.candidate.rating ?? 0), 0) / scored.length);
  const delta = round1(candidateAvg - baselineAvg);
  const verdict: ValidationVerdict = delta > 0.2 ? "improved" : delta < -0.2 ? "regressed" : "tie";
  const summary = `Candidate scored ${candidateAvg} vs ${baselineAvg} baseline on ${scored.length} case${scored.length === 1 ? "" : "s"} (${delta >= 0 ? "+" : ""}${delta}${regressions > 0 ? `, ${regressions} regression${regressions === 1 ? "" : "s"}` : ""}).`;
  return { scoredCount: scored.length, baselineAvg, candidateAvg, delta, regressions, verdict, summary };
}

export async function validatePromptProposal(
  db: Db,
  promptId: string,
  input: { candidateText: string; datasetId: string; model?: string; maxCases?: number }
): Promise<ValidationResult | { error: string }> {
  const prompt = await getPromptRow(db, promptId);
  if (!prompt) return { error: "Prompt not found" };
  const currentVersion = await getPromptVersionRow(db, promptId, prompt.currentVersion);
  if (!currentVersion) return { error: "Prompt has no published version to compare against" };

  const config = await resolveRunConfig(db, input.datasetId, input.datasetId);
  const allCases = toCaseTurns(config.questions as unknown[]);
  if (allCases.length === 0) return { error: "That dataset has no cases" };
  const cases = pickCases(allCases, input.maxCases ?? DEFAULT_MAX_CASES);

  const model = input.model || DEFAULT_VALIDATION_MODEL;
  const judge: JudgeConfig = {
    acceptanceCriteria: config.acceptanceCriteria,
    rejectionCriteria: config.rejectionCriteria,
    evaluationCriteria: config.evaluationCriteria,
    judgePrompt: config.judgePrompt,
    judgeModel: config.judgeModel,
  };

  const caseResults = await mapWithConcurrency(cases, CASE_CONCURRENCY, async c => {
    const baseline = await runCaseVariant(db, currentVersion.text, model, c.turns, judge);
    const candidate = await runCaseVariant(db, input.candidateText, model, c.turns, judge);
    const delta =
      baseline.rating !== null && candidate.rating !== null ? round1(candidate.rating - baseline.rating) : null;
    return {
      query: c.turns[0]!.query,
      expected: c.turns[0]!.expected,
      turnCount: c.turns.length,
      baseline: { output: baseline.output, rating: baseline.rating, justification: baseline.justification, error: baseline.error },
      candidate: { output: candidate.output, rating: candidate.rating, justification: candidate.justification, error: candidate.error },
      delta,
    } satisfies ValidationCaseResult;
  });

  return { model, caseCount: caseResults.length, cases: caseResults, ...buildVerdict(caseResults) };
}

// --- Tool schema validation ---

type ParsedToolDefinition = { name: string; description?: string; parameters: Record<string, unknown> };

// Definitions are stored as opaque text ("judged not parsed" - see toolSchemas.ts), but
// validation genuinely needs the parameter schema, so this accepts the two JSON shapes the
// editor produces (bare {name, parameters} and OpenAI's {type: "function", function: {...}})
// and reports anything else as unvalidatable rather than guessing.
export function parseToolDefinition(definition: string): ParsedToolDefinition | null {
  try {
    const parsed = JSON.parse(definition) as Record<string, unknown>;
    const fn =
      parsed.type === "function" && parsed.function && typeof parsed.function === "object"
        ? (parsed.function as Record<string, unknown>)
        : parsed;
    if (typeof fn.name !== "string" || !fn.name.trim()) return null;
    return {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters && typeof fn.parameters === "object" ? (fn.parameters as Record<string, unknown>) : {},
    };
  } catch {
    return null;
  }
}

// One argument value against its property schema: type (string or array-of-types form), enum
// membership, and string `pattern` - the constraints a tool definition actually uses to pin down
// formats ("digits only", one-of). Not a full JSON Schema validator on purpose: nested
// object/array internals aren't walked, matching the "judged not parsed" posture everywhere else
// definitions are handled - these three checks are what catches "the model formed the value in
// the wrong format", which is the failure mode tool-definition rewrites exist to fix.
function checkValueAgainstProperty(key: string, value: unknown, property: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const jsType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const allowedTypes = typeof property.type === "string" ? [property.type] : Array.isArray(property.type) ? property.type : null;
  if (allowedTypes) {
    const matches = allowedTypes.some(t => {
      if (t === "integer") return typeof value === "number" && Number.isInteger(value);
      if (t === "number") return typeof value === "number";
      if (t === "object") return jsType === "object";
      return t === jsType;
    });
    if (!matches) {
      problems.push(`argument "${key}" should be ${allowedTypes.join(" or ")} (got ${jsType})`);
      return problems; // enum/pattern checks against a wrong-typed value would just double-report
    }
  }
  if (Array.isArray(property.enum) && property.enum.length > 0 && !property.enum.some(e => e === value)) {
    problems.push(`argument "${key}" must be one of ${JSON.stringify(property.enum)} (got ${JSON.stringify(value)})`);
  }
  if (typeof property.pattern === "string" && typeof value === "string") {
    // Same hazard as a monitor pattern's regex, and same fix: `pattern` arrives inside an
    // operator-supplied tool definition, so a nested quantifier in it would pin this thread while
    // validating arguments. RE2 keeps that linear. CodeQL does not flag this one because the
    // definition reaches here through the database, which breaks its dataflow - the exposure is
    // the same either way. JSON Schema `pattern` is an unanchored, case-sensitive search, which is
    // what compileUserRegex + find() already do.
    const compiled = compileUserRegex(property.pattern, { caseSensitive: true });
    if (compiled.ok && !compiled.regex.test(value)) {
      problems.push(`argument "${key}" should match pattern ${property.pattern} (got ${JSON.stringify(value)})`);
    }
    // An invalid or RE2-unsupported regex in the definition is the definition's bug, not the
    // model's - skip the check rather than failing the argument.
  }
  return problems;
}

export function checkArgs(definition: ParsedToolDefinition, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const required = Array.isArray(definition.parameters.required) ? (definition.parameters.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in args)) problems.push(`missing required argument "${key}"`);
  }
  const properties =
    definition.parameters.properties && typeof definition.parameters.properties === "object"
      ? (definition.parameters.properties as Record<string, unknown>)
      : null;
  if (properties) {
    for (const [key, value] of Object.entries(args)) {
      const property = properties[key];
      if (!property || typeof property !== "object") {
        problems.push(`unexpected argument "${key}"`);
        continue;
      }
      problems.push(...checkValueAgainstProperty(key, value, property as Record<string, unknown>));
    }
  }
  return problems;
}

export type ToolValidationCaseResult = {
  query: string;
  baseline: { calledTool: boolean; argProblems: string[]; output: string | null; error: string | null };
  candidate: { calledTool: boolean; argProblems: string[]; output: string | null; error: string | null };
};

export type ToolValidationResult = {
  model: string;
  caseCount: number;
  baselineProficiency: number | null;
  candidateProficiency: number | null;
  verdict: ValidationVerdict;
  summary: string;
  cases: ToolValidationCaseResult[];
};

// Tool calls are simulated, never executed (there's no endpoint to call and no side effect a
// validation run should have) - what a tool DEFINITION controls is whether the model picks the
// tool and forms valid arguments, and that's exactly what gets measured. Same honest posture as
// Playground's schema-only tools note.
async function runToolCaseVariant(
  db: Db,
  definition: ParsedToolDefinition,
  model: string,
  query: string
): Promise<ToolValidationCaseResult["baseline"]> {
  const tools: ToolDefinition[] = [
    { name: definition.name, description: definition.description, parameters: definition.parameters },
  ];
  try {
    const completion = await callModelWithTools(
      model,
      { system: "You are a helpful assistant. Use the available tool when it is relevant to the request.", messages: [{ role: "user", content: query }] },
      tools,
      async () => ({ simulated: true, status: "ok" })
    );
    const calls = completion.toolCalls.filter(c => c.name === definition.name);
    const argProblems = calls.flatMap(c => checkArgs(definition, c.arguments));
    return { calledTool: calls.length > 0, argProblems, output: completion.text || null, error: null };
  } catch (err) {
    return { calledTool: false, argProblems: [], output: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// 1 = called the tool with clean arguments, 0.5 = called it but with schema problems, 0 = never
// called it (or errored). Averaged over cases into the "proficiency" the verdict compares.
function proficiencyScore(outcome: ToolValidationCaseResult["baseline"]): number {
  if (!outcome.calledTool) return 0;
  return outcome.argProblems.length === 0 ? 1 : 0.5;
}

export async function validateToolSchemaProposal(
  db: Db,
  toolSchemaId: string,
  input: { candidateDefinition: string; datasetId?: string; model?: string; maxCases?: number }
): Promise<ToolValidationResult | { error: string }> {
  const schema = await getToolSchemaRow(db, toolSchemaId);
  if (!schema) return { error: "Tool schema not found" };
  const currentVersion = await getToolSchemaVersionRow(db, toolSchemaId, schema.currentVersion);
  if (!currentVersion) return { error: "Tool schema has no published version to compare against" };

  const baselineDef = parseToolDefinition(currentVersion.definition);
  const candidateDef = parseToolDefinition(input.candidateDefinition);
  if (!baselineDef) return { error: "The current definition is not JSON - can't validate automatically" };
  if (!candidateDef) return { error: "The proposed definition is not JSON - can't validate automatically" };

  // Queries: the chosen dataset's cases, or (default) the real production inputs from this
  // tool's own failure evidence - the exact requests the current definition mishandled.
  let queries: string[] = [];
  if (input.datasetId) {
    const config = await resolveRunConfig(db, input.datasetId, input.datasetId);
    queries = toCaseTurns(config.questions as unknown[]).map(c => c.turns[0]!.query);
  } else {
    const evidence = await getToolFailureExamples(db, toolSchemaId);
    queries = (evidence?.examples ?? []).map(e => e.input).filter(q => q.trim().length > 0);
  }
  queries = [...new Set(queries)].slice(0, input.maxCases ?? DEFAULT_MAX_CASES);
  if (queries.length === 0) {
    return { error: "No cases to validate against - pick a dataset, or wait for production evidence to accumulate" };
  }

  const model = input.model || DEFAULT_VALIDATION_MODEL;
  const cases = await mapWithConcurrency(queries, CASE_CONCURRENCY, async query => {
    const baseline = await runToolCaseVariant(db, baselineDef, model, query);
    const candidate = await runToolCaseVariant(db, candidateDef, model, query);
    return { query, baseline, candidate } satisfies ToolValidationCaseResult;
  });

  const usable = cases.filter(c => !c.baseline.error && !c.candidate.error);
  if (usable.length === 0) {
    return { model, caseCount: cases.length, baselineProficiency: null, candidateProficiency: null, verdict: "insufficient", summary: "Every case errored - check the model key.", cases };
  }
  const baselineProficiency = round1((usable.reduce((a, c) => a + proficiencyScore(c.baseline), 0) / usable.length) * 10) / 10;
  const candidateProficiency = round1((usable.reduce((a, c) => a + proficiencyScore(c.candidate), 0) / usable.length) * 10) / 10;
  const delta = round1((candidateProficiency - baselineProficiency) * 100) / 100;
  const verdict: ValidationVerdict = delta > 0.05 ? "improved" : delta < -0.05 ? "regressed" : "tie";
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const summary = `Candidate: clean tool use on ${pct(candidateProficiency)} of ${usable.length} cases vs ${pct(baselineProficiency)} baseline.`;
  return { model, caseCount: cases.length, baselineProficiency, candidateProficiency, verdict, summary, cases };
}
