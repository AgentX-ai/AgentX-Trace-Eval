import { describe, expect, it } from "vitest";
import { parseUnixNanos, parseUnixNanosOrZero, unixNanosToDate } from "./unixNano.js";

// Every value here reached BigInt() unguarded before, inside an async Express handler, where a
// throw is an unhandled rejection and Node exits the process. "Returns null" is not a nicety in
// this module - it is the difference between one dropped field and an engine-wide outage.

describe("parseUnixNanos", () => {
  it("parses the decimal-string form OTLP puts on the wire", () => {
    expect(parseUnixNanos("1700000000000000000")).toBe(1_700_000_000_000_000_000n);
    expect(parseUnixNanos("0")).toBe(0n);
    expect(parseUnixNanos(" 1700000000000000000 ")).toBe(1_700_000_000_000_000_000n);
  });

  it("keeps full precision past Number.MAX_SAFE_INTEGER", () => {
    const nanos = "1799999999999999999";
    expect(parseUnixNanos(nanos)?.toString()).toBe(nanos);
  });

  it("accepts a bigint or a safe-integer number, which some producers send", () => {
    expect(parseUnixNanos(1_700_000_000_000n)).toBe(1_700_000_000_000n);
    expect(parseUnixNanos(1_700_000_000_000)).toBe(1_700_000_000_000n);
  });

  it("returns null instead of throwing on anything that isn't a decimal integer", () => {
    for (const value of ["", "   ", "not-a-number", "1.7e18", "1.5", "0x10", "1_000", "NaN", "Infinity", "12abc"]) {
      expect(parseUnixNanos(value), value).toBeNull();
    }
  });

  it("returns null for a non-integer or unsafe number", () => {
    expect(parseUnixNanos(1.5)).toBeNull();
    expect(parseUnixNanos(NaN)).toBeNull();
    expect(parseUnixNanos(Infinity)).toBeNull();
    expect(parseUnixNanos(1e300)).toBeNull();
  });

  it("returns null for types that aren't numbers at all", () => {
    for (const value of [null, undefined, true, {}, [], () => 0]) {
      expect(parseUnixNanos(value)).toBeNull();
    }
  });

  it("parseUnixNanosOrZero substitutes 0n for every null case", () => {
    expect(parseUnixNanosOrZero("nonsense")).toBe(0n);
    expect(parseUnixNanosOrZero(undefined)).toBe(0n);
    expect(parseUnixNanosOrZero("42")).toBe(42n);
  });
});

describe("unixNanosToDate", () => {
  it("converts nanoseconds to a Date at millisecond resolution", () => {
    const date = unixNanosToDate("1700000000123456789")!;
    expect(date.toISOString()).toBe(new Date(1_700_000_000_123).toISOString());
  });

  it("returns null rather than an Invalid Date for unparseable input", () => {
    for (const value of ["yesterday", "1.7e18", "", null, undefined]) {
      expect(unixNanosToDate(value), String(value)).toBeNull();
    }
  });

  it("returns null for a timestamp outside the range a Date can represent", () => {
    // An Invalid Date is what every driver rejects at bind time - the second throw on this path.
    expect(unixNanosToDate("9".repeat(30))).toBeNull();
    expect(unixNanosToDate(`-${"9".repeat(30)}`)).toBeNull();
  });

  it("accepts the extremes of the representable range", () => {
    const maxMillis = 8_640_000_000_000_000;
    expect(unixNanosToDate(String(BigInt(maxMillis) * 1_000_000n))?.getTime()).toBe(maxMillis);
    expect(unixNanosToDate(String(BigInt(-maxMillis) * 1_000_000n))?.getTime()).toBe(-maxMillis);
  });

  it("handles the epoch itself", () => {
    expect(unixNanosToDate("0")?.getTime()).toBe(0);
  });
});
