import { describe, expect, it } from "vitest";
import { summarize, toSide, type PairwiseCaseWire } from "./pairwise.js";

// The two pieces of pairwise judging that are pure logic and would be silently wrong forever if
// they inverted: mapping a positional verdict back to a run, and turning per-case winners into a
// batch verdict.

const kase = (over: Partial<PairwiseCaseWire> = {}): PairwiseCaseWire => ({
  _id: "c",
  questionIndex: 0,
  query: "q",
  winner: "a",
  presentedFirst: "a",
  flipped: false,
  justification: null,
  judgeModel: "m",
  createdAt: new Date().toISOString(),
  ...over,
});

describe("toSide", () => {
  it("maps the winning position to the run that occupied it", () => {
    // A read first: answer_1 is A.
    expect(toSide("answer_1", true)).toBe("a");
    expect(toSide("answer_2", true)).toBe("b");
    // B read first: the same verdicts mean the opposite runs.
    expect(toSide("answer_1", false)).toBe("b");
    expect(toSide("answer_2", false)).toBe("a");
  });

  it("keeps a tie a tie in either order", () => {
    expect(toSide("tie", true)).toBe("tie");
    expect(toSide("tie", false)).toBe("tie");
  });
});

describe("summarize", () => {
  it("calls the batch for whichever run won more cases", () => {
    const summary = summarize([kase(), kase({ winner: "a" }), kase({ winner: "b" })], false);
    expect(summary).toMatchObject({
      total: 3,
      aWins: 2,
      bWins: 1,
      ties: 0,
      winner: "a",
    });
  });

  it("reports a tie rather than breaking a dead heat arbitrarily", () => {
    expect(summarize([kase({ winner: "a" }), kase({ winner: "b" })], false).winner).toBe("tie");
    // All ties is also a tie, not an "a" win by default.
    expect(summarize([kase({ winner: "tie" })], false).winner).toBe("tie");
  });

  it("has no flip rate to report unless both orders were judged", () => {
    expect(summarize([kase()], false).flipRate).toBeNull();
    expect(summarize([kase(), kase({ flipped: true, winner: "tie" })], true).flipRate).toBe(0.5);
  });

  it("counts a flipped pair as a tie, so position bias cannot win a comparison", () => {
    const summary = summarize([kase({ winner: "a" }), kase({ winner: "tie", flipped: true })], true);
    expect(summary.aWins).toBe(1);
    expect(summary.ties).toBe(1);
    expect(summary.flipRate).toBe(0.5);
  });

  it("is empty-safe", () => {
    expect(summarize([], true)).toMatchObject({
      total: 0,
      winner: "tie",
      flipRate: null,
    });
  });
});
