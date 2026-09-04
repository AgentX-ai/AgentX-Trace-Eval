import { describe, expect, it } from "vitest";
import { alphaBand, krippendorffAlpha, MIN_ALPHA_ITEMS } from "./agreement.js";

describe("krippendorffAlpha", () => {
  it("scores perfect agreement as 1", () => {
    expect(krippendorffAlpha({ bothBad: 8, bothFine: 12, judgeOnlyBad: 0, humanOnlyBad: 0 })).toBe(1);
  });

  it("scores a rubber-stamp judge near 0 despite high raw agreement", () => {
    // Judge passes everything; humans found 10 of 100 bad. Raw agreement is 90% -
    // the exact illusion this statistic exists to break.
    const alpha = krippendorffAlpha({ bothBad: 0, bothFine: 90, judgeOnlyBad: 0, humanOnlyBad: 10 });
    expect(alpha).not.toBeNull();
    expect(Math.abs(alpha!)).toBeLessThan(0.1);
  });

  it("scores statistically independent raters near 0", () => {
    const alpha = krippendorffAlpha({ bothBad: 25, bothFine: 25, judgeOnlyBad: 25, humanOnlyBad: 25 });
    expect(alpha).not.toBeNull();
    expect(Math.abs(alpha!)).toBeLessThan(0.05);
  });

  it("goes negative for a judge systematically opposed to the humans", () => {
    const alpha = krippendorffAlpha({ bothBad: 2, bothFine: 2, judgeOnlyBad: 48, humanOnlyBad: 48 });
    expect(alpha).not.toBeNull();
    expect(alpha!).toBeLessThan(-0.5);
  });

  it("rewards real detection on the same imbalanced mix the rubber stamp failed", () => {
    // Same 90/10 label mix, but the judge actually catches 8 of the 10 bad ones.
    const alpha = krippendorffAlpha({ bothBad: 8, bothFine: 88, judgeOnlyBad: 2, humanOnlyBad: 2 });
    expect(alpha!).toBeGreaterThan(0.7);
  });

  it("withholds the number below the sample floor instead of fabricating one", () => {
    expect(krippendorffAlpha({ bothBad: 3, bothFine: 3, judgeOnlyBad: 0, humanOnlyBad: 0 })).toBeNull();
    // ...and produces one exactly at the floor.
    expect(
      krippendorffAlpha({ bothBad: MIN_ALPHA_ITEMS - 1, bothFine: 0, judgeOnlyBad: 1, humanOnlyBad: 0 })
    ).not.toBeNull();
  });

  it("is undefined (null) when every label on both sides is identical", () => {
    expect(krippendorffAlpha({ bothBad: 0, bothFine: 40, judgeOnlyBad: 0, humanOnlyBad: 0 })).toBeNull();
    expect(krippendorffAlpha({ bothBad: 40, bothFine: 0, judgeOnlyBad: 0, humanOnlyBad: 0 })).toBeNull();
  });
});

describe("alphaBand", () => {
  it("maps the Landis-Koch-style bands", () => {
    expect(alphaBand(-0.2)).toBe("poor");
    expect(alphaBand(0.1)).toBe("slight");
    expect(alphaBand(0.3)).toBe("fair");
    expect(alphaBand(0.5)).toBe("moderate");
    expect(alphaBand(0.7)).toBe("substantial");
    expect(alphaBand(0.95)).toBe("near-perfect");
  });
});
