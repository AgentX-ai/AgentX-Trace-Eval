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
  metadata?: unknown;
};

// A span is a retrieval if it says so (metadata.kind, stamped by the SDK's record_retrieval /
// trace_retrieval and the LangChain handler) - the "Retrieval N" name test is only a fallback
// for traces recorded before the marker existed, so custom names like "kb_search" still count.
export function isRetrievalSpan(span: { name: string; metadata?: unknown }): boolean {
  const kind = (span.metadata as { kind?: unknown } | null | undefined)?.kind;
  if (typeof kind === "string") return kind === "retrieval";
  return /^retriev/i.test(span.name);
}

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

function normalizeNames(names: string[]): string[] {
  return names.map(t => t.trim()).filter(Boolean);
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
  // Both sides get the same treatment. Trimming only `expected` made the verdict depend on which
  // side the incidental whitespace was on: expected " search" vs actual "search" matched, while
  // expected "search" vs actual " search" did not - the same pair, scored two different ways.
  const exp = normalizeNames(expected);
  const act = normalizeNames(actual);
  const summary = `expected [${exp.join(", ")}], actual [${act.join(", ") || "no tool calls"}]`;
  if (mode === "strict") {
    const matched = exp.length === act.length && exp.every((t, i) => t === act[i]);
    return { matched, reasoning: `strict order match: ${summary}` };
  }
  if (mode === "unordered") {
    const a = multiset(exp);
    const b = multiset(act);
    const matched = a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    return { matched, reasoning: `unordered match: ${summary}` };
  }
  if (mode === "superset") {
    const b = multiset(act);
    const matched = [...multiset(exp)].every(([k, v]) => (b.get(k) ?? 0) >= v);
    return { matched, reasoning: `superset match (all expected calls present, extras allowed): ${summary}` };
  }
  const allowed = new Set(exp);
  const matched = act.every(t => allowed.has(t));
  return { matched, reasoning: `subset match (no unexpected calls, missing allowed): ${summary}` };
}

// ---------------------------------------------------------------------------
// Retrieval context extraction: what the agent actually retrieved for one interaction, rendered
// for {context}-referencing judge prompts (the RAG metric pack). Sources, in order: the trace's
// own metadata.retrievalContext (explicit opt-in, handled by callers), the subtree's recorded
// retrieval spans (marked metadata.kind === "retrieval" by the SDK, "Retrieval N" names as a
// legacy fallback - see isRetrievalSpan), and a performanceSummary retrieval_steps list from
// older flat traces.
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 12_000;

function chunkText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value != null && typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 2 ? text : null;
  }
  return null;
}

export async function getTraceRetrievalContext(db: Db, traceId: string): Promise<string | null> {
  const cond = and(eq(db.schema.traces.id, traceId), eq(db.schema.traces.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond);
  const root = rows[0] as
    | { spanId: string | null; sessionId: string | null; performanceSummary: unknown }
    | undefined;
  if (!root) return null;

  const chunks: string[] = [];

  if (root.spanId && root.sessionId) {
    const spans = (await listSessionSpans(db, root.sessionId)) as SpanWire[];
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
    for (const span of spans) {
      if (!span.spanId || !included.has(span.spanId) || !span.parentSpanId) continue;
      if (!isRetrievalSpan(span)) continue;
      const text = chunkText(span.output);
      if (text) chunks.push(text);
    }
  }

  // Older flat traces: retrieval steps folded into performanceSummary instead of child spans.
  const summary = root.performanceSummary as { retrieval_steps?: unknown; retrievalSteps?: unknown } | null;
  for (const list of [summary?.retrieval_steps, summary?.retrievalSteps]) {
    if (!Array.isArray(list)) continue;
    for (const step of list) {
      const text = chunkText((step as { output?: unknown })?.output);
      if (text) chunks.push(text);
    }
  }

  if (chunks.length === 0) return null;
  const joined = chunks.map((c, i) => `[retrieval ${i + 1}] ${c}`).join("\n\n");
  return joined.length > MAX_CONTEXT_CHARS ? `${joined.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)` : joined;
}

// ---------------------------------------------------------------------------
// Tool definitions for the "detailed" tool-context level
// ---------------------------------------------------------------------------

// The SDK's LLM auto-instrumentation (OpenAI/Anthropic/Google GenAI/LiteLLM patches, the
// LangChain handler - see AgentX-Python's integrations/_traced_call.py capture_tool_definitions)
// records each request's full `tools=[...]` list into the span's metadata.tools: names,
// descriptions, and complete parameter schemas, exactly as the model saw them on THAT call.
//
// At toolContext="detailed" the judge gets, after the trajectory:
//   - the full definition of every tool the agent actually USED (deduped by name; the
//     trace-captured menu wins, the Tools & MCPs registry is a by-name fallback for manual
//     tracer users) - the context for judging whether a call was set up to fail by a vague
//     description or missing enum
//   - one cheap line naming advertised-but-unused tools, so "was there a better tool it
//     didn't pick?" stays gradeable without paying for unused schemas
// Used-names-only lookup is what makes the registry fallback safe: the registry is
// project-wide, but a lookup keyed by the names this agent actually called can never inject
// another agent's tools.
const DEFS_MAX_TOOLS = 20;
const DEFS_MAX_DEFINITION = 600;

function toolDefName(def: unknown): string | null {
  if (!def || typeof def !== "object") return null;
  const d = def as { name?: unknown; function?: { name?: unknown } };
  // OpenAI shape nests under .function; Anthropic/Google are flat.
  const name = d.function?.name ?? d.name;
  return typeof name === "string" && name ? name : null;
}

function toolDefDescription(def: unknown): string | null {
  if (!def || typeof def !== "object") return null;
  const d = def as { description?: unknown; function?: { description?: unknown } };
  const description = d.function?.description ?? d.description;
  return typeof description === "string" && description ? description : null;
}

function metadataTools(metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== "object") return [];
  const tools = (metadata as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools : [];
}

function toolCallNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map(tc => (tc && typeof tc === "object" && "name" in tc ? String((tc as { name: unknown }).name) : ""))
    .filter(Boolean);
}

function truncateDef(def: unknown): string {
  const text = JSON.stringify(def).replace(/\s+/g, " ");
  return text.length > DEFS_MAX_DEFINITION ? `${text.slice(0, DEFS_MAX_DEFINITION)}...` : text;
}

// Core assembly, span-list driven so both the per-trace and per-session paths share it.
async function renderDefsFromSpans(
  db: Db,
  spans: Array<{ name: string; parentSpanId?: string | null; metadata?: unknown; toolCalls?: unknown }>
): Promise<string | null> {
  // The advertised menu: every metadata.tools capture across the spans, deduped by name.
  const menu = new Map<string, unknown>();
  for (const span of spans) {
    for (const def of metadataTools(span.metadata)) {
      const name = toolDefName(def);
      if (name && !menu.has(name)) menu.set(name, def);
    }
  }
  // Used tool names: flat toolCalls entries plus child-span names that match an advertised
  // tool (a tool child span is named after its tool; matching against the menu/registry keeps
  // LLM/step spans from being mistaken for tools).
  const usedNames = new Set<string>();
  for (const span of spans) {
    for (const name of toolCallNames(span.toolCalls)) usedNames.add(name);
    if (span.parentSpanId && menu.has(span.name)) usedNames.add(span.name);
  }
  // Registry fallback ONLY for used names the menu didn't cover (and to classify child spans
  // when no menu was captured at all).
  const { getRegistryToolsByName } = await import("../evaluate/toolSchemas.js");
  const childNames = spans.filter(s => s.parentSpanId).map(s => s.name);
  const registry = await getRegistryToolsByName(db, [...new Set([...usedNames, ...childNames])]);
  for (const span of spans) {
    if (span.parentSpanId && registry.has(span.name)) usedNames.add(span.name);
  }
  if (usedNames.size === 0 && menu.size === 0) return null;

  const lines: string[] = [];
  const used = [...usedNames].slice(0, DEFS_MAX_TOOLS);
  for (const name of used) {
    const fromMenu = menu.get(name);
    if (fromMenu) {
      lines.push(`- ${name}: ${truncateDef(fromMenu)}`);
      continue;
    }
    const fromRegistry = registry.get(name);
    if (fromRegistry) {
      const def = fromRegistry.definition.replace(/\s+/g, " ");
      const truncated = def.length > DEFS_MAX_DEFINITION ? `${def.slice(0, DEFS_MAX_DEFINITION)}...` : def;
      lines.push(
        `- ${name}${fromRegistry.description ? ` (${fromRegistry.description})` : ""}: ${truncated} [from the tool registry]`
      );
    } else {
      lines.push(`- ${name}: (no definition captured or registered)`);
    }
  }
  if (usedNames.size > DEFS_MAX_TOOLS) lines.push(`... ${usedNames.size - DEFS_MAX_TOOLS} more used tools omitted`);

  const unused = [...menu.keys()].filter(name => !usedNames.has(name));
  const unusedLine =
    unused.length > 0
      ? `\nAlso advertised to the model but NOT used: ${unused
          .slice(0, DEFS_MAX_TOOLS)
          .map(name => {
            const description = toolDefDescription(menu.get(name));
            return description ? `${name} (${description.slice(0, 120)})` : name;
          })
          .join("; ")}`
      : "";
  if (lines.length === 0 && !unusedLine) return null;
  const usedBlock =
    lines.length > 0 ? `Definitions of the tools the agent used (exactly as the model saw them):\n${lines.join("\n")}` : "The agent used no tools.";
  return `${usedBlock}${unusedLine}`;
}

export async function renderUsedToolDefinitions(db: Db, traceId: string): Promise<string | null> {
  const cond = and(eq(db.schema.traces.id, traceId), eq(db.schema.traces.projectId, db.projectId));
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond);
  const root = rows[0] as
    | { name: string; spanId: string | null; sessionId: string | null; metadata: unknown; toolCalls: unknown }
    | undefined;
  if (!root) return null;
  const spans: Array<{ name: string; parentSpanId?: string | null; metadata?: unknown; toolCalls?: unknown }> = [
    { name: root.name, parentSpanId: null, metadata: root.metadata, toolCalls: root.toolCalls },
  ];
  if (root.spanId && root.sessionId) {
    const sessionSpans = (await listSessionSpans(db, root.sessionId)) as SpanWire[];
    // Same subtree scoping as renderTraceTrajectory: only THIS trace's steps.
    const included = new Set<string>([root.spanId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const span of sessionSpans) {
        if (span.spanId && span.parentSpanId && !included.has(span.spanId) && included.has(span.parentSpanId)) {
          included.add(span.spanId);
          changed = true;
        }
      }
    }
    for (const span of sessionSpans) {
      if (span.spanId && included.has(span.spanId) && span.spanId !== root.spanId) {
        spans.push({ name: span.name, parentSpanId: span.parentSpanId, metadata: span.metadata, toolCalls: span.toolCalls });
      }
    }
  }
  return renderDefsFromSpans(db, spans);
}

// Session-scope variant: the whole conversation's spans, for detailed session judging.
export async function renderSessionUsedToolDefinitions(db: Db, sessionId: string): Promise<string | null> {
  const spans = (await listSessionSpans(db, sessionId)) as SpanWire[];
  if (spans.length === 0) return null;
  return renderDefsFromSpans(
    db,
    spans.map(s => ({ name: s.name, parentSpanId: s.parentSpanId, metadata: s.metadata, toolCalls: s.toolCalls }))
  );
}
