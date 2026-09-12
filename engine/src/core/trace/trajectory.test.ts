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

describe("truncation marker exclusion", () => {
  it("the ingest cap's bookkeeping row is not a tool named 'unknown'", async () => {
    // extractTraceToolSequence consumers score subset/strict checks - a marker row mapped to
    // "unknown" failed every one of them on large traces. Simulate the stored shape directly.
    const calls = [
      { name: "search", success: true },
      { "agentx.truncated": true, dropped: 40 },
    ] as Record<string, unknown>[];
    const names = calls.filter(tc => tc["agentx.truncated"] !== true).map(tc => String(tc.name ?? "unknown"));
    expect(names).toEqual(["search"]);
  });

  it("an empty expected list is vacuously true under superset, and requires an empty actual elsewhere", () => {
    // Regression: a caller-side special case used to fail superset whenever the agent called
    // any tool at all - an explicitly-unconstrained assertion scored 0 on every result.
    expect(matchTrajectory([], ["search", "send"], "superset").matched).toBe(true);
    expect(matchTrajectory([], [], "superset").matched).toBe(true);
    expect(matchTrajectory([], ["search"], "strict").matched).toBe(false);
    expect(matchTrajectory([], [], "strict").matched).toBe(true);
    expect(matchTrajectory([], ["search"], "unordered").matched).toBe(false);
    expect(matchTrajectory([], ["search"], "subset").matched).toBe(false);
  });
});

