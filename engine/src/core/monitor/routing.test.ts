import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesAgentScope, passesSampleRate } from "./routing.js";

// Deterministic Math.random (mulberry32) so sampling assertions can't flake.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampledOutOf(n: number, rate: number, seed = 42): number {
  const spy = vi.spyOn(Math, "random").mockImplementation(seededRandom(seed));
  try {
    let passed = 0;
    for (let i = 0; i < n; i++) {
      if (passesSampleRate(rate)) passed++;
    }
    return passed;
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("passesSampleRate", () => {
  it("always passes at 1, without consulting the RNG", () => {
    const spy = vi.spyOn(Math, "random");
    for (let i = 0; i < 50; i++) {
      expect(passesSampleRate(1)).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("never passes at 0", () => {
    expect(sampledOutOf(200, 0)).toBe(0);
  });

  it("samples roughly the configured fraction", () => {
    expect(sampledOutOf(1000, 0.5)).toBeGreaterThan(400);
    expect(sampledOutOf(1000, 0.5)).toBeLessThan(600);
    expect(sampledOutOf(1000, 0.1)).toBeGreaterThan(50);
    expect(sampledOutOf(1000, 0.1)).toBeLessThan(160);
  });

  // No route validates sampleRate, so these are the semantics a bad stored value actually gets.
  it("treats out-of-range values as always/never rather than throwing", () => {
    expect(passesSampleRate(2)).toBe(true);
    expect(sampledOutOf(50, -1)).toBe(0);
  });

  it("never samples on NaN", () => {
    expect(sampledOutOf(50, Number.NaN)).toBe(0);
  });
});

describe("matchesAgentScope", () => {
  it("matches every agent, and agent-less traces, when scoped to all", () => {
    expect(matchesAgentScope({ scopeMode: "all", agentIds: [] }, "agent-1")).toBe(true);
    expect(matchesAgentScope({ scopeMode: "all", agentIds: ["agent-2"] }, "agent-1")).toBe(true);
    expect(matchesAgentScope({ scopeMode: "all", agentIds: null }, null)).toBe(true);
  });

  it("matches only the listed agents when scoped to selected", () => {
    const row = { scopeMode: "selected", agentIds: ["agent-1", "agent-2"] };
    expect(matchesAgentScope(row, "agent-1")).toBe(true);
    expect(matchesAgentScope(row, "agent-3")).toBe(false);
    expect(matchesAgentScope(row, null)).toBe(false);
    expect(matchesAgentScope({ scopeMode: "selected", agentIds: null }, "agent-1")).toBe(false);
  });

  // The dashboard writes "selected" (an earlier version of this check compared "specific" and
  // silently no-op'd scoping); anything unrecognized fails open rather than stopping monitoring.
  it("fails open on an unrecognized scopeMode", () => {
    expect(matchesAgentScope({ scopeMode: "specific", agentIds: ["agent-2"] }, "agent-1")).toBe(true);
    expect(matchesAgentScope({ scopeMode: "", agentIds: ["agent-2"] }, "agent-1")).toBe(true);
  });
});
