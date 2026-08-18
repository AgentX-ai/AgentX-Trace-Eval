import { describe, expect, it } from "vitest";
import {
  buildSourceTexts,
  evaluatePatternConditions,
  heuristicSemanticJudge,
  textForSources,
  type PatternCondition,
  type SemanticJudge,
} from "./conditions.js";

// Custom monitor patterns are what an operator writes in the dashboard to say "raise a signal
// when the agent does X". Getting the boolean combination wrong doesn't error - it just silently
// raises the wrong signals, or none, which is the failure mode nobody notices.

const never: SemanticJudge = async () => ({ matched: false });

function condition(overrides: Partial<PatternCondition> = {}): PatternCondition {
  return {
    connector: "and",
    negate: false,
    sources: ["response"],
    detector: "phrase",
    value: "refund",
    caseSensitive: false,
    ...overrides,
  };
}

const run = (conditions: PatternCondition[], responseText: string, judge: SemanticJudge = never) =>
  evaluatePatternConditions({ conditions, responseText, semanticJudge: judge });

describe("buildSourceTexts", () => {
  it("keeps the three sources separate", () => {
    const texts = buildSourceTexts({
      responseText: "the response",
      trace: { input: "the question", output: "the response", error: null, toolCalls: null },
    });
    expect(texts.response).toBe("the response");
    expect(texts.userMessage).toBe("the question");
    expect(texts.trace).toBe("the response");
  });

  it("serialises non-string input/output rather than dropping them", () => {
    const texts = buildSourceTexts({ trace: { input: { q: "hi" }, output: [1, 2] } });
    expect(texts.userMessage).toBe('{"q":"hi"}');
    expect(texts.trace).toBe("[1,2]");
  });

  it("folds tool call names, inputs and outputs into the trace text", () => {
    const texts = buildSourceTexts({
      trace: { output: "ok", error: "boom", toolCalls: [{ name: "lookup", input: { id: 1 }, output: "not found" }] },
    });
    expect(texts.trace).toContain("boom");
    expect(texts.trace).toContain("lookup");
    expect(texts.trace).toContain("not found");
    expect(texts.trace).toContain('{"id":1}');
  });

  it("renders null/undefined as empty rather than the strings 'null'/'undefined'", () => {
    const texts = buildSourceTexts({ trace: { input: null, output: undefined } });
    expect(texts.userMessage).toBe("");
    expect(texts.trace).toBe("");
  });
});

describe("textForSources", () => {
  const texts = { response: "R", userMessage: "U", trace: "T" };

  it("defaults to the response when the target list is missing or unrecognised", () => {
    expect(textForSources(undefined, texts)).toBe("R");
    expect(textForSources(["bogus"], texts)).toBe("R");
    expect(textForSources([], texts)).toBe("R");
  });

  it("concatenates the requested sources in a fixed order", () => {
    expect(textForSources(["trace", "response"], texts)).toBe("R\nT");
    expect(textForSources(["response", "userMessage", "trace"], texts)).toBe("R\nU\nT");
  });

  it("accepts a bare string target as well as a list", () => {
    expect(textForSources("userMessage", texts)).toBe("U");
  });

  it("de-duplicates repeated targets", () => {
    expect(textForSources(["response", "response"], texts)).toBe("R");
  });
});

describe("evaluatePatternConditions", () => {
  it("never matches with no conditions", async () => {
    expect(await run([], "anything")).toEqual({ overall: false, reasons: [] });
  });

  it("matches a phrase case-insensitively by default", async () => {
    expect((await run([condition()], "Full REFUND issued")).overall).toBe(true);
    expect((await run([condition({ caseSensitive: true })], "Full REFUND issued")).overall).toBe(false);
    expect((await run([condition({ caseSensitive: true, value: "REFUND" })], "Full REFUND issued")).overall).toBe(true);
  });

  it("matches a regex detector", async () => {
    const regex = condition({ detector: "regex", value: "refund(ed|ing)?" });
    expect((await run([regex], "we refunded you")).overall).toBe(true);
    expect((await run([regex], "nothing to see")).overall).toBe(false);
  });

  it("treats an invalid regex as a non-match instead of throwing", async () => {
    const broken = condition({ detector: "regex", value: "([unclosed" });
    await expect(run([broken], "anything")).resolves.toEqual({ overall: false, reasons: [] });
  });

  it("skips a catastrophically backtracking regex instead of pinning the thread", async () => {
    // A pattern stored before save-time validation existed. Without the guard this call does not
    // return in any practical amount of time, and nothing else on the process runs meanwhile.
    const redos = condition({ detector: "regex", value: `(${"a+"})+$` });
    const started = Date.now();
    const result = await run([redos], `${"a".repeat(400)}b`);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.overall).toBe(false);
  });

  it("does not match when the condition value or the text is blank", async () => {
    expect((await run([condition({ value: "   " })], "refund")).overall).toBe(false);
    expect((await run([condition()], "   ")).overall).toBe(false);
  });

  it("flips a single row with negate", async () => {
    expect((await run([condition({ negate: true })], "no mention here")).overall).toBe(true);
    expect((await run([condition({ negate: true })], "a refund")).overall).toBe(false);
  });

  it("combines rows with and / or / nor", async () => {
    const refund = condition({ value: "refund" });
    const sorry = (connector: PatternCondition["connector"]) => condition({ value: "sorry", connector });

    expect((await run([refund, sorry("and")], "refund, sorry")).overall).toBe(true);
    expect((await run([refund, sorry("and")], "refund only")).overall).toBe(false);
    expect((await run([refund, sorry("or")], "sorry only")).overall).toBe(true);
    expect((await run([refund, sorry("or")], "neither word")).overall).toBe(false);
    // nor = "and not"
    expect((await run([refund, sorry("nor")], "refund only")).overall).toBe(true);
    expect((await run([refund, sorry("nor")], "refund, sorry")).overall).toBe(false);
  });

  it("ignores the first row's connector (there is nothing to its left)", async () => {
    const first = condition({ connector: "nor", value: "refund" });
    expect((await run([first], "a refund")).overall).toBe(true);
  });

  it("combines left to right without operator precedence", async () => {
    // a OR b AND c reads as ((a OR b) AND c), not (a OR (b AND c)).
    const a = condition({ value: "alpha" });
    const b = condition({ value: "beta", connector: "or" });
    const c = condition({ value: "gamma", connector: "and" });
    expect((await run([a, b, c], "alpha gamma")).overall).toBe(true);
    expect((await run([a, b, c], "alpha beta")).overall).toBe(false);
  });

  it("surfaces the semantic judge's reason only for rows that contributed a match", async () => {
    const judge: SemanticJudge = async () => ({ matched: true, reason: "sounds evasive" });
    const semantic = condition({ detector: "semantic", value: "the agent dodged the question" });

    expect(await run([semantic], "well, it depends", judge)).toEqual({ overall: true, reasons: ["sounds evasive"] });
    // Negated away: the row matched, but its "yes" was flipped, so the reason would be misleading.
    expect((await run([condition({ ...semantic, negate: true })], "well, it depends", judge)).reasons).toEqual([]);
  });

  it("evaluates each row against its own source", async () => {
    const onQuestion = condition({ sources: ["userMessage"], value: "cancel" });
    const result = await evaluatePatternConditions({
      conditions: [onQuestion],
      responseText: "here is your refund",
      trace: { input: "I want to cancel", output: "here is your refund" },
      semanticJudge: never,
    });
    expect(result.overall).toBe(true);
  });
});

describe("heuristicSemanticJudge", () => {
  it("matches when at least half the rubric's significant words appear", async () => {
    expect(await heuristicSemanticJudge("agent refused to answer", "the agent refused")).toEqual({ matched: true });
    expect((await heuristicSemanticJudge("agent refused to answer", "completely unrelated")).matched).toBe(false);
  });

  it("never matches on a rubric with no significant words", async () => {
    expect(await heuristicSemanticJudge("a an of", "a an of")).toEqual({ matched: false });
  });
});
