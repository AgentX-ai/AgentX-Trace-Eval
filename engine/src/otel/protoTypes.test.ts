import { describe, expect, it } from "vitest";
import {
  ExportTraceServiceRequestType,
  ExportTraceServiceResponseType,
  decodeProtobufExportRequest,
  encodeProtobufResponse,
} from "./protoTypes.js";
import { normalizeExportRequest } from "./normalize.js";
import { otelSpanToIngestInput } from "./mapping.js";

// Protobuf is the default OTLP transport, and the only one Python's
// opentelemetry-exporter-otlp-proto-http ships - so this is the wire format most real traffic
// arrives in. Decoding it produces a differently-shaped object than an OTLP/JSON body (protobufjs
// adds oneof discriminators, renders int64 as strings, bytes as base64), and normalize.ts claims
// to handle both with one code path. This round-trips a real encoded message to check that.

function encodeRequest(payload: Record<string, unknown>): Uint8Array {
  const err = ExportTraceServiceRequestType.verify(payload);
  if (err) {
    throw new Error(`test payload is not a valid ExportTraceServiceRequest: ${err}`);
  }
  return ExportTraceServiceRequestType.encode(ExportTraceServiceRequestType.fromObject(payload)).finish();
}

describe("OTLP protobuf decoding", () => {
  it("round-trips a realistic export through decode -> normalize -> map", () => {
    const buffer = encodeRequest({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
          scopeSpans: [
            {
              scope: { name: "opentelemetry.instrumentation.openai" },
              spans: [
                {
                  traceId: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
                  spanId: Buffer.from("0123456789abcdef", "hex"),
                  name: "chat gpt-4o-mini",
                  startTimeUnixNano: 1_700_000_000_000_000_000,
                  endTimeUnixNano: 1_700_000_002_000_000_000,
                  attributes: [
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: 120 } },
                    { key: "gen_ai.usage.output_tokens", value: { intValue: 35 } },
                    { key: "input.value", value: { stringValue: "where is my order?" } },
                    { key: "output.value", value: { stringValue: "shipped monday" } },
                  ],
                  status: { code: 2, message: "upstream timeout" },
                },
              ],
            },
          ],
        },
      ],
    });

    const spans = normalizeExportRequest(decodeProtobufExportRequest(buffer));
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.traceIdHex).toBe("0123456789abcdef0123456789abcdef");
    expect(span.spanIdHex).toBe("0123456789abcdef");
    expect(span.startTimeUnixNano).toBe(1_700_000_000_000_000_000n);
    expect(span.statusCode).toBe("STATUS_CODE_ERROR");
    expect(span.resourceAttributes["service.name"]).toBe("checkout");
    expect(span.scopeName).toBe("opentelemetry.instrumentation.openai");

    const mapped = otelSpanToIngestInput(span);
    expect(mapped).toMatchObject({
      name: "chat gpt-4o-mini",
      model: "gpt-4o-mini",
      input: "where is my order?",
      output: "shipped monday",
      error: "upstream timeout",
      latency_ms: 2000,
      input_tokens: 120,
      output_tokens: 35,
    });
  });

  it("preserves nanosecond timestamps beyond Number.MAX_SAFE_INTEGER", () => {
    // Sent as a string, which is how an exporter carrying a real fixed64 does it - verify()
    // insists on integer|Long, fromObject() is what actually converts, so this one skips verify.
    const nanos = "1799999999999999999";
    const buffer = ExportTraceServiceRequestType.encode(
      ExportTraceServiceRequestType.fromObject({
        resourceSpans: [{ scopeSpans: [{ spans: [{ name: "n", startTimeUnixNano: nanos, endTimeUnixNano: nanos }] }] }],
      })
    ).finish();
    const [span] = normalizeExportRequest(decodeProtobufExportRequest(buffer));
    expect(span!.startTimeUnixNano).toBe(BigInt(nanos));
  });

  it("decodes an empty export request rather than throwing", () => {
    const decoded = decodeProtobufExportRequest(encodeRequest({}));
    expect(normalizeExportRequest(decoded)).toEqual([]);
  });

  it("throws on a buffer that is not a valid export request, so the route can answer 400", () => {
    expect(() => decodeProtobufExportRequest(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toThrow();
  });

  it("encodes a partial-success response an exporter can read back", () => {
    const encoded = encodeProtobufResponse({ rejectedSpans: 2, errorMessage: "bad span" });
    const decoded = ExportTraceServiceResponseType.toObject(ExportTraceServiceResponseType.decode(encoded), {
      longs: String,
      defaults: false,
    });
    expect(decoded).toMatchObject({ partialSuccess: { rejectedSpans: "2", errorMessage: "bad span" } });
  });

  it("encodes a bare success response", () => {
    expect(encodeProtobufResponse().length).toBe(0);
  });
});
