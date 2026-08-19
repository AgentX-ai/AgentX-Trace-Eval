// Nanosecond epoch timestamps arrive as strings (they exceed JS safe-integer precision), from both
// OTLP and the SDK. Both readers used to hand the raw value to BigInt(), which THROWS on anything
// that isn't a decimal integer - "1.7e18", "", prose - inside an async Express handler, where that
// became an unhandled rejection and Node exited. One tolerant reader for both paths.

const MAX_NANOS_IN_DATE_RANGE = 8_640_000_000_000_000n * 1_000_000n;

// Exactly what BigInt() accepts, checked up front instead of caught afterwards.
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * Parses a wire nanosecond timestamp to a bigint, or null if it isn't a decimal integer.
 * Accepts the string form OTLP/JSON uses and the number form some producers send anyway.
 */
export function parseUnixNanos(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!DECIMAL_INTEGER.test(trimmed)) {
    return null;
  }
  return BigInt(trimmed);
}

/** Same as parseUnixNanos, but for callers that want a plain 0n rather than a null. */
export function parseUnixNanosOrZero(value: unknown): bigint {
  return parseUnixNanos(value) ?? 0n;
}

/** To a Date, or null if unparseable or outside the range a Date can hold - an Invalid Date is
 *  what every driver rejects at bind time, which was the second throw on this path. */
export function unixNanosToDate(value: unknown): Date | null {
  const nanos = parseUnixNanos(value);
  if (nanos === null || nanos > MAX_NANOS_IN_DATE_RANGE || nanos < -MAX_NANOS_IN_DATE_RANGE) {
    return null;
  }
  const date = new Date(Number(nanos / 1_000_000n));
  return Number.isNaN(date.getTime()) ? null : date;
}
