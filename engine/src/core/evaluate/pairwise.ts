import { and, asc, desc, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { logger } from "../../log.js";
import { mapWithConcurrency } from "../shared/concurrency.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { compareRuns, getRunRowFull, resolveRunConfig, type RunCaseComparison } from "./runs.js";

// Head-to-head (pairwise) judging: "which of these two answers is better for this question",
// instead of "score this answer 0-10".
//
// Why it exists next to absolute scoring rather than replacing it: absolute scores are what you
// need for a threshold ("fail the build under 7"), but they drift between judge prompt versions
// and bunch up in the 7-8 band, so a 0.1 average delta between two runs is not evidence of
// anything. A preference between two concrete answers is the judgment a human would actually
// make, and it stays stable when the rubric wording moves.
//
// Position bias is the one methodological risk that makes or breaks this. Judges systematically
// favor whichever answer they read first, so:
//   - the presentation order alternates by case, which keeps a batch from being uniformly biased;
//   - the judge is asked about "Answer 1" and "Answer 2", never about run ids, so nothing leaks
//     which side is the candidate;
//   - bothOrders judges each pair twice with the sides swapped. A pair whose winner flips when
//     the order flips is recorded as a tie with flipped=true, because the verdict measured the
//     position and not the answer. The batch's flipRate is that count, reported rather than
//     hidden - it is the honest confidence signal for the whole comparison.

const CASE_CONCURRENCY = 4;

// A pairwise batch fans out one judge call per case (two with bothOrders). Uncapped, a large
// dataset would be an expensive surprise; the cap is enforced server-side and reported.
export const MAX_PAIRWISE_CASES = 100;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    winner: {
      type: "string",
      enum: ["answer_1", "answer_2", "tie"],
      description: "Which answer better satisfies the criteria, or tie if they are equivalent",
    },
    justification: {
      type: "string",
      description: "One or two sentences on what decided it",
    },
  },
  required: ["winner", "justification"],
};

export type PairwiseWinner = "a" | "b" | "tie";

type Side = "a" | "b";

export type PairwiseCaseWire = {
  _id: string;
  questionIndex: number | null;
  query: string | null;
  winner: PairwiseWinner;
  presentedFirst: Side;
  flipped: boolean;
  justification: string | null;
  judgeModel: string | null;
  createdAt: string;
};

export type PairwiseSummary = {
  total: number;
  aWins: number;
  bWins: number;
  ties: number;
  // The batch verdict: which run won more cases, or "tie" when neither leads.
  winner: PairwiseWinner;
  // Share of cases whose winner flipped with the presentation order (bothOrders only). High flip
  // rate means the judge is reading position, not quality - treat the whole batch as inconclusive.
  flipRate: number | null;
};

export type PairwiseBatch = {
  batchId: string;
  runAId: string;
  runBId: string;
  bothOrders: boolean;
  judgeModel: string;
  summary: PairwiseSummary;
  cases: PairwiseCaseWire[];
  createdAt: string;
  // Cases present in the runs but not judged, with the reason - a comparison that silently
  // dropped half the dataset would read as a clean sweep.
  skipped: { questionIndex: number | null; reason: string }[];
};

type Row = {
  id: string;
  projectId: string | null;
  batchId: string;
  runAId: string;
  runBId: string;
  questionIndex: number | null;
  query: string | null;
  winner: string;
  presentedFirst: string;
  bothOrders: boolean;
  flipped: boolean;
  justification: string | null;
  judgeModel: string | null;
  createdAt: Date;
};

function toCaseWire(row: Row): PairwiseCaseWire {
  return {
    _id: row.id,
    questionIndex: row.questionIndex,
    query: row.query,
    winner: row.winner as PairwiseWinner,
    presentedFirst: row.presentedFirst as Side,
    flipped: row.flipped,
    justification: row.justification,
    judgeModel: row.judgeModel,
    createdAt: row.createdAt.toISOString(),
  };
}

export function summarize(cases: PairwiseCaseWire[], bothOrders: boolean): PairwiseSummary {
  const aWins = cases.filter(c => c.winner === "a").length;
  const bWins = cases.filter(c => c.winner === "b").length;
  const ties = cases.filter(c => c.winner === "tie").length;
  return {
    total: cases.length,
    aWins,
    bWins,
    ties,
    winner: aWins > bWins ? "a" : bWins > aWins ? "b" : "tie",
    flipRate:
      bothOrders && cases.length ? Math.round((cases.filter(c => c.flipped).length / cases.length) * 100) / 100 : null,
  };
}

const PROMPT_HEADER = `You are comparing two answers to the same question. Decide which answer is better.

Judge only the answers' quality against the criteria below. Ignore their length, their formatting, and the order they are presented in - the order is arbitrary and carries no meaning. If the two answers are equally good, or equally bad, say "tie" rather than picking arbitrarily.`;

function buildPrompt(query: string, first: string, second: string, criteria: string, expected: string | null): string {
  return `${PROMPT_HEADER}

**Question:**
${query}

${expected ? `**Reference answer (the ground truth for this question):**\n${expected}\n` : ""}
**Criteria:**
${criteria}

**Answer 1:**
${first}

**Answer 2:**
${second}`;
}

const DEFAULT_CRITERIA =
  "Which answer is more accurate, more complete, and more directly useful to the person who asked the question?";

// One judge call. Returns the winner in presentation terms ("answer_1"/"answer_2"/"tie"), which
// the caller maps back to a side - the judge never learns which run is which.
async function judgeOnce(
  query: string,
  first: string,
  second: string,
  criteria: string,
  expected: string | null,
  model: string,
): Promise<{ winner: "answer_1" | "answer_2" | "tie"; justification: string }> {
  const result = await callJudgeJson({
    model,
    jsonSchema: VERDICT_SCHEMA,
    userMessage: buildPrompt(query, first, second, criteria, expected),
  });
  const payload = result.payload as {
    winner?: string;
    justification?: string;
  } | null;
  if (!payload || !["answer_1", "answer_2", "tie"].includes(payload.winner ?? "")) {
    // An unusable verdict is a tie, never a coin flip toward one side.
    return {
      winner: "tie",
      justification: "The judge returned no usable verdict for this pair.",
    };
  }
  return {
    winner: payload.winner as "answer_1" | "answer_2" | "tie",
    justification: payload.justification ?? "",
  };
}

// Map a verdict expressed in presentation terms back to a run. Exported because getting this
// backwards would silently invert every comparison the product reports, and a unit test is the
// only cheap way to pin it.
export function toSide(verdict: string, firstIsA: boolean): PairwiseWinner {
  if (verdict === "tie") return "tie";
  if (verdict === "answer_1") return firstIsA ? "a" : "b";
  return firstIsA ? "b" : "a";
}

export type RunPairwiseInput = {
  runAId: string;
  runBId: string;
  criteria?: string;
  judgeModel?: string;
  bothOrders?: boolean;
};

export async function runPairwise(db: Db, input: RunPairwiseInput): Promise<PairwiseBatch | { error: string }> {
  if (input.runAId === input.runBId) {
    return { error: "A run cannot be compared with itself" };
  }
  const comparison = await compareRuns(db, input.runAId, input.runBId);
  if ("error" in comparison) return comparison;

  // Grade the head-to-head with the same material a normal run of this dataset would use: its
  // own evaluation criteria, and its per-question golden answer as the reference. Without the
  // reference the judge is left guessing at the policy it is supposed to be checking against,
  // which is how a confidently vague answer beats a correct one.
  const runRow = await getRunRowFull(db, input.runAId);
  const config = runRow ? await resolveRunConfig(db, runRow.datasetId, runRow.evaluationSettingsId) : null;

  const judgeModel = input.judgeModel?.trim() || config?.judgeModel || DEFAULT_JUDGE_MODEL;
  const criteria = input.criteria?.trim() || config?.evaluationCriteria?.trim() || DEFAULT_CRITERIA;
  const bothOrders = input.bothOrders ?? false;

  const skipped: { questionIndex: number | null; reason: string }[] = [];
  const judgeable: RunCaseComparison[] = [];
  for (const c of comparison.cases) {
    const missing = !c.baseline.output?.trim()
      ? "the first run produced no output for this case"
      : !c.candidate.output?.trim()
        ? "the second run produced no output for this case"
        : null;
    if (missing) {
      skipped.push({ questionIndex: c.questionIndex, reason: missing });
      continue;
    }
    judgeable.push(c);
  }
  if (judgeable.length === 0) {
    return {
      error: "No case has an answer from both runs - there is nothing to compare",
    };
  }
  const capped = judgeable.slice(0, MAX_PAIRWISE_CASES);
  for (const c of judgeable.slice(MAX_PAIRWISE_CASES)) {
    skipped.push({
      questionIndex: c.questionIndex,
      reason: `over the ${MAX_PAIRWISE_CASES}-case limit for one comparison`,
    });
  }

  const batchId = nanoid();
  const createdAt = new Date();

  const rows = await mapWithConcurrency(capped, CASE_CONCURRENCY, async (c, index) => {
    const aText = c.baseline.output ?? "";
    const bText = c.candidate.output ?? "";
    const expected =
      (c.questionIndex != null ? config?.questions[c.questionIndex]?.main_question?.expectedResults : null) || null;
    // Alternate which side is read first, so a biased judge cannot favor one run throughout.
    const aFirst = index % 2 === 0;
    const presentedFirst: Side = aFirst ? "a" : "b";

    let winner: PairwiseWinner;
    let flipped = false;
    let justification: string;
    try {
      const primary = await judgeOnce(
        c.query,
        aFirst ? aText : bText,
        aFirst ? bText : aText,
        criteria,
        expected,
        judgeModel,
      );
      winner = toSide(primary.winner, aFirst);
      justification = primary.justification;

      if (bothOrders) {
        const swapped = await judgeOnce(
          c.query,
          aFirst ? bText : aText,
          aFirst ? aText : bText,
          criteria,
          expected,
          judgeModel,
        );
        const swappedWinner = toSide(swapped.winner, !aFirst);
        if (swappedWinner !== winner) {
          // Opposite verdicts from the same pair: the order decided it, not the answers.
          flipped = true;
          winner = "tie";
          justification = `Verdict flipped when the answers were swapped, so this pair is scored as a tie. First pass: ${primary.justification} Second pass: ${swapped.justification}`;
        }
      }
    } catch (err) {
      logger.error({ err, questionIndex: c.questionIndex }, "Pairwise judge call failed");
      winner = "tie";
      justification = `Judging failed for this pair: ${(err as Error).message}`;
    }

    return {
      id: nanoid(),
      projectId: db.projectId,
      batchId,
      runAId: input.runAId,
      runBId: input.runBId,
      questionIndex: c.questionIndex,
      query: c.query,
      winner,
      presentedFirst,
      bothOrders,
      flipped,
      justification,
      judgeModel,
      createdAt,
    } satisfies Row;
  });

  // Per-dialect branch: the two insert builders do not share a callable signature (same shape as
  // every other write in this codebase).
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.pairwiseComparisons).values(rows);
  } else {
    await db.db.insert(db.schema.pairwiseComparisons).values(rows);
  }

  const cases = rows.map(toCaseWire);
  return {
    batchId,
    runAId: input.runAId,
    runBId: input.runBId,
    bothOrders,
    judgeModel,
    summary: summarize(cases, bothOrders),
    cases,
    createdAt: createdAt.toISOString(),
    skipped,
  };
}

const scope = (db: Db) =>
  or(eq(db.schema.pairwiseComparisons.projectId, db.projectId), isNull(db.schema.pairwiseComparisons.projectId));

async function rowsFor(db: Db, where: ReturnType<typeof scope>): Promise<Row[]> {
  if (db.kind === "sqlite") {
    return db.db
      .select()
      .from(db.schema.pairwiseComparisons)
      .where(where)
      .orderBy(desc(db.schema.pairwiseComparisons.createdAt), asc(db.schema.pairwiseComparisons.questionIndex))
      .all() as Row[];
  }
  return (await db.db
    .select()
    .from(db.schema.pairwiseComparisons)
    .where(where)
    .orderBy(desc(db.schema.pairwiseComparisons.createdAt), asc(db.schema.pairwiseComparisons.questionIndex))) as Row[];
}

export async function getPairwiseBatch(db: Db, batchId: string): Promise<PairwiseBatch | null> {
  const rows = await rowsFor(db, and(eq(db.schema.pairwiseComparisons.batchId, batchId), scope(db)));
  if (rows.length === 0) return null;
  const cases = rows.map(toCaseWire).sort((a, b) => (a.questionIndex ?? 0) - (b.questionIndex ?? 0));
  const first = rows[0]!;
  const bothOrders = first.bothOrders;
  return {
    batchId,
    runAId: first.runAId,
    runBId: first.runBId,
    bothOrders,
    judgeModel: first.judgeModel ?? DEFAULT_JUDGE_MODEL,
    summary: summarize(cases, bothOrders),
    cases,
    createdAt: first.createdAt.toISOString(),
    skipped: [],
  };
}

export type PairwiseBatchSummaryWire = {
  batchId: string;
  runAId: string;
  runBId: string;
  judgeModel: string | null;
  summary: PairwiseSummary;
  createdAt: string;
};

// Batches for one pair of runs (or every batch when no pair is given), newest first.
export async function listPairwiseBatches(
  db: Db,
  filter: { runAId?: string; runBId?: string } = {},
): Promise<PairwiseBatchSummaryWire[]> {
  const conditions = [scope(db)];
  if (filter.runAId) conditions.push(eq(db.schema.pairwiseComparisons.runAId, filter.runAId));
  if (filter.runBId) conditions.push(eq(db.schema.pairwiseComparisons.runBId, filter.runBId));
  const rows = await rowsFor(db, and(...conditions));

  const byBatch = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byBatch.get(row.batchId) ?? [];
    list.push(row);
    byBatch.set(row.batchId, list);
  }
  return [...byBatch.entries()].map(([batchId, batchRows]) => {
    const cases = batchRows.map(toCaseWire);
    const bothOrders = batchRows[0]!.bothOrders;
    return {
      batchId,
      runAId: batchRows[0]!.runAId,
      runBId: batchRows[0]!.runBId,
      judgeModel: batchRows[0]!.judgeModel,
      summary: summarize(cases, bothOrders),
      createdAt: batchRows[0]!.createdAt.toISOString(),
    };
  });
}
