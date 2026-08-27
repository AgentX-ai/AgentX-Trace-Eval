import { resolveSpanKind } from "../trace/spanKind.js";
import vm from "node:vm";
import { spawn } from "node:child_process";
import type { Db } from "../../storage/db.js";
import { getTraceRow, listSessionSpans, type TraceRow } from "../trace/ingest.js";

// The Code scorer runtime: user-authored JavaScript or Python run against each sampled trace,
// the in-engine sibling of the External scorer's HTTP endpoint. The handler contract mirrors
// Braintrust-style code scorers:
//
//   async handler(input, output, expected, metadata, trace) ->
//     number (0..1) | { score, name?, metadata? } | null/None (skip scoring)
//
// `trace` exposes `get_spans(span_type=None)` (Python) / `getSpans({ spanType })` (JS) over the
// trace's own span subtree, preloaded before execution - the accessor is async for contract
// symmetry, but never does IO of its own.
//
// Execution posture matches core/evaluate/codeScorer.ts exactly: this is NOT a security
// boundary. A scorer is code the operator chose to run on their own engine - node:vm has no
// require/fetch binding but is escapable by construction, and the Python path is a plain
// subprocess. Do not expose scorer creation to anyone who shouldn't run code on this machine.

export type ScriptScorerConfig = { name: string; language: string; script: string };

export type ScriptScorerArgs = {
  input: unknown;
  output: unknown;
  // Online scoring has no reference answer - always null today, kept in the contract so the
  // same handler body can be reused where a reference exists (offline code scorers).
  expected: unknown;
  metadata: unknown;
  spans: ScorerSpan[];
};

export type ScriptScorerResult = {
  // null = the handler skipped scoring (returned null/None) or failed; `error` distinguishes.
  score: number | null;
  name?: string;
  metadata?: unknown;
  error?: string;
};

// What a scorer sees per span: the trace-detail wire fields plus a derived `type`, classified
// from what the span actually recorded (heuristic, documented in the dialog placeholder):
//   "llm" - a model is recorded on the span
//   "tool" - tool calls are recorded (and no model)
//   "retrieval" - metadata.kind === "retrieval" (the SDK's retrieval-span marker)
//   "span" - anything else
export type ScorerSpan = {
  span_id: string | null;
  parent_span_id: string | null;
  name: string;
  type: string;
  input: unknown;
  output: unknown;
  error: string | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: unknown;
  metadata: unknown;
  started_at: string | null;
};

// One classifier for the whole engine (core/trace/spanKind.ts). This used to be its own rule and
// disagreed with the timeline's: a plain child span arrived here as "span" while the UI drew it
// as a tool. Note the vocabulary shift that came with unifying - an unclassifiable child span is
// now "chain" rather than "span", and a root span is "agent" rather than falling through.
function classifySpan(row: TraceRow): string {
  return resolveSpanKind({
    spanKind: (row as { spanKind?: unknown }).spanKind,
    metadata: row.metadata,
    name: row.name,
    model: row.model,
    toolCalls: (row as { toolCalls?: unknown }).toolCalls,
    parentSpanId: (row as { parentSpanId?: string | null }).parentSpanId ?? null,
  });
}

function toScorerSpan(row: TraceRow): ScorerSpan {
  return {
    span_id: row.spanId,
    parent_span_id: row.parentSpanId,
    name: row.name,
    type: classifySpan(row),
    input: row.input,
    output: row.output,
    error: row.error,
    model: row.model,
    latency_ms: row.latencyMs,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    tool_calls: row.toolCalls,
    metadata: row.metadata,
    started_at: row.startedAt ? row.startedAt.toISOString() : null,
  };
}

// The trace's own span subtree, root included, ordered by start time: the root row plus every
// session span reachable from it through parent_span_id links. A single-span trace (no session)
// is just itself.
export async function loadScorerSpans(db: Db, traceId: string | null): Promise<ScorerSpan[]> {
  if (!traceId) return [];
  const root = await getTraceRow(db, traceId);
  if (!root) return [];
  if (!root.sessionId || !root.spanId) return [toScorerSpan(root)];
  const sessionSpans = (await listSessionSpans(db, root.sessionId)) as unknown as Array<{ spanId?: string | null }>;
  // listSessionSpans returns wire rows; refetch raw rows would double work - instead classify
  // membership by parent links over the wire rows, which carry the same span linkage fields.
  const byParent = new Map<string, unknown[]>();
  for (const span of sessionSpans as Array<Record<string, unknown>>) {
    const parent = (span.parentSpanId ?? span.parent_span_id) as string | null;
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push(span);
    byParent.set(parent, list);
  }
  const subtree: Array<Record<string, unknown>> = [];
  const queue: string[] = [root.spanId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const spanId = queue.shift()!;
    if (seen.has(spanId)) continue;
    seen.add(spanId);
    for (const child of (byParent.get(spanId) ?? []) as Array<Record<string, unknown>>) {
      subtree.push(child);
      const childId = (child.spanId ?? child.span_id) as string | null;
      if (childId) queue.push(childId);
    }
  }
  const wireToScorer = (span: Record<string, unknown>): ScorerSpan => ({
    span_id: (span.spanId ?? span.span_id ?? null) as string | null,
    parent_span_id: (span.parentSpanId ?? span.parent_span_id ?? null) as string | null,
    name: String(span.name ?? ""),
    type: ((): string => {
      const metadata = span.metadata as { kind?: unknown } | null | undefined;
      if (metadata && metadata.kind === "retrieval") return "retrieval";
      if (span.model) return "llm";
      const calls = span.toolCalls ?? span.tool_calls;
      if (Array.isArray(calls) && calls.length > 0) return "tool";
      return "span";
    })(),
    input: span.input ?? null,
    output: span.output ?? null,
    error: (span.error ?? null) as string | null,
    model: (span.model ?? null) as string | null,
    latency_ms: (span.latencyMs ?? span.latency_ms ?? null) as number | null,
    input_tokens: (span.inputTokens ?? span.input_tokens ?? null) as number | null,
    output_tokens: (span.outputTokens ?? span.output_tokens ?? null) as number | null,
    tool_calls: span.toolCalls ?? span.tool_calls ?? null,
    metadata: span.metadata ?? null,
    started_at: (span.startedAt ?? span.started_at ?? null) as string | null,
  });
  return [toScorerSpan(root), ...subtree.map(wireToScorer)];
}

const SCRIPT_TIMEOUT_MS = 8000;

function normalizeResult(raw: unknown): ScriptScorerResult {
  if (raw === null || raw === undefined) {
    return { score: null };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { score: Math.max(0, Math.min(1, raw)) };
  }
  if (typeof raw === "object") {
    const obj = raw as { score?: unknown; name?: unknown; metadata?: unknown };
    if (obj.score === null || obj.score === undefined) {
      return { score: null };
    }
    if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
      return {
        score: Math.max(0, Math.min(1, obj.score)),
        name: typeof obj.name === "string" ? obj.name : undefined,
        metadata: obj.metadata,
      };
    }
  }
  return { score: null, error: "Scorer returned an unsupported shape - expected a number, { score, ... }, or null" };
}

function spanFilter(spans: ScorerSpan[], spanType: unknown): ScorerSpan[] {
  if (spanType === null || spanType === undefined) return spans;
  const wanted = new Set((Array.isArray(spanType) ? spanType : [spanType]).map(String));
  return spans.filter(span => wanted.has(span.type));
}

async function runJavaScript(config: ScriptScorerConfig, args: ScriptScorerArgs): Promise<ScriptScorerResult> {
  const trace = {
    getSpans: (opts?: { spanType?: unknown } | unknown) =>
      Promise.resolve(
        spanFilter(args.spans, opts && typeof opts === "object" ? (opts as { spanType?: unknown }).spanType : opts)
      ),
    // snake_case alias so a handler ported from the Python contract runs unchanged.
    get_spans: (spanType?: unknown) => Promise.resolve(spanFilter(args.spans, spanType)),
  };
  const context = vm.createContext({});
  const script = new vm.Script(`${config.script}\n;typeof handler === "function" ? handler : null`);
  const handler = script.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS }) as unknown;
  if (typeof handler !== "function") {
    return { score: null, error: 'The script must define a function named "handler"' };
  }
  // vm's timeout only bounds the synchronous part; the race bounds a handler that awaits forever.
  const raw = await Promise.race([
    Promise.resolve((handler as (...fnArgs: unknown[]) => unknown)(args.input, args.output, args.expected, args.metadata ?? {}, trace)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Scorer timed out after ${SCRIPT_TIMEOUT_MS}ms`)), SCRIPT_TIMEOUT_MS)),
  ]);
  return normalizeResult(raw);
}

// Runs the user's Python in a python3 subprocess: harness on argv, everything else as JSON on
// stdin, one JSON line back on stdout. No third-party imports required by the harness itself.
const PYTHON_HARNESS = `
import sys, json, asyncio, inspect

def _main():
    payload = json.load(sys.stdin)
    ns = {}
    exec(payload["script"], ns)
    handler = ns.get("handler")
    if not callable(handler):
        return {"ok": False, "error": 'The script must define a function named "handler"'}

    class Trace:
        def __init__(self, spans):
            self._spans = spans
        async def get_spans(self, span_type=None):
            if span_type is None:
                return self._spans
            wanted = set(span_type if isinstance(span_type, (list, tuple, set)) else [span_type])
            return [s for s in self._spans if s.get("type") in wanted]

    async def run():
        result = handler(payload["input"], payload["output"], payload["expected"], payload["metadata"] or {}, Trace(payload["spans"]))
        if inspect.isawaitable(result):
            result = await result
        return result

    try:
        return {"ok": True, "result": asyncio.run(run())}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

print(json.dumps(_main()))
`;

async function runPython(config: ScriptScorerConfig, args: ScriptScorerArgs): Promise<ScriptScorerResult> {
  return new Promise(resolve => {
    const child = spawn("python3", ["-c", PYTHON_HARNESS], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: SCRIPT_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", err => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        score: null,
        error: missing
          ? "python3 was not found on the engine host - install it, or use a JavaScript scorer"
          : `Failed to start python3: ${err.message}`,
      });
    });
    child.on("close", code => {
      if (code !== 0 && !stdout.trim()) {
        resolve({ score: null, error: `python3 exited with code ${code}: ${stderr.trim().slice(0, 400)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { ok: boolean; result?: unknown; error?: string };
        if (!parsed.ok) {
          resolve({ score: null, error: parsed.error ?? "Scorer failed" });
          return;
        }
        resolve(normalizeResult(parsed.result));
      } catch {
        resolve({ score: null, error: `Unparseable scorer output: ${stdout.trim().slice(0, 200)}` });
      }
    });
    child.stdin.write(
      JSON.stringify({
        script: config.script,
        input: args.input,
        output: args.output,
        expected: args.expected,
        metadata: args.metadata,
        spans: args.spans,
      })
    );
    child.stdin.end();
  });
}

// Every failure is folded into { score: null, error } - one broken scorer must never break
// ingest or its sibling scorers, same posture as runCodeScorer/runCustomEvaluators.
export async function runScriptScorer(config: ScriptScorerConfig, args: ScriptScorerArgs): Promise<ScriptScorerResult> {
  try {
    if (config.language === "python") {
      return await runPython(config, args);
    }
    return await runJavaScript(config, args);
  } catch (err) {
    return { score: null, error: err instanceof Error ? err.message : String(err) };
  }
}
