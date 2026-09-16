import { describe, expect, it } from "vitest";
import { computeStatistics } from "../core/evaluate/analysis.js";
import type { RunResultRow } from "../core/evaluate/runs.js";

// The report's statistics must describe the same population as getRun's averageRating: rated
// rows, smoke-test variants excluded. Before this was pinned, the report counted variants while
// every other aggregate dropped them, so the two averages disagreed on any run with variants.
const row = (rating: number | null, isSmokeTestVariant = false): RunResultRow =>
  ({ rating, isSmokeTestVariant } as unknown as RunResultRow);

describe("computeStatistics", () => {
  it("excludes smoke-test variants and unrated rows", () => {
    const stats = computeStatistics([row(8), row(6), row(null), row(1, true), row(10, true)]);
    expect(stats.numberOfRuns).toBe(2);
    expect(stats.averageRating).toBe(7);
    expect(stats.minRating).toBe(6);
    expect(stats.maxRating).toBe(8);
    expect(stats.ratingVariance).toBe(1);
  });

  it("reports zeros, not NaN, when nothing is rated", () => {
    expect(computeStatistics([row(null), row(9, true)])).toEqual({ numberOfRuns: 0, averageRating: 0, minRating: 0, maxRating: 0, ratingVariance: 0 });
  });
});
