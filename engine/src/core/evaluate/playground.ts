import type { Db } from "../../storage/db.js";
import { callModelWithTools, scoreAgainstCriteria, DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_PROMPT, type ToolCallTrace } from "./judge.js";
import { getPortabilityModel, estimateCostUSD } from "./models.js";
import { runCodeScorer, type CodeScorerConfig, type CodeScorerResult } from "./codeScorer.js";

// A tool the model can call during a Playground run — self-host calls the real endpoint you run
// (your actual local/hosted tool or RAG service), the same "call out, don't reimplement" shape
// core/monitor/conditions.ts's callExternalValidator already established for user-owned logic.
// Request POSTed to `endpointUrl`: { tool: name, arguments }. Expected response: { result: <any> }.
export type PlaygroundTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  endpointUrl: string;
};

// Same "one extraction helper, called at the route" convention as datasets.ts's
// extractCodeScorers/extractSimilarityConfig — validated/normalized here rather than trusted
// as-is, since `endpointUrl` is later fetched.
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
    .filter(t => t.name.length > 0 && t.endpointUrl.length > 0);
  return tools.length > 0 ? tools : undefined;
}

const TOOL_CALL_TIMEOUT_MS = 8000;

async function callPlaygroundTool(tools: PlaygroundTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`No endpoint configured for tool "${name}"`);
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
// return the result, no persistence — same "compute and return" posture as
// core/evaluate/portability.ts's runModelPortabilityCheck. The frontend fans out one call per grid
// cell to this same function/route rather than this file doing its own batch orchestration, so a
// slow model doesn't block the rest of the grid from populating.
export type PlaygroundMessage = { role: "system" | "user" | "assistant"; content: string };

export type PlaygroundRunInput = {
  model: string;
  // The fixed prefix (typically one system message, optionally few-shot user/assistant pairs) —
  // `query` below is always appended as the final user turn, never part of this list, so callers
  // never need a template-variable substitution convention.
  messages: PlaygroundMessage[];
  query: string;
  expected?: string;
  judgeGuideline?: string;
  // Which Evaluator config's criteria/judge model/judge prompt to score with — the caller resolves
  // this (its own selected Evaluator config, or the dataset's own criteria as a fallback) and
  // sends the resolved values directly; this file has no dataset/Evaluator lookup of its own.
  // judgePrompt/judgeModel are optional per-run overrides — omitted falls back to this engine's
  // usual defaults (DEFAULT_JUDGE_PROMPT/DEFAULT_JUDGE_MODEL), same as everywhere else that scores.
  judgeCriteria?: {
    acceptanceCriteria?: string;
    rejectionCriteria?: string;
    evaluationCriteria?: string;
    judgePrompt?: string;
    judgeModel?: string;
  };
  // The selected dataset's own code scorers, if any — run alongside judge scoring, not gated on
  // `expected` being present (a scorer like "output is non-empty" doesn't need a ground truth).
  codeScorers?: CodeScorerConfig[];
  tools?: PlaygroundTool[];
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
  error: string | null;
};

export async function runPlayground(db: Db, input: PlaygroundRunInput): Promise<PlaygroundRunResult> {
  const model = await getPortabilityModel(db, input.model);

  // Split the fixed-prefix messages into callModelCompletion's separate `system` field vs. its
  // `messages` array (which only ever holds user/assistant turns) — only the first message is
  // treated as system, matching the message editor's own "system message goes first" convention.
  const [first, ...rest] = input.messages;
  const system = first?.role === "system" ? first.content : undefined;
  const priorTurns = (first?.role === "system" ? rest : input.messages).filter(
    (m): m is PlaygroundMessage & { role: "user" | "assistant" } => m.role !== "system"
  );

  try {
    const start = Date.now();
    // Always routes through callModelWithTools, even with input.tools empty/absent — that
    // degenerates to exactly one round with no tool_calls, the same behavior callModelCompletion
    // already gave a tool-less run, so there's one code path here rather than two.
    const tools = input.tools ?? [];
    const completion = await callModelWithTools(
      input.model,
      { system, messages: [...priorTurns, { role: "user", content: input.query }] },
      tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
      (name, args) => callPlaygroundTool(tools, name, args)
    );
    const latencyMs = Date.now() - start;
    const estimatedCostUSD = estimateCostUSD(model, completion.usage?.inputTokens ?? null, completion.usage?.outputTokens ?? null);

    // Runs independent of judge scoring below (not gated on `expected`) — each scorer isolates
    // its own failure into { score: null, error } (see codeScorer.ts's runCodeScorer), so a
    // broken/timed-out scorer never blanks the real model output that already succeeded.
    const enabledCodeScorers = (input.codeScorers ?? []).filter(s => s.enabled);
    const codeScorerResults =
      enabledCodeScorers.length > 0
        ? await Promise.all(
            enabledCodeScorers.map(scorer =>
              runCodeScorer(scorer, { input: input.query, output: completion.text, expected: input.expected })
            )
          )
        : undefined;

    let rating: number | null = null;
    let justification: string | null = null;
    // Only score when there's a ground truth to compare against — a question with no
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
        // that already succeeded — same isolation posture as runs.ts's scoreOneResult.
        justification = `Scoring failed: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }

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
