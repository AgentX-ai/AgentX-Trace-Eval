import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { listSessionSpans } from "../trace/ingest.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { extractText } from "./events.js";

// Session-level scoring (see schema.sqlite.ts's sessionScores) - a judge verdict over a whole
// multi-span session's assembled conversation, the thing per-trace patterns/evaluators can't see:
// each of those judges one input/output pair in isolation, so "every individual reply looked fine
// but the conversation as a whole lost the thread" (agents drifting off-goal mid-workflow,
// contradicting an earlier step, re-doing completed work) is invisible to them by construction.
// Braintrust calls this a trace-level scorer over the full message history and Langfuse a session
// score - both leave writing the actual judge to the user; this ships it as a built-in check.
//
// v1 is on-demand only ("Check coherence" on the trace detail's span-tree panel), not run at
// ingest: a session has no clean end event (an OTel session can keep adding spans indefinitely),
// so auto-scoring on every arriving span would repeatedly judge an incomplete conversation and
// burn real judge calls doing it. spanCount records what the check actually saw, so a later check
// on the same (now longer) session appends a new snapshot row rather than mutating the old one.

// Caps keep the judge prompt bounded for long sessions: enough context to judge coherence,
// not a full-fidelity replay. Middle spans are elided (first/last kept) since coherence failures
// show up in how the ending relates to the beginning; per-span text is truncated hard.
const MAX_SPANS_IN_PROMPT = 40;
const MAX_TEXT_PER_SPAN = 1200;

const COHERENCE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "number", description: "0-10 coherence rating for the whole session" },
    justification: { type: "string", description: "What held together or where and how the session lost coherence" },
    driftSpanIndex: {
      type: ["number", "null"],
      description: "Index (from the numbered list) of the first span where coherence broke, or null if coherent throughout",
    },
  },
  required: ["rating", "justification", "driftSpanIndex"],
};

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
};

function buildSpanLine(span: SpanWire, index: number): string {
  const parts = [`[${index}] ${span.name}${span.model ? ` (${span.model})` : ""}`];
  const input = span.input !== undefined ? truncate(extractText(span.input), MAX_TEXT_PER_SPAN) : "";
  const output = span.output !== undefined ? truncate(extractText(span.output), MAX_TEXT_PER_SPAN) : "";
  if (input) parts.push(`  input: ${input}`);
  if (Array.isArray(span.toolCalls) && span.toolCalls.length > 0) {
    const names = span.toolCalls
      .map(t => (t && typeof t === "object" && "name" in t ? String((t as { name: unknown }).name) : "unknown"))
      .join(", ");
    parts.push(`  tools called: ${names}`);
  }
  if (output) parts.push(`  output: ${output}`);
  if (span.error) parts.push(`  ERROR: ${truncate(span.error, MAX_TEXT_PER_SPAN)}`);
  return parts.join("\n");
}

export type SessionScoreWire = {
  _id: string;
  sessionId: string;
  kind: string;
  rating: number | null;
  justification: string | null;
  driftSpanId: string | null;
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
export function buildSessionTranscript(spans: SpanWire[]): {
  transcript: string;
  promptSpans: SpanWire[];
  elidedNote: string;
} {
  let promptSpans = spans;
  let elidedNote = "";
  if (spans.length > MAX_SPANS_IN_PROMPT) {
    const head = Math.ceil(MAX_SPANS_IN_PROMPT / 2);
    const tail = MAX_SPANS_IN_PROMPT - head;
    promptSpans = [...spans.slice(0, head), ...spans.slice(spans.length - tail)];
    elidedNote = `\n(Note: ${spans.length - MAX_SPANS_IN_PROMPT} middle spans elided for length - indices below are positions in this excerpt, not the full session.)`;
  }
  const transcript = promptSpans.map((span, i) => buildSpanLine(span, i)).join("\n\n");
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
    driftSpanId: null,
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

export async function runSessionCoherenceCheck(
  db: Db,
  sessionId: string,
  judgeModel: string = DEFAULT_JUDGE_MODEL
): Promise<SessionScoreWire | null> {
  const spans = await listSessionSpans(db, sessionId);
  if (spans.length === 0) {
    return null;
  }

  const { transcript, promptSpans, elidedNote } = buildSessionTranscript(spans as SpanWire[]);
  const userMessage = `You are evaluating whether a multi-step AI agent session stayed coherent from start to finish. Each numbered entry below is one step (an LLM call, tool call, or sub-agent) in chronological order.${elidedNote}

Judge the session as a whole, not each step in isolation:
- Did later steps stay consistent with what earlier steps established (goals, facts, constraints, prior answers)?
- Did the agent maintain the thread of the task, or drift off-goal, contradict itself, lose context it previously had, or redo work it already completed?
- Do the steps compose into a sensible overall trajectory toward resolving the task?

Session:

${transcript}

Rate overall coherence 0-10 (10 = fully coherent throughout, 0 = completely incoherent). If coherence broke, identify the index of the FIRST step where it happened.`;

  const result = await callJudgeJson({ model: judgeModel, jsonSchema: COHERENCE_SCHEMA, userMessage, maxTokens: 1500 });
  const payload = result.payload as { rating?: unknown; justification?: unknown; driftSpanIndex?: unknown } | null;

  const rating = typeof payload?.rating === "number" ? Math.max(0, Math.min(10, payload.rating)) : null;
  const justification = typeof payload?.justification === "string" ? payload.justification : null;
  const driftIndex =
    typeof payload?.driftSpanIndex === "number" && Number.isInteger(payload.driftSpanIndex) ? payload.driftSpanIndex : null;
  // Map the excerpt index back to the real span's id - only trustworthy when nothing was elided
  // (see elidedNote above); with elision the index ambiguity isn't worth a wrong span highlight.
  const driftSpanId =
    driftIndex !== null && !elidedNote && driftIndex >= 0 && driftIndex < promptSpans.length
      ? promptSpans[driftIndex]!._id
      : null;

  const row: SessionScoreRow = {
    id: nanoid(),
    projectId: db.projectId,
    sessionId,
    kind: "coherence",
    rating,
    justification,
    driftSpanId,
    spanCount: spans.length,
    judgeModel,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.sessionScores).values(row);
  } else {
    await db.db.insert(db.schema.sessionScores).values(row);
  }
  return toWire(row);
}
