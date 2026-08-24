import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { extractText } from "./events.js";

// Session-level scoring storage + transcript assembly (see schema.sqlite.ts's sessionScores) - a
// judge verdict over a whole multi-span session's assembled conversation, the thing per-trace
// patterns/evaluators can't see: each of those judges one input/output pair in isolation, so
// "every individual reply looked fine but the conversation as a whole lost the thread" is
// invisible to them by construction. Braintrust calls this a trace-level scorer over the full
// message history and Langfuse a session score.
//
// The judging itself lives in core/monitor/sessionSweep.ts (the idle-session sweep plus the
// on-demand runSessionBaselineCheck), driven by session-scoped Online Evaluators - including the
// built-in Session Baseline Judge (core/monitor/builtinEvaluators.ts), whose rubric is a real
// evaluator config, not code. spanCount records what a check actually saw, so a later check on
// the same (now longer) session appends a new snapshot row rather than mutating the old one.

// Caps keep the judge prompt bounded for long sessions: enough context to judge coherence,
// not a full-fidelity replay. Middle spans are elided (first/last kept) since coherence failures
// show up in how the ending relates to the beginning; per-span text is truncated hard.
const MAX_SPANS_IN_PROMPT = 40;
const MAX_TEXT_PER_SPAN = 1200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

// The subset of listSessionSpans' wire shape (ingest.ts's toTraceDetailWire) this module reads.
export type SpanWire = {
  _id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  model?: string;
  toolCalls?: unknown;
  parentSpanId?: string;
};

function buildSpanLine(span: SpanWire, index: number, includeToolLines = true): string {
  const parts = [`[${index}] ${span.name}${span.model ? ` (${span.model})` : ""}`];
  const input = span.input !== undefined ? truncate(extractText(span.input), MAX_TEXT_PER_SPAN) : "";
  const output = span.output !== undefined ? truncate(extractText(span.output), MAX_TEXT_PER_SPAN) : "";
  if (input) parts.push(`  input: ${input}`);
  // toolContext="none": the judge sees the conversation, not the plumbing.
  if (includeToolLines && Array.isArray(span.toolCalls) && span.toolCalls.length > 0) {
    const names = span.toolCalls
      .map(t => (t && typeof t === "object" && "name" in t ? String((t as { name: unknown }).name) : "unknown"))
      .join(", ");
    parts.push(`  tools called: ${names}`);
  }
  if (output) parts.push(`  output: ${output}`);
  if (span.error) parts.push(`  ERROR: ${truncate(span.error, MAX_TEXT_PER_SPAN)}`);
  return parts.join("\n");
}

// One structured citation from the session judge: which step broke what, in a few words. spanId
// resolves the cited transcript index to a real span (null when the transcript was elided -
// index ambiguity, same rule as driftSpanId); tag is a judge-chosen 1-3 word category
// ("Contradiction", "Lost context", "Tool misuse").
export type SessionFinding = {
  spanId: string | null;
  spanIndex: number;
  text: string;
  tag: string;
};

export type SessionScoreWire = {
  _id: string;
  sessionId: string;
  kind: string;
  rating: number | null;
  justification: string | null;
  driftSpanId: string | null;
  findings: SessionFinding[];
  spanCount: number;
  judgeModel: string;
  createdAt: string;
};

type SessionScoreRow = {
  id: string;
  projectId: string | null;
  sessionId: string;
  kind: string;
  rating: number | null;
  justification: string | null;
  driftSpanId: string | null;
  findings: unknown;
  spanCount: number;
  judgeModel: string;
  createdAt: Date;
};

function toWire(row: SessionScoreRow): SessionScoreWire {
  return {
    _id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    rating: row.rating,
    justification: row.justification,
    driftSpanId: row.driftSpanId,
    findings: Array.isArray(row.findings) ? (row.findings as SessionFinding[]) : [],
    spanCount: row.spanCount,
    judgeModel: row.judgeModel,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSessionScores(db: Db, sessionId: string): Promise<SessionScoreWire[]> {
  const cond = and(eq(db.schema.sessionScores.sessionId, sessionId), eq(db.schema.sessionScores.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.sessionScores).where(cond).all()
      : await db.db.select().from(db.schema.sessionScores).where(cond)
  ) as SessionScoreRow[];
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return rows.map(toWire);
}

// Throws on a missing judge key (callJudgeJson's own clear setup error) - the route surfaces that
// as a 4xx with the real message, same posture as every other judge-backed dashboard action.
// Returns null when the session doesn't exist / has no spans.
// Shared transcript assembly - used by the coherence check below and by the idle-session sweep's
// criteria-based session evaluators (core/monitor/sessionSweep.ts), so every session-level judge
// reads the same bounded excerpt format. Keep first/last spans, elide the middle beyond the cap -
// see MAX_SPANS_IN_PROMPT's comment.
export function buildSessionTranscript(
  spans: SpanWire[],
  options: { includeToolLines?: boolean } = {}
): {
  transcript: string;
  promptSpans: SpanWire[];
  elidedNote: string;
} {
  const includeToolLines = options.includeToolLines ?? true;
  let promptSpans = spans;
  let elidedNote = "";
  if (spans.length > MAX_SPANS_IN_PROMPT) {
    const head = Math.ceil(MAX_SPANS_IN_PROMPT / 2);
    const tail = MAX_SPANS_IN_PROMPT - head;
    promptSpans = [...spans.slice(0, head), ...spans.slice(spans.length - tail)];
    elidedNote = `\n(Note: ${spans.length - MAX_SPANS_IN_PROMPT} middle spans elided for length - indices below are positions in this excerpt, not the full session.)`;
  }
  const transcript = promptSpans.map((span, i) => buildSpanLine(span, i, includeToolLines)).join("\n\n");
  return { transcript, promptSpans, elidedNote };
}

// The sweep's write path for non-coherence session scores - same table/wire as the coherence
// check, different `kind` (`online-eval:<evaluatorId>`), so the Sessions detail view lists every
// session-level verdict through one query.
export async function insertSessionScore(
  db: Db,
  input: {
    sessionId: string;
    kind: string;
    rating: number | null;
    justification: string | null;
    // The Session Baseline Judge's drift pointer (first span where the conversation broke) -
    // null/omitted for every other evaluator's verdicts.
    driftSpanId?: string | null;
    findings?: SessionFinding[];
    spanCount: number;
    judgeModel: string;
  }
): Promise<SessionScoreWire> {
  const row: SessionScoreRow = {
    id: nanoid(),
    projectId: db.projectId,
    sessionId: input.sessionId,
    kind: input.kind,
    rating: input.rating,
    justification: input.justification,
    driftSpanId: input.driftSpanId ?? null,
    findings: input.findings ?? null,
    spanCount: input.spanCount,
    judgeModel: input.judgeModel,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.sessionScores).values(row);
  } else {
    await db.db.insert(db.schema.sessionScores).values(row);
  }
  return toWire(row);
}

