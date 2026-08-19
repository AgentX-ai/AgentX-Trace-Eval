import { describe, expect, it } from "vitest";
import { matchTrajectory } from "./trajectory.js";

describe("matchTrajectory", () => {
  it("scores a name the same whichever side carries the stray whitespace", () => {
    // Trimming only `expected` made these two disagree about an identical pair of names.
    expect(matchTrajectory([" search"], ["search"], "strict").matched).toBe(true);
    expect(matchTrajectory(["search"], [" search"], "strict").matched).toBe(true);
  });

  it("ignores empty entries on either side", () => {
    expect(matchTrajectory(["search", ""], ["search"], "strict").matched).toBe(true);
    expect(matchTrajectory(["search"], ["search", "  "], "strict").matched).toBe(true);
  });

  it("strict wants the same calls in the same order", () => {
    expect(matchTrajectory(["a", "b"], ["a", "b"], "strict").matched).toBe(true);
    expect(matchTrajectory(["a", "b"], ["b", "a"], "strict").matched).toBe(false);
    expect(matchTrajectory(["a", "b"], ["a"], "strict").matched).toBe(false);
  });

  it("unordered wants the same multiset, order free", () => {
    expect(matchTrajectory(["a", "b"], ["b", "a"], "unordered").matched).toBe(true);
    // counts matter, not just the distinct set
    expect(matchTrajectory(["a", "a"], ["a"], "unordered").matched).toBe(false);
    expect(matchTrajectory(["a"], ["a", "b"], "unordered").matched).toBe(false);
  });

  it("superset allows extras but not omissions", () => {
    expect(matchTrajectory(["a"], ["a", "b"], "superset").matched).toBe(true);
    expect(matchTrajectory(["a", "a"], ["a"], "superset").matched).toBe(false);
  });

  it("subset allows omissions but not unexpected calls", () => {
    expect(matchTrajectory(["a", "b"], ["a"], "subset").matched).toBe(true);
    expect(matchTrajectory(["a"], ["a", "b"], "subset").matched).toBe(false);
    expect(matchTrajectory([], [], "subset").matched).toBe(true);
  });

  it("reports what it actually compared", () => {
    const { reasoning } = matchTrajectory([" search "], ["search"], "strict");
    expect(reasoning).toContain("expected [search]");
    expect(reasoning).toContain("actual [search]");
  });

  it("says so when the trace made no tool calls", () => {
    expect(matchTrajectory(["a"], [], "strict").reasoning).toContain("no tool calls");
  });
});
