import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { getDataset } from "./datasets.js";

// Synthetic golden-case generation: paste a source document (policy text, API docs, FAQ, spec)
// and get dataset cases whose expected results are grounded in it - the "cold start" answer for
// teams with no production traffic to curate from yet. Compute-and-return: the route hands the
// generated cases back for human review, and the dashboard appends the kept ones through the
// normal dataset-update path. Nothing lands in a dataset unreviewed.

const MAX_CASES = 20;

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string", description: "A realistic user question or request, in a real user's voice" },
          expectedResults: {
            type: "string",
            description: "Concise description of what a correct response must contain, grounded ONLY in the source",
          },
        },
        required: ["query", "expectedResults"],
      },
    },
  },
  required: ["cases"],
};

export type SyntheticCase = { query: string; expectedResults: string };

export async function generateSyntheticCases(
  db: Db,
  input: { sourceText: string; count: number; guidance?: string; datasetId?: string }
): Promise<{ cases: SyntheticCase[]; judgeModel: string } | { error: string }> {
  const sourceText = input.sourceText.trim();
  if (!sourceText) {
    return { error: "sourceText is required - paste the document the cases should be grounded in" };
  }
  const count = Math.max(1, Math.min(MAX_CASES, Math.floor(input.count) || 5));

  // A couple of the dataset's existing cases as few-shot style anchors, so generated cases read
  // like the ones the team already writes (tone, granularity of expected results).
  let styleBlock = "";
  if (input.datasetId) {
    const dataset = await getDataset(db, input.datasetId);
    const examples = ((dataset?.questions ?? []) as { main_question?: { query?: string; expectedResults?: string } }[])
      .map(q => q.main_question)
      .filter((q): q is { query: string; expectedResults?: string } => !!q?.query)
      .slice(0, 2);
    if (examples.length > 0) {
      styleBlock = `\n\nThe dataset already contains cases like these - match their style and granularity:\n${examples
        .map(e => `- Query: ${e.query}\n  Expected: ${e.expectedResults ?? "(none)"}`)
        .join("\n")}`;
    }
  }

  const userMessage = `Generate ${count} evaluation test cases for an AI assistant, grounded in the SOURCE below.

Rules:
- Each query must be something a real user would plausibly ask, answerable from the source.
- Each expectedResults must describe what a correct answer contains, using ONLY facts from the source - never outside knowledge.
- Vary difficulty and shape: direct lookups, cases needing two facts combined, at least one query whose correct answer is that the source does not cover it (expectedResults should say the assistant must say so rather than invent).
- Vary phrasing: terse, verbose, imprecise wording - not uniform textbook questions.${
    input.guidance ? `\n- Additional guidance from the team: ${input.guidance}` : ""
  }${styleBlock}

SOURCE:
${sourceText}`;

  const result = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    jsonSchema: SYNTHESIS_SCHEMA,
    userMessage,
    maxTokens: 4000,
  });
  const payload = result.payload as { cases?: unknown } | null;
  const cases = (Array.isArray(payload?.cases) ? payload.cases : [])
    .filter(
      (c): c is SyntheticCase =>
        !!c &&
        typeof c === "object" &&
        typeof (c as { query?: unknown }).query === "string" &&
        typeof (c as { expectedResults?: unknown }).expectedResults === "string"
    )
    .slice(0, count);
  if (cases.length === 0) {
    return { error: "The generator returned no usable cases - try a longer or more specific source" };
  }
  return { cases, judgeModel: DEFAULT_JUDGE_MODEL };
}
