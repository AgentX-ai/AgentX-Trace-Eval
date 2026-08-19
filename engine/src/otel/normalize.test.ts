import { describe, expect, it } from "vitest";
import { normalizeExportRequest } from "./normalize.js";

// normalizeExportRequest is the very first thing that touches a byte an OTel exporter put on the
// wire (routes/otlp.ts's POST /v1/traces). Anything it throws on is a request the engine can't
// answer, so the "garbage in" cases matter as much as the happy path.

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

function wrap(span: Record<string, unknown>, extra: { resource?: unknown; scope?: unknown } = {}) {
  return {
    resourceSpans: [
      {
        resource: extra.resource ?? { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeSpans: [{ scope: extra.scope ?? { name: "openinference.langchain" }, spans: [span] }],
      },
    ],
  };
}

describe("normalizeExportRequest", () => {
  it("returns an empty list for a body with no resourceSpans", () => {
    expect(normalizeExportRequest({})).toEqual([]);
    expect(normalizeExportRequest({ resourceSpans: [] })).toEqual([]);
  });

  it("renders trace/span ids as hex", () => {
    const [span] = normalizeExportRequest(
      wrap({
        traceId: b64("0123456789abcdef0123456789abcdef"),
        spanId: b64("0123456789abcdef"),
        parentSpanId: b64("fedcba9876543210"),
        name: "chat",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000001500000000",
      })
    );
    expect(span!.traceIdHex).toBe("0123456789abcdef0123456789abcdef");
    expect(span!.spanIdHex).toBe("0123456789abcdef");
    expect(span!.parentSpanIdHex).toBe("fedcba9876543210");
    expect(span!.endTimeUnixNano - span!.startTimeUnixNano).toBe(1_500_000_000n);
  });

  it("accepts snake_case field names as well as lowerCamelCase", () => {
    const [span] = normalizeExportRequest({
      resource_spans: [
        {
          resource: { attributes: [] },
          scope_spans: [
            {
              scope: { name: "s" },
              spans: [{ name: "n", trace_id: b64("aa"), span_id: b64("bb"), start_time_unix_nano: "5", end_time_unix_nano: "9" }],
            },
          ],
        },
      ],
    });
    expect(span!.traceIdHex).toBe("aa");
    expect(span!.startTimeUnixNano).toBe(5n);
  });

  it("normalizes both numeric and string status codes", () => {
    const codes: [unknown, string][] = [
      [2, "STATUS_CODE_ERROR"],
      ["2", "STATUS_CODE_ERROR"],
      ["STATUS_CODE_ERROR", "STATUS_CODE_ERROR"],
      [1, "STATUS_CODE_OK"],
      [0, "STATUS_CODE_UNSET"],
      [undefined, "STATUS_CODE_UNSET"],
    ];
    for (const [code, expected] of codes) {
      const [span] = normalizeExportRequest(wrap({ name: "n", status: { code } }));
      expect(span!.statusCode).toBe(expected);
    }
  });

  it("falls back to a placeholder name and zero timestamps when the span omits them", () => {
    const [span] = normalizeExportRequest(wrap({}));
    expect(span!.name).toBe("unknown");
    expect(span!.startTimeUnixNano).toBe(0n);
    expect(span!.endTimeUnixNano).toBe(0n);
  });

  // --- malformed-wire cases: these must not throw, the caller has no try/catch around them ---

  it("does not throw on a non-numeric timestamp string", () => {
    expect(() => normalizeExportRequest(wrap({ name: "n", startTimeUnixNano: "not-a-number" }))).not.toThrow();
  });

  it("does not throw on an exponential-notation timestamp", () => {
    // JSON producers that round-trip the uint64 through a JS number and back can emit this.
    expect(() => normalizeExportRequest(wrap({ name: "n", startTimeUnixNano: "1.7e18" }))).not.toThrow();
  });

  it("does not throw on a fractional numeric timestamp", () => {
    expect(() => normalizeExportRequest(wrap({ name: "n", endTimeUnixNano: 1700000000000.5 }))).not.toThrow();
  });

  it("does not throw when a timestamp is null", () => {
    expect(() => normalizeExportRequest(wrap({ name: "n", startTimeUnixNano: null, endTimeUnixNano: null }))).not.toThrow();
  });

  it("does not throw when resourceSpans/scopeSpans/spans are the wrong type", () => {
    expect(() => normalizeExportRequest({ resourceSpans: "nope" })).not.toThrow();
    expect(() => normalizeExportRequest({ resourceSpans: [{ scopeSpans: "nope" }] })).not.toThrow();
    expect(() => normalizeExportRequest({ resourceSpans: [{ scopeSpans: [{ spans: "nope" }] }] })).not.toThrow();
  });

  it("does not throw when a span entry is null", () => {
    expect(() => normalizeExportRequest({ resourceSpans: [{ scopeSpans: [{ spans: [null] }] }] })).not.toThrow();
  });
});
