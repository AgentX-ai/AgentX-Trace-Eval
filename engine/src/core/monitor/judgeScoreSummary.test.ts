import { describe, expect, it } from "vitest";
import { summarizeJudgeVerdicts, type TraceJudgeVerdict } from "./events.js";

const v = (scorerName: string, rating: number, threshold: number | null): TraceJudgeVerdict => ({
  scorerName,
  rating,
  threshold,
  failing: threshold !== null && rating < threshold,
});

describe("summarizeJudgeVerdicts", () => {
  it("a failure always outranks a lower-rated pass (threshold-aware, not raw minimum)", () => {
    // Style judge: 4.0 but its bar is 3 - a PASS. Safety judge: 6.0 under a bar of 7 - a FAIL.
    const summary = summarizeJudgeVerdicts([v("Style", 4, 3), v("Safety", 6, 7)]);
    expect(summary.scorerName).toBe("Safety");
    expect(summary.rating).toBe(6);
    expect(summary.failingCount).toBe(1);
    expect(summary.judgeCount).toBe(2);
  });

  it("among failures, the worst margin below its own bar wins", () => {
    // A: 1 below its bar; B: 4 below its bar - B is the deeper failure despite the higher rating.
    const summary = summarizeJudgeVerdicts([v("A", 4, 5), v("B", 5, 9)]);
    expect(summary.scorerName).toBe("B");
  });

  it("with no failures, the lowest passing score is the chip", () => {
    const summary = summarizeJudgeVerdicts([v("A", 9, 5), v("B", 6, 5), v("C", 8, null)]);
    expect(summary.scorerName).toBe("B");
    expect(summary.failingCount).toBe(0);
  });

  it("a scorer with alerting disabled (null threshold) can never register as failing", () => {
    const summary = summarizeJudgeVerdicts([v("NoAlert", 0.5, null), v("Strict", 6, 7)]);
    expect(summary.scorerName).toBe("Strict");
    expect(summary.failingCount).toBe(1);
  });
});
