import { describe, expect, it } from "vitest";
import { computeBleuScore, computeJaccardSimilarity, computeRougeScore } from "./index.js";

// The three text-similarity metrics are the only scoring an eval run can do with no LLM key at
// all (see engine/src/core/evaluate/runs.ts's computeSimilarityScores), so a wrong number here is
// a wrong number on someone's eval report with nothing else to cross-check it against.

describe("computeJaccardSimilarity", () => {
  it("returns null when either side is missing or blank", () => {
    expect(computeJaccardSimilarity(null, "hello")).toBeNull();
    expect(computeJaccardSimilarity("hello", undefined)).toBeNull();
    expect(computeJaccardSimilarity("   ", "hello")).toBeNull();
    expect(computeJaccardSimilarity("hello", "\n\t ")).toBeNull();
  });

  it("scores identical text as 1 and disjoint text as 0", () => {
    expect(computeJaccardSimilarity("the quick brown fox", "the quick brown fox")).toBe(1);
    expect(computeJaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(computeJaccardSimilarity("Hello, World!", "hello world")).toBe(1);
  });

  it("computes |A n B| / |A u B| over the token sets", () => {
    // A = {a,b,c}, B = {b,c,d} -> 2/4
    expect(computeJaccardSimilarity("a b c", "b c d")).toBeCloseTo(0.5, 10);
  });

  it("ignores duplicate tokens (set semantics)", () => {
    expect(computeJaccardSimilarity("a a a b", "a b b b")).toBe(1);
  });

  it("returns null when both sides tokenize to nothing", () => {
    expect(computeJaccardSimilarity("!!!", "???")).toBeNull();
  });

  it("returns 0 when only one side tokenizes to nothing", () => {
    expect(computeJaccardSimilarity("!!!", "hello")).toBe(0);
  });

  it("never returns a value outside [0, 1]", () => {
    const pairs: [string, string][] = [
      ["a", "a b c d e f g"],
      ["a b c d e f g", "a"],
      ["émoji ünicode 数字", "émoji ünicode"],
    ];
    for (const [expected, actual] of pairs) {
      const score = computeJaccardSimilarity(expected, actual)!;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("computeBleuScore", () => {
  it("returns null when either side is missing or blank", () => {
    expect(computeBleuScore(null, "hello")).toBeNull();
    expect(computeBleuScore("hello", "")).toBeNull();
  });

  it("returns null when a side has no tokens at all", () => {
    expect(computeBleuScore("!!!", "hello world")).toBeNull();
    expect(computeBleuScore("hello world", "???")).toBeNull();
  });

  it("scores an exact match as 1", () => {
    expect(computeBleuScore("the quick brown fox jumps", "the quick brown fox jumps")).toBeCloseTo(1, 10);
  });

  it("scores a response sharing no words with the reference as 0", () => {
    expect(computeBleuScore("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("applies a brevity penalty to a too-short candidate", () => {
    const short = computeBleuScore("the quick brown fox jumps over the lazy dog", "the quick brown fox")!;
    const full = computeBleuScore("the quick brown fox jumps over the lazy dog", "the quick brown fox jumps over the lazy dog")!;
    expect(short).toBeLessThan(full);
    expect(short).toBeGreaterThan(0);
  });

  it("does not penalise a candidate longer than the reference with a brevity penalty", () => {
    // BP is 1 whenever the candidate is at least as long as the reference; the only thing that
    // should pull this below 1 is n-gram precision.
    const score = computeBleuScore("the quick brown fox", "the quick brown fox and more words here")!;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("stays within [0, 1] for single-token inputs", () => {
    const score = computeBleuScore("hello", "hello")!;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeCloseTo(1, 10);
  });

  it("clips repeated candidate n-grams to the reference count", () => {
    // Classic BLEU failure case: a candidate of nothing but a repeated reference word must not
    // score 1 on unigram precision.
    const score = computeBleuScore("the cat sat on the mat", "the the the the the the")!;
    expect(score).toBeLessThan(0.6);
  });
});

describe("computeRougeScore", () => {
  it("returns null when either side is missing or blank", () => {
    expect(computeRougeScore(undefined, "hello")).toBeNull();
    expect(computeRougeScore("hello", "  ")).toBeNull();
  });

  it("returns null when a side has no tokens at all", () => {
    expect(computeRougeScore("###", "hello")).toBeNull();
  });

  it("scores an exact match as 1", () => {
    expect(computeRougeScore("the quick brown fox", "the quick brown fox")).toBeCloseTo(1, 10);
  });

  it("scores disjoint text as 0", () => {
    expect(computeRougeScore("alpha beta", "gamma delta")).toBe(0);
  });

  it("is order-sensitive (longest COMMON SUBSEQUENCE, not bag of words)", () => {
    const inOrder = computeRougeScore("a b c d", "a b c d")!;
    const reversed = computeRougeScore("a b c d", "d c b a")!;
    expect(reversed).toBeLessThan(inOrder);
  });

  it("computes the F1 of LCS precision and recall", () => {
    // reference = 4 tokens, candidate = 2 tokens, LCS = 2 -> P=1, R=0.5, F1=2/3
    expect(computeRougeScore("a b c d", "a b")).toBeCloseTo(2 / 3, 10);
  });

  it("is symmetric in its F1 (swapping the two sides gives the same score)", () => {
    const forward = computeRougeScore("a b c d", "a b")!;
    const backward = computeRougeScore("a b", "a b c d")!;
    expect(forward).toBeCloseTo(backward, 10);
  });

  it("handles long inputs without blowing the stack or timing out", () => {
    const long = Array.from({ length: 600 }, (_, i) => `token${i % 97}`).join(" ");
    const score = computeRougeScore(long, long)!;
    expect(score).toBeCloseTo(1, 10);
  });
});
