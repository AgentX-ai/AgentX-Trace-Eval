import type { Db } from "../../storage/db.js";
import { callModelWithTools, scoreAgainstCriteria, DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_PROMPT, type ToolCallTrace } from "./judge.js";
import { getPortabilityModel, estimateCostUSD } from "./models.js";
import { runCodeScorer, type CodeScorerConfig, type CodeScorerResult } from "./codeScorer.js";
import { evaluatePatternConditions, type PatternCondition, type TraceLike } from "../monitor/conditions.js";
import { getPatternRow } from "../monitor/patterns.js";
import { llmSemanticJudge } from "../monitor/detect.js";
import { getOnlineEvaluatorRow } from "../monitor/onlineEvaluators.js";
import { getEvaluationSettingsRow } from "./evaluationSettings.js";

// A tool the model can call during a Playground run - self-host calls the real endpoint you run
// (your actual local/hosted tool or RAG service), the same "call out, don't reimplement" shape
// core/monitor/customEvaluators.ts's callCustomEvaluator already established for user-owned logic.
// Request POSTed to `endpointUrl`: { tool: name, arguments }. Expected response: { result: <any> }.
export type PlaygroundTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  endpointUrl: string;
};

// Same "one extraction helper, called at the route" convention as datasets.ts's
// extractCodeScorers/extractSimilarityConfig - validated/normalized here rather than trusted
// as-is, since `endpointUrl` is later fetched. endpointUrl is OPTIONAL: a schema-only tool (the
// "From Tool Schemas" picker adds these) is still sent to the model, and its calls get a
// simulated result (see callPlaygroundTool) - requiring an endpoint here used to silently drop
// registry tools before the model ever saw them, which read as "the tool isn't in the context".
export function extractPlaygroundTools(body: Record<string, unknown>): PlaygroundTool[] | undefined {
  if (!Array.isArray(body.tools)) {
    return undefined;
  }
  const tools = body.tools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map(t => ({
      name: typeof t.name === "string" ? t.name.trim() : "",
      description: typeof t.description === "string" ? t.description : undefined,
      parameters: t.parameters && typeof t.parameters === "object" ? (t.parameters as Record<string, unknown>) : {},
      endpointUrl: typeof t.endpointUrl === "string" ? t.endpointUrl.trim() : "",
    }))
    .filter(t => t.name.length > 0);
  return tools.length > 0 ? tools : undefined;
}

const TOOL_CALL_TIMEOUT_MS = 8000;

// Exported for the conversation simulator (simulation.ts), which runs the agent side of each
// turn exactly like a Playground run - same schema-only simulation, same endpoint contract.
export async function callPlaygroundTool(tools: PlaygroundTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`No endpoint configured for tool "${name}"`);
  }
  // Schema-only tool: simulate instead of executing, same honest posture as proposal
  // validation's runToolCaseVariant - what a Playground run of a schema-only tool tests is
  // whether the prompt/model CHOOSE the tool and form valid arguments, and the simulated result
  // is visible in the cell's tool-call trace so nobody mistakes it for a real lookup.
  if (!tool.endpointUrl) {
    // Deliberately terse: this object is fed back to the MODEL as the tool result, and a verbose
    // explanation leaks into the final answer ("due to a simulated environment..."). The cell's
    // tool-call trace still shows `simulated: true` so the human knows nothing real ran.
    return { simulated: true, status: "ok", arguments: args };
  }
  const res = await fetch(tool.endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: name, arguments: args }),
    signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Tool "${name}" endpoint ${tool.endpointUrl} responded ${res.status}`);
  }
  const body = (await res.json()) as { result?: unknown };
  if (!("result" in body)) {
    throw new Error(`Tool "${name}" endpoint ${tool.endpointUrl} response missing a "result" field`);
  }
  return body.result;
}

// Interactive Playground: run one (prompt, model, dataset question) combination for real and
// return the result, no persistence - same "compute and return" posture as
// core/evaluate/portability.ts's runModelPortabilityCheck. The frontend fans out one call per grid
// cell to this same function/route rather than this file doing its own batch orchestration, so a
// slow model doesn't block the rest of the grid from populating.
export type PlaygroundMessage = { role: "system" | "user" | "assistant"; content: string };

export type PlaygroundRunInput = {
  model: string;
  // The fixed prefix (typically one system message, optionally few-shot user/assistant pairs) -
  // `query` below is always appended as the final user turn, never part of this list, so callers
  // never need a template-variable substitution convention.
  messages: PlaygroundMessage[];
  query: string;
  expected?: string;
  judgeGuideline?: string;
  // Which Evaluator config's criteria/judge model/judge prompt to score with - the caller resolves
  // this (its own selected Evaluator config, or the dataset's own criteria as a fallback) and
  // sends the resolved values directly; this file has no dataset/Evaluator lookup of its own.
  // judgePrompt/judgeModel are optional per-run overrides - omitted falls back to this engine's
  // usual defaults (DEFAULT_JUDGE_PROMPT/DEFAULT_JUDGE_MODEL), same as everywhere else that scores.
  judgeCriteria?: {
    acceptanceCriteria?: string;
    rejectionCriteria?: string;
    evaluationCriteria?: string;
    judgePrompt?: string;
    judgeModel?: string;
  };
  // The selected dataset's own code scorers, if any - run alongside judge scoring, not gated on
  // `expected` being present (a scorer like "output is non-empty" doesn't need a ground truth).
  codeScorers?: CodeScorerConfig[];
  tools?: PlaygroundTool[];
  // Monitor's Pattern/Online Evaluator checks, dry-run against this one response - never gated on
  // `expected` either (they check the response itself, not against a ground truth), and never
  // write a Signal/Event row the way a real ingested trace would (see runPlaygroundPatternChecks/
  // runPlaygroundOnlineEvaluatorChecks below) - Playground stays "compute and return" throughout.
  patternIds?: string[];
  onlineEvaluatorIds?: string[];
  // Per-model overrides from Playground's "Model settings" - see callModelWithTools's `options`
  // param. Both omitted preserves today's exact defaults.
  maxTokens?: number;
  temperature?: number;
};

export type PlaygroundPatternCheckResult = {
  patternId: string;
  name: string;
  severity: string;
  polarity: "failure" | "proper";
  matched: boolean;
  reasons: string[];
  error?: string;
};

export type PlaygroundOnlineEvaluatorCheckResult = {
  evaluatorId: string;
  name: string;
  rating: number | null;
  justification: string | null;
  alertThreshold: number | null;
  wouldAlert: boolean;
  error?: string;
};

export type PlaygroundRunResult = {
  output: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUSD: number | null;
  rating: number | null;
  justification: string | null;
  codeScorerResults?: CodeScorerResult[];
  toolCalls?: ToolCallTrace[];
  patternChecks?: PlaygroundPatternCheckResult[];
  onlineEvaluatorChecks?: PlaygroundOnlineEvaluatorCheckResult[];
  error: string | null;
};

// Dry-run version of detect.ts's detectCustomPatterns - evaluates every requested pattern
// independently (not first-match-wins, since Playground wants to show every selected pattern's
// own result) and never calls upsertSignal/recordEvent. Each pattern's failure (bad judge key,
// provider outage) is isolated to its own result rather than aborting the sweep, same reasoning
// detectCustomPatterns already uses.
async function runPlaygroundPatternChecks(db: Db, patternIds: string[], trace: TraceLike): Promise<PlaygroundPatternCheckResult[]> {
  const results: PlaygroundPatternCheckResult[] = [];
  for (const patternId of patternIds) {
    const pattern = await getPatternRow(db, patternId);
    if (!pattern) continue; // deleted since the run started
    const polarity = pattern.polarity === "proper" ? "proper" : "failure";
    try {
      // responseText, not just `trace` - buildSourceTexts (conditions.ts) only ever reads the
      // "response" source from this, never from trace.output directly (same as detectCustomPatterns).
      const responseText = typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? "");
      const outcome = await evaluatePatternConditions({
        conditions: pattern.conditions as PatternCondition[],
        responseText,
        trace,
        semanticJudge: llmSemanticJudge,
      });
      results.push({
        patternId: pattern.id,
        name: pattern.name,
        severity: pattern.severity,
        polarity,
        matched: outcome.overall,
        reasons: outcome.reasons,
      });
    } catch (err) {
      results.push({
        patternId: pattern.id,
        name: pattern.name,
        severity: pattern.severity,
        polarity,
        matched: false,
        reasons: [],
        error: err instanceof Error ? err.message : "Pattern check failed",
      });
    }
  }
  return results;
}

// Dry-run version of onlineEvaluators.ts's runOnlineEvaluators - scores against every requested
// evaluator's referenced Evaluator config the same way (scoreAgainstCriteria), computes the same
// wouldAlert comparison, but never calls upsertSignal/recordEvent.
async function runPlaygroundOnlineEvaluatorChecks(
  db: Db,
  evaluatorIds: string[],
  content: { input: string; output: string }
): Promise<PlaygroundOnlineEvaluatorCheckResult[]> {
  const results: PlaygroundOnlineEvaluatorCheckResult[] = [];
  for (const evaluatorId of evaluatorIds) {
    const evaluator = await getOnlineEvaluatorRow(db, evaluatorId);
    if (!evaluator) continue; // deleted since the run started
    const settings = evaluator.evaluationSettingsId ? await getEvaluationSettingsRow(db, evaluator.evaluationSettingsId) : null;
    if (!settings) {
      results.push({
        evaluatorId: evaluator.id,
        name: evaluator.name,
        rating: null,
        justification: null,
        alertThreshold: evaluator.alertThreshold,
        wouldAlert: false,
        error: "This evaluator has no valid evaluator config",
      });
      continue;
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
        content
      );
      results.push({
        evaluatorId: evaluator.id,
        name: evaluator.name,
        rating,
        justification,
        alertThreshold: evaluator.alertThreshold,
        wouldAlert: evaluator.alertThreshold !== null && rating < evaluator.alertThreshold,
      });
    } catch (err) {
      results.push({
        evaluatorId: evaluator.id,
        name: evaluator.name,
        rating: null,
        justification: null,
        alertThreshold: evaluator.alertThreshold,
        wouldAlert: false,
        error: err instanceof Error ? err.message : "Scoring failed",
      });
    }
  }
  return results;
}

export async function runPlayground(db: Db, input: PlaygroundRunInput): Promise<PlaygroundRunResult> {
  const model = await getPortabilityModel(db, input.model);

  // Split the fixed-prefix messages into callModelCompletion's separate `system` field vs. its
  // `messages` array (which only ever holds user/assistant turns) - only the first message is
  // treated as system, matching the message editor's own "system message goes first" convention.
  const [first, ...rest] = input.messages;
  const system = first?.role === "system" ? first.content : undefined;
  const priorTurns = (first?.role === "system" ? rest : input.messages).filter(
    (m): m is PlaygroundMessage & { role: "user" | "assistant" } => m.role !== "system"
  );

  try {
    const start = Date.now();
    // Always routes through callModelWithTools, even with input.tools empty/absent - that
    // degenerates to exactly one round with no tool_calls, the same behavior callModelCompletion
    // already gave a tool-less run, so there's one code path here rather than two.
    const tools = input.tools ?? [];
    const completion = await callModelWithTools(
      input.model,
      { system, messages: [...priorTurns, { role: "user", content: input.query }] },
      tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
      (name, args) => callPlaygroundTool(tools, name, args),
      { maxTokens: input.maxTokens, temperature: input.temperature }
    );
    const latencyMs = Date.now() - start;
    const estimatedCostUSD = estimateCostUSD(model, completion.usage?.inputTokens ?? null, completion.usage?.outputTokens ?? null);

    // Runs independent of judge scoring below (not gated on `expected`) - each scorer isolates
    // its own failure into { score: null, error } (see codeScorer.ts's runCodeScorer), so a
    // broken/timed-out scorer never blanks the real model output that already succeeded.
    const enabledCodeScorers = (input.codeScorers ?? []).filter(s => s.enabled);
    const codeScorerResults =
      enabledCodeScorers.length > 0
        ? await Promise.all(
            enabledCodeScorers.map(scorer =>
              runCodeScorer(scorer, {
                input: input.query,
                output: completion.text,
                expected: input.expected,
                // The round-trip's real recorded tool calls (callModelWithTools' trace) - lets a
                // scorer assert on tool behavior, see codeScorer.ts's ScorerArgs.
                toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
              })
            )
          )
        : undefined;

    let rating: number | null = null;
    let justification: string | null = null;
    // Only score when there's a ground truth to compare against - a question with no
    // expectedResults still runs and shows output, it just never blocks on a judge call.
    if (input.expected) {
      try {
        const scored = await scoreAgainstCriteria(
          {
            acceptanceCriteria: input.judgeCriteria?.acceptanceCriteria ?? "",
            rejectionCriteria: input.judgeCriteria?.rejectionCriteria ?? "",
            evaluationCriteria: input.judgeCriteria?.evaluationCriteria ?? "",
            judgePrompt: input.judgeCriteria?.judgePrompt?.trim() || DEFAULT_JUDGE_PROMPT,
            judgeModel: input.judgeCriteria?.judgeModel || DEFAULT_JUDGE_MODEL,
          },
          { input: input.query, output: completion.text, expected: input.expected, judgeGuideline: input.judgeGuideline }
        );
        rating = scored.rating;
        justification = scored.justification;
      } catch (err) {
        // A judge failure (bad key, provider outage) shouldn't blank out the real model output
        // that already succeeded - same isolation posture as runs.ts's scoreOneResult.
        justification = `Scoring failed: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }

    // Same isolation posture as code scorers/judge scoring above - run independent of `expected`,
    // never thrown out of the function on a single pattern/evaluator failure (each isolates its
    // own error internally already).
    const patternChecks =
      input.patternIds && input.patternIds.length > 0
        ? await runPlaygroundPatternChecks(db, input.patternIds, { input: input.query, output: completion.text, error: null })
        : undefined;
    const onlineEvaluatorChecks =
      input.onlineEvaluatorIds && input.onlineEvaluatorIds.length > 0
        ? await runPlaygroundOnlineEvaluatorChecks(db, input.onlineEvaluatorIds, { input: input.query, output: completion.text })
        : undefined;

    return {
      output: completion.text,
      latencyMs,
      inputTokens: completion.usage?.inputTokens ?? null,
      outputTokens: completion.usage?.outputTokens ?? null,
      estimatedCostUSD,
      rating,
      justification,
      codeScorerResults,
      toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
      patternChecks,
      onlineEvaluatorChecks,
      error: null,
    };
  } catch (err) {
    return {
      output: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUSD: null,
      rating: null,
      justification: null,
      error: err instanceof Error ? err.message : "Request failed",
    };
  }
}
