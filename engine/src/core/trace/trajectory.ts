import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listSessionSpans } from "./ingest.js";

// Render a trace's execution trajectory as judge-readable text - the span subtree (graph nodes,
// LLM calls, tool executions with args/results/errors, in start order and indentation showing
// nesting) when the trace has one, else its flat recorded tool_calls list. This is what makes an
// LLM judge trajectory-aware: without it every judge scores only the final input/output pair and
// is blind to which tools ran, in what order, and what failed along the way.

type SpanWire = {
  _id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  latencyMs?: number;
  error?: string;
  model?: string;
  toolCalls?: unknown;
  spanId?: string;
  parentSpanId?: string;
  startedAt?: string;
  createdAt: string;
};

const MAX_STEPS = 40;
const MAX_FIELD = 300;

function short(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}...` : text;
}

function describeToolCall(tc: Record<string, unknown>): string {
  const name = typeof tc.name === "string" ? tc.name : "tool";
  const ok = tc.success !== false;
  const input = short(tc.input);
  const output = short(tc.output);
  const parts = [`${name}(${input})`];
  if (output) parts.push(`-> ${output}`);
  return `${ok ? "" : "FAILED "}${parts.join(" ")}`;
}

// Flat tool_calls fallback for traces without a span tree - still a real (if coarser) trajectory.
function renderFlatToolCalls(toolCalls: unknown): string | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const lines = toolCalls
    .slice(0, MAX_STEPS)
    .map((tc, i) => `${i + 1}. ${describeToolCall(tc as Record<string, unknown>)}`);
  if (toolCalls.length > MAX_STEPS) lines.push(`... ${toolCalls.length - MAX_STEPS} more tool calls omitted`);
  return `Tool calls (in order):\n${lines.join("\n")}`;
}

export async function renderTraceTrajectory(db: Db, traceId: string): Promise<string | null> {
  const cond = and(eq(db.schema.traces.id, traceId), eq(db.schema.traces.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond);
  const root = rows[0] as
    | { spanId: string | null; sessionId: string | null; toolCalls: unknown }
    | undefined;
  if (!root) return null;

  if (!root.spanId || !root.sessionId) {
    return renderFlatToolCalls(root.toolCalls);
  }

  const spans = (await listSessionSpans(db, root.sessionId)) as SpanWire[];
  // Scope to THIS trace's subtree - a session groups sibling turns too, and a judge scoring one
  // interaction must not see the other turns' steps (mirrors the frontend's
  // filterToInteractionSpans).
  const included = new Set<string>([root.spanId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const span of spans) {
      if (span.spanId && span.parentSpanId && !included.has(span.spanId) && included.has(span.parentSpanId)) {
        included.add(span.spanId);
        changed = true;
      }
    }
  }
  const subtree = spans.filter(s => s.spanId && included.has(s.spanId));
  if (subtree.length <= 1) {
    return renderFlatToolCalls(root.toolCalls);
  }

  const depth = new Map<string, number>();
  const bySpanId = new Map(subtree.map(s => [s.spanId as string, s]));
  const depthOf = (span: SpanWire): number => {
    const id = span.spanId as string;
    if (depth.has(id)) return depth.get(id) as number;
    const parent = span.parentSpanId ? bySpanId.get(span.parentSpanId) : undefined;
    const d = parent ? depthOf(parent) + 1 : 0;
    depth.set(id, d);
    return d;
  };

  const ordered = [...subtree].sort(
    (a, b) => new Date(a.startedAt ?? a.createdAt).getTime() - new Date(b.startedAt ?? b.createdAt).getTime()
  );
  const lines: string[] = [];
  let step = 0;
  for (const span of ordered) {
    if (step >= MAX_STEPS) {
      lines.push(`... ${ordered.length - MAX_STEPS} more steps omitted`);
      break;
    }
    step += 1;
    const indent = "  ".repeat(depthOf(span));
    const latency = span.latencyMs != null ? ` (${span.latencyMs}ms)` : "";
    const model = span.model ? ` [${span.model}]` : "";
    let detail = "";
    if (span.parentSpanId) {
      const input = short(span.input);
      const output = short(span.output);
      if (input || output) detail = ` - ${input ? `input: ${input}` : ""}${input && output ? " " : ""}${output ? `-> ${output}` : ""}`;
    }
    const failed = span.error ? ` FAILED: ${short(span.error)}` : "";
    lines.push(`${step}. ${indent}${span.name}${model}${latency}${detail}${failed}`);
  }
  return `Execution steps (in order, indentation = nesting):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Trajectory matching (agentevals-style): compare the tool-call sequence a trace actually made
// against a dataset case's expected sequence. Uses the root trace's flat tool_calls list - the
// one every integration mirrors (see tracer._merge_child_run) - so semantics are stable across
// SDK decorators, LangChain/LangGraph, OTel, and playground runs.
// ---------------------------------------------------------------------------

export type TrajectoryMatchMode = "strict" | "unordered" | "subset" | "superset";

export async function extractTraceToolSequence(db: Db, traceId: string): Promise<string[] | null> {
  const cond = and(eq(db.schema.traces.id, traceId), eq(db.schema.traces.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond);
  const root = rows[0] as { toolCalls: unknown } | undefined;
  if (!root) return null;
  if (!Array.isArray(root.toolCalls)) return [];
  return (root.toolCalls as { name?: unknown }[]).map(tc => String(tc.name ?? "unknown"));
}

function multiset(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

// `expected` is the reference sequence; `actual` is what the trace did. Modes follow agentevals:
// strict = same calls in the same order; unordered = same calls, any order; superset = actual
// contains at least every expected call (extras allowed); subset = actual made no call outside
// the expected set (missing some is allowed).
export function matchTrajectory(
  expected: string[],
  actual: string[],
  mode: TrajectoryMatchMode
): { matched: boolean; reasoning: string } {
  const exp = expected.map(t => t.trim()).filter(Boolean);
  const summary = `expected [${exp.join(", ")}], actual [${actual.join(", ") || "no tool calls"}]`;
  if (mode === "strict") {
    const matched = exp.length === actual.length && exp.every((t, i) => t === actual[i]);
    return { matched, reasoning: `strict order match: ${summary}` };
  }
  if (mode === "unordered") {
    const a = multiset(exp);
    const b = multiset(actual);
    const matched = a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    return { matched, reasoning: `unordered match: ${summary}` };
  }
  if (mode === "superset") {
    const b = multiset(actual);
    const matched = [...multiset(exp)].every(([k, v]) => (b.get(k) ?? 0) >= v);
    return { matched, reasoning: `superset match (all expected calls present, extras allowed): ${summary}` };
  }
  const allowed = new Set(exp);
  const matched = actual.every(t => allowed.has(t));
  return { matched, reasoning: `subset match (no unexpected calls, missing allowed): ${summary}` };
}
