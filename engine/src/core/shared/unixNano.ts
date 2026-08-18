// Nanosecond epoch timestamps arrive as strings on every path that carries them - OTLP's proto3
// JSON mapping encodes uint64 as a string, and the Python SDK matches that shape for consistency
// (see core/trace/ingest.ts's ingestTraceSchema) - because they exceed JS safe-integer precision.
//
// Both readers used to hand the raw value straight to BigInt(), which THROWS on anything that
// isn't a decimal integer literal: "1.7e18" from a producer that round-tripped the value through
// a float, "" from a client that sends empty strings for absent fields, or plain prose. That
// throw happened inside an async Express handler, where Express 4 turns it into an unhandled
// rejection and Node exits - one malformed span from one client took the whole engine down. This
// module is the single tolerant reader both paths now use.

const MAX_NANOS_IN_DATE_RANGE = 8_640_000_000_000_000n * 1_000_000n;

// Decimal digits only, with an optional sign: exactly what BigInt() accepts without throwing,
// checked up front instead of caught afterwards.
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

/**
 * Converts a wire nanosecond timestamp to a Date, or null if it isn't parseable or lands outside
 * the range a JS Date can represent. A Date built from an out-of-range value is an Invalid Date,
 * which every driver rejects at bind time (another throw on the ingest path) and which no query
 * would match anyway.
 */
export function unixNanosToDate(value: unknown): Date | null {
  const nanos = parseUnixNanos(value);
  if (nanos === null || nanos > MAX_NANOS_IN_DATE_RANGE || nanos < -MAX_NANOS_IN_DATE_RANGE) {
    return null;
  }
  const date = new Date(Number(nanos / 1_000_000n));
  return Number.isNaN(date.getTime()) ? null : date;
}
