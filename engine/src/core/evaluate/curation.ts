import type { Db } from "../../storage/db.js";
import { traceStoreFor } from "../trace/store/index.js";
import { getTraceRow, type TraceRow } from "../trace/ingest.js";
import { reconstructMessages } from "./portability.js";
import { getDataset, updateDataset, extractSimilarityConfig, extractCodeScorers } from "./datasets.js";
import { callJudgeJson, computeEmbedding, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { extractText } from "../monitor/events.js";
import { cosine, normalizeText } from "../shared/vector.js";

// The Curate step: turn what production actually did (a trace, or a whole session) into a golden
// dataset case - the flywheel that grows regression tests out of real failures instead of
// hand-authoring them. Deliberately preview -> human edits -> append, never a silent auto-add:
// the expected answer is the human's call (optionally drafted by suggestExpected), and the runner
// never sees a case nobody looked at. The `source` provenance field is opaque to runs.ts (which
// only reads main_question/follow_up_questions) but lets the dashboard badge production-born
// cases and lets addCaseToDataset refuse to add the same trace twice.

export type CuratedTestCase = { query: string; expectedResults: string | null };

export type CuratedCase = {
  main_question: CuratedTestCase;
  follow_up_questions: CuratedTestCase[];
  source: { traceId?: string; sessionId?: string; signalId?: string; addedAt: string };
};

export type CasePreviewTurn = { query: string; actualOutput: string; error: string | null; traceId: string };

export type CasePreview = {
  case: CuratedCase;
  // What actually happened per turn, so the human (or suggestExpected) writes the corrected
  // expected answer with the real failure in front of them. Not part of the stored case.
  turns: CasePreviewTurn[];
};

// When the input is a real message array (SDK traces that thread conversation history send
// [system, ...history, current]), the current turn's question is the LAST user message - earlier
// user turns belong to earlier traces, not this one. Anything else goes through extractText,
// which already unwraps the common { query } / { text } wrapper shapes into plain text.
function extractQuery(trace: Pick<TraceRow, "input" | "metadata">): string {
  const { messages, usedStructuredInput } = reconstructMessages(trace);
  if (usedStructuredInput) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === "user" && message.content.trim()) {
        return message.content.trim();
      }
    }
  }
  return extractText(trace.input).trim();
}

function toPreviewTurn(row: TraceRow): CasePreviewTurn {
  return {
    query: extractQuery(row),
    actualOutput: extractText(row.output).trim(),
    error: row.error,
    traceId: row.id,
  };
}

export async function previewCaseFromTrace(db: Db, traceId: string): Promise<CasePreview | null> {
  const row = await getTraceRow(db, traceId);
  if (!row) return null;
  const turn = toPreviewTurn(row);
  if (!turn.query) return null;
  return {
    case: {
      main_question: { query: turn.query, expectedResults: null },
      follow_up_questions: [],
      source: { traceId, addedAt: new Date().toISOString() },
    },
    turns: [turn],
  };
}

export async function previewCaseFromSession(db: Db, sessionId: string): Promise<CasePreview | null> {
  // Full-row select + JS filter/sort (the cross-dialect idiom used everywhere else): a turn is a
  // root span; child spans are steps inside a turn and never become dataset turns themselves.
  const rows = (await traceStoreFor(db).listBySession(sessionId)) as TraceRow[];
  const roots = rows.filter(r => !r.parentSpanId);
  roots.sort((a, b) => (a.startedAt ?? a.createdAt).getTime() - (b.startedAt ?? b.createdAt).getTime());
  const turns = roots.map(toPreviewTurn).filter(t => t.query);
  const first = turns[0];
  if (!first) return null;
  return {
    case: {
      main_question: { query: first.query, expectedResults: null },
      follow_up_questions: turns.slice(1).map(t => ({ query: t.query, expectedResults: null })),
      source: { sessionId, addedAt: new Date().toISOString() },
    },
    turns,
  };
}

const SUGGEST_EXPECTED_SCHEMA = {
  type: "object",
  properties: {
    expected: { type: "string", description: "The ideal expected answer for this test case" },
    rationale: { type: "string", description: "One or two sentences on how this differs from what the agent did" },
  },
  required: ["expected"],
  additionalProperties: false,
} as const;

// Drafts the corrected expected answer from the real (possibly flawed) exchange - a starting
// point for the human editing the case, never auto-saved. Kept deliberately generic: it sees one
// turn, not the dataset's criteria, because at curation time the case may be headed for a dataset
// that doesn't exist yet.
export async function suggestExpected(input: {
  query: string;
  actualOutput?: string;
  error?: string;
  judgeModel?: string;
}): Promise<{ expected: string; rationale: string | null }> {
  const parts = [
    "You are helping build a golden test dataset for an AI agent. Given a real user query and what the agent actually did, write the IDEAL expected answer this test case should assert - correct, complete, and concise. If the agent's actual response was already good, refine it into a clean reference answer; if it was wrong or errored, write what it should have said instead.",
    `User query:\n${input.query}`,
  ];
  if (input.actualOutput) parts.push(`Agent's actual response:\n${input.actualOutput}`);
  if (input.error) parts.push(`The agent errored: ${input.error}`);
  const result = await callJudgeJson({
    userMessage: parts.join("\n\n"),
    model: input.judgeModel || DEFAULT_JUDGE_MODEL,
    jsonSchema: SUGGEST_EXPECTED_SCHEMA,
    maxTokens: 1000,
  });
  const payload = result.payload as { expected?: unknown; rationale?: unknown } | null;
  const expected = typeof payload?.expected === "string" ? payload.expected.trim() : "";
  if (!expected) throw new Error("Judge returned no expected answer");
  return { expected, rationale: typeof payload?.rationale === "string" ? payload.rationale : null };
}

type ExistingQuestion = {
  main_question?: { query?: unknown };
  source?: { traceId?: unknown; sessionId?: unknown };
};

const normalize = normalizeText;

// Calibrated for text-embedding-3-small (DEFAULT_EMBEDDING_MODEL), whose cosines run well below
// older models': measured paraphrase pairs score 0.82-0.88 while related-but-distinct questions
// ("what's your refund policy" vs "how long does a refund take") score 0.48-0.56, so 0.75 splits
// the two populations with real margin on both sides. Recalibrate if the embedding model changes.
//
// Exported so core/insights/ scores against the same two populations: its "covered" verdict means
// "addCaseToDataset would reject this as a duplicate". `related` is the FLOOR of the measured
// related band (0.48), not its ceiling - a pair at 0.50 is genuinely related and must not be
// reported as having nothing in common.
export const SIMILARITY_BANDS = { covered: 0.75, related: 0.48 } as const;

const DEDUPE_SIMILARITY_THRESHOLD = SIMILARITY_BANDS.covered;
const DEDUPE_EMBEDDING_CAP = 100;

export type DuplicateInfo = { reason: "same-source" | "same-query" | "similar-query"; existingQuery: string; similarity?: number };

// Three escalating checks: provenance (this exact trace/session was already added), normalized
// exact match, then embedding similarity (skipped silently with no OPENAI_API_KEY - dedupe
// degrades, it never blocks). Capped so a big dataset doesn't turn one add into hundreds of
// embedding calls.
async function findDuplicate(existing: ExistingQuestion[], candidate: CuratedCase): Promise<DuplicateInfo | null> {
  for (const q of existing) {
    const src = q.source;
    if (!src) continue;
    if (candidate.source.traceId && src.traceId === candidate.source.traceId) {
      return { reason: "same-source", existingQuery: String(q.main_question?.query ?? "") };
    }
    if (candidate.source.sessionId && src.sessionId === candidate.source.sessionId) {
      return { reason: "same-source", existingQuery: String(q.main_question?.query ?? "") };
    }
  }
  const candidateNorm = normalize(candidate.main_question.query);
  for (const q of existing) {
    const query = typeof q.main_question?.query === "string" ? q.main_question.query : "";
    if (query && normalize(query) === candidateNorm) {
      return { reason: "same-query", existingQuery: query };
    }
  }
  const candidateEmb = await computeEmbedding(candidate.main_question.query);
  if (!candidateEmb) return null;
  for (const q of existing.slice(0, DEDUPE_EMBEDDING_CAP)) {
    const query = typeof q.main_question?.query === "string" ? q.main_question.query : "";
    if (!query) continue;
    const emb = await computeEmbedding(query);
    if (!emb) continue;
    const similarity = cosine(candidateEmb, emb);
    if (similarity >= DEDUPE_SIMILARITY_THRESHOLD) {
      return { reason: "similar-query", existingQuery: query, similarity: Math.round(similarity * 1000) / 1000 };
    }
  }
  return null;
}

export type AddCaseResult =
  | { ok: true; caseCount: number }
  | { ok: false; duplicate: DuplicateInfo }
  | { ok: false; error: "not-found" };

export async function addCaseToDataset(
  db: Db,
  datasetId: string,
  curatedCase: CuratedCase,
  opts: { dedupe?: boolean } = {}
): Promise<AddCaseResult> {
  const dataset = (await getDataset(db, datasetId)) as
    | (Record<string, unknown> & { name: string; questions: unknown })
    | null
    | undefined;
  if (!dataset) return { ok: false, error: "not-found" };
  const questions = (Array.isArray(dataset.questions) ? dataset.questions : []) as ExistingQuestion[];

  if (opts.dedupe !== false) {
    const duplicate = await findDuplicate(questions, curatedCase);
    if (duplicate) return { ok: false, duplicate };
  }

  // updateDataset (not a raw column write) so the append lands in version history like any other
  // dataset edit. The wire shape spreads similarityConfig flat, so extract helpers map it back.
  await updateDataset(db, datasetId, {
    name: dataset.name,
    description: (dataset.description as string | undefined) ?? undefined,
    numberOfRequests: (dataset.numberOfRequests as number | undefined) ?? undefined,
    similarityConfig: extractSimilarityConfig(dataset),
    codeScorers: extractCodeScorers(dataset),
    acceptanceCriteria: (dataset.acceptanceCriteria as string | undefined) ?? undefined,
    rejectionCriteria: (dataset.rejectionCriteria as string | undefined) ?? undefined,
    evaluationCriteria: (dataset.evaluationCriteria as string | undefined) ?? undefined,
    questions: [...questions, curatedCase],
  });
  return { ok: true, caseCount: questions.length + 1 };
}
