import { describe, expect, it } from "vitest";
import { isValidSampleRate, validateSampleRateParam } from "./sampleRate.js";
import { isValidSeverity, validateSeverityParam, VALID_SEVERITIES } from "./severity.js";

// Both of these guard a field where a bad value does not error - it silently changes behaviour.
// A rejected severity produces signals the dashboard's chips cannot render; a rejected sample
// rate produces a check that reports itself enabled and never runs.

describe("isValidSampleRate", () => {
  it("accepts the whole legal range", () => {
    for (const value of [0, 0.1, 0.5, 0.999, 1]) {
      expect(isValidSampleRate(value), String(value)).toBe(true);
    }
  });

  it("rejects values outside 0..1", () => {
    for (const value of [-0.0001, -1, 1.0001, 42, 100]) {
      expect(isValidSampleRate(value), String(value)).toBe(false);
    }
  });

  it("rejects non-finite numbers", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(isValidSampleRate(value), String(value)).toBe(false);
    }
  });

  it("rejects anything that isn't a number, including numeric strings", () => {
    // "0.5" would pass a `<= 1` comparison through coercion but breaks Math.random() < rate.
    for (const value of ["0.5", "half", null, undefined, true, {}, []]) {
      expect(isValidSampleRate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("validateSampleRateParam", () => {
  it("lets an omitted value through so the core layer's default applies", () => {
    expect(validateSampleRateParam(undefined)).toEqual({ ok: true, sampleRate: undefined });
  });

  it("passes a valid value through unchanged", () => {
    expect(validateSampleRateParam(0.25)).toEqual({ ok: true, sampleRate: 0.25 });
    expect(validateSampleRateParam(0)).toEqual({ ok: true, sampleRate: 0 });
  });

  it("returns an actionable message for an invalid one", () => {
    const result = validateSampleRateParam("half");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/between 0 and 1/);
  });

  it("rejects null rather than treating it as omitted", () => {
    // JSON has no undefined, so a client clearing the field sends null - which would otherwise be
    // stored and read as "never run".
    expect(validateSampleRateParam(null).ok).toBe(false);
  });
});

describe("severity validation", () => {
  it("accepts exactly the four the dashboard can render", () => {
    for (const severity of VALID_SEVERITIES) {
      expect(isValidSeverity(severity)).toBe(true);
    }
    expect(VALID_SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });

  it("rejects anything else, including case variants", () => {
    for (const value of ["catastrophic", "High", "", null, 3, undefined]) {
      expect(isValidSeverity(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("lets an omitted severity through and names the legal set on rejection", () => {
    expect(validateSeverityParam(undefined)).toEqual({ ok: true, severity: undefined });
    const result = validateSeverityParam("nope");
    expect(result.ok === false && result.error).toContain("low, medium, high, critical");
  });
});
