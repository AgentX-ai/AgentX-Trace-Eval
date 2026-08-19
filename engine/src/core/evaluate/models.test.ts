import { describe, expect, it } from "vitest";
import { estimateCostUSD, normalizeModelId, type PortabilityModel } from "./models.js";
import { maskSecret } from "../shared/maskSecret.js";

// estimateCostUSD is the only place a dollar figure is produced - Overview's cost chart, the
// per-trace cost column and Model Portability's comparison all funnel through it. A silent factor
// of 1000 here reads as a plausible number on every one of those surfaces.

function model(overrides: Partial<PortabilityModel> = {}): PortabilityModel {
  return {
    id: "gpt-4o-mini",
    provider: "openai",
    label: "GPT-4o mini",
    pricePerMInputTokens: 0.15,
    pricePerMOutputTokens: 0.6,
    pricePerMCacheReadTokens: null,
    pricePerMCacheWriteTokens: null,
    isDefault: false,
    baseUrl: null,
    apiKeyMasked: null,
    ...overrides,
  };
}

describe("estimateCostUSD", () => {
  it("prices per million tokens", () => {
    expect(estimateCostUSD(model(), 1_000_000, 1_000_000)).toBeCloseTo(0.75, 10);
    expect(estimateCostUSD(model(), 1_000, 500)).toBeCloseTo(0.00015 + 0.0003, 10);
  });

  it("returns null when there is no pricing or no token counts", () => {
    expect(estimateCostUSD(null, 100, 100)).toBeNull();
    expect(estimateCostUSD(model(), null, 100)).toBeNull();
    expect(estimateCostUSD(model(), 100, null)).toBeNull();
  });

  it("returns 0, not null, for a real trace that used no tokens", () => {
    expect(estimateCostUSD(model(), 0, 0)).toBe(0);
  });

  it("treats cache read/write tokens as a subset of input tokens, not extra", () => {
    // 1000 input of which 400 were cache reads: 600 charged at the input rate, 400 at the cache
    // rate - never 1400 tokens' worth.
    const priced = model({ pricePerMCacheReadTokens: 0.015 });
    const cost = estimateCostUSD(priced, 1_000, 0, 400)!;
    expect(cost).toBeCloseTo((600 / 1e6) * 0.15 + (400 / 1e6) * 0.015, 12);
    expect(cost).toBeLessThan(estimateCostUSD(model(), 1_000, 0)!);
  });

  it("falls back to the input rate when no cache rate is configured", () => {
    expect(estimateCostUSD(model(), 1_000, 0, 400, 100)).toBeCloseTo(estimateCostUSD(model(), 1_000, 0)!, 12);
  });

  it("never charges negative input when cache counts exceed the input total", () => {
    // A provider reporting cache tokens outside the input total (or an SDK double-counting them)
    // must not produce a credit.
    const cost = estimateCostUSD(model({ pricePerMCacheReadTokens: 0.015 }), 100, 0, 900)!;
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe("normalizeModelId", () => {
  it("strips a trailing dated snapshot suffix", () => {
    expect(normalizeModelId("gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
    expect(normalizeModelId("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
  });

  it("leaves an id with no snapshot suffix alone", () => {
    expect(normalizeModelId("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModelId("claude-3-5-sonnet-latest")).toBe("claude-3-5-sonnet-latest");
  });

  it("does not strip version numbers that aren't dates", () => {
    expect(normalizeModelId("llama-3-70b")).toBe("llama-3-70b");
    expect(normalizeModelId("gpt-4o-mini-2024")).toBe("gpt-4o-mini-2024");
  });

  it("only strips the suffix at the end", () => {
    expect(normalizeModelId("gpt-4o-2024-07-18-preview")).toBe("gpt-4o-2024-07-18-preview");
  });
});

describe("maskSecret", () => {
  it("shows a prefix and suffix for a real key", () => {
    expect(maskSecret("sk-proj-abcdefghijklmnop")).toBe("sk-...mnop");
  });

  it("reveals nothing at all for a short key", () => {
    expect(maskSecret("12345678")).toBe("••••");
    expect(maskSecret("")).toBe("••••");
  });

  it("never returns the original key", () => {
    for (const key of ["sk-1234567890", "a".repeat(64), "sk-proj-" + "z".repeat(100)]) {
      expect(maskSecret(key)).not.toBe(key);
      expect(maskSecret(key).length).toBeLessThan(key.length);
    }
  });
});
