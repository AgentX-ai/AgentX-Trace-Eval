import vm from "node:vm";

// A 5th, open-ended scorer kind alongside judge.ts's LLM-as-judge and the 4 fixed similarity
// metrics: one or more user-defined JS/TS functions per dataset, closing the "code-based scorers"
// gap against Braintrust. Self-host only - see datasets.ts's SimilarityConfig for the analogous
// fixed-metric config this sits next to.
export type CodeScorerConfig = {
  id: string;
  name: string;
  // The body of a function invoked as score({ input, output, expected }) - see runCodeScorer.
  code: string;
  enabled: boolean;
};

export type CodeScorerResult = {
  name: string;
  score: number | null;
  reasoning?: string;
  error?: string;
};

// In-process CPU-bound work should be fast; mirrors customEvaluators.ts's
// CUSTOM_EVALUATOR_TIMEOUT_MS naming/shape for the codebase's other "run untrusted user logic"
// boundary.
const CODE_SCORER_TIMEOUT_MS = 3000;

// toolCalls: the trace's recorded tool-call array when the caller has one (connector-driven runs,
// playground runs with tools, and anywhere a real trace backs the result) - lets a scorer assert
// on tool behavior ("required tool was called", "arguments parse against my schema"), the same
// structured tool_calls access Langfuse exposes to its code evaluators. Undefined when the result
// simply has no tool data; a scorer reading it should null-check, same as `expected`.
type ScorerArgs = { input: string; output: string; expected?: string; toolCalls?: unknown };

// Executes one dataset-defined scorer function against one result. JS/TS only, run in-process via
// node:vm rather than shelling out to python3/node on PATH - the engine ships as a single
// Bun-compiled native executable specifically so end users never need a runtime installed, and
// vm is already embedded in that binary. Synchronous only: vm.Script's timeout option only
// interrupts synchronous execution, so an async scorer awaiting a hung fetch() sails straight
// past it and the timeout below bounds nothing.
//
// node:vm is NOT a security boundary, and this code must not be read as one. The context handed
// to the script has no require/fetch/process binding of its own, but that only stops the obvious
// spelling: any object reaching the script carries a prototype chain back out to this realm, so
// `this.constructor.constructor("return process")()` hands a scorer the real `process` - and with
// it the filesystem, the network and this engine's environment (checked, not assumed: it returns
// a live process object on the Node version this ships against). Treat scorer code as code an
// operator is choosing to run on their own machine, exactly like core/monitor/customEvaluators.ts's
// callCustomEvaluator(), and do not expose dataset creation to anyone who should not have that.
// Actually sandboxing this needs an isolate (isolated-vm) or a subprocess with OS-level limits,
// neither of which survives `bun build --compile` into the single-binary distribution today.
//
// Every failure (syntax error, thrown error, timeout, bad return shape) is caught here and folded
// into { score: null, error } rather than propagated - one broken/timed-out scorer must not take
// down that item's judge rating, similarity scores, or the rest of the batch (see runs.ts's
// scoreOneResult, which runs all enabled scorers via Promise.all and expects every one of them to
// resolve, never reject).
export async function runCodeScorer(scorer: CodeScorerConfig, args: ScorerArgs): Promise<CodeScorerResult> {
  try {
    const raw = executeInSandbox(scorer.code, args);
    return normalizeResult(scorer.name, raw);
  } catch (err) {
    return { name: scorer.name, score: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function executeInSandbox(code: string, args: ScorerArgs): unknown {
  // The function call happens inside the same runInContext call as the compile, not as a
  // separately-invoked reference afterward - the latter would run outside the timeout window
  // entirely, since vm only bounds synchronous execution during the call it wraps.
  const context = vm.createContext({
    __args: { input: args.input, output: args.output, expected: args.expected, toolCalls: args.toolCalls },
  });
  const wrapped = `(function({ input, output, expected, toolCalls }) {\n${code}\n})(__args);`;
  const script = new vm.Script(wrapped, { filename: "code-scorer.js" });
  return script.runInContext(context, { timeout: CODE_SCORER_TIMEOUT_MS });
}

function normalizeResult(name: string, raw: unknown): CodeScorerResult {
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { name, score: raw }
      : { name, score: null, error: "Scorer returned a non-finite number" };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { score?: unknown; reasoning?: unknown };
    if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
      return { name, score: obj.score, reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined };
    }
  }
  return { name, score: null, error: "Scorer must return a number or { score, reasoning }" };
}
