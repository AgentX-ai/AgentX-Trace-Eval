import { keyValueListToRecord } from "./attributes.js";
import { parseUnixNanosOrZero } from "../core/shared/unixNano.js";

export type NormalizedSpanEvent = { name: string; attributes: Record<string, unknown> };

export type NormalizedSpan = {
  traceIdHex: string;
  spanIdHex: string;
  parentSpanIdHex: string | null;
  name: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  scopeName: string | null;
  statusCode: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR" | string;
  statusMessage: string | null;
  events: NormalizedSpanEvent[];
};

// Bytes fields (trace/span/parent-span id) arrive in two encodings, and the OTLP spec makes
// them DIFFERENT: the protobuf-decoded object carries base64 (bytes: String, see protoTypes.ts,
// the plain proto3-JSON mapping), but OTLP/JSON is an explicit spec exception - ids are
// hex-encoded there (opentelemetry-proto's JSON mapping note; opentelemetry-js's JSON exporter
// sends hex). Treating both as base64 garbled every JSON-protocol exporter's ids into junk
// sessions (deep-dive round 3, bug #3). The two encodings are length-unambiguous: hex ids are
// 32 (trace) / 16 (span) chars of pure hex, base64 of the same bytes is 24 / 12 chars - so
// detect by shape instead of trusting one spec reading. Rendered as lowercase hex either way,
// matching how every OTel backend and W3C tracecontext display ids.
function idToHex(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  if ((value.length === 32 || value.length === 16) && /^[0-9a-fA-F]+$/.test(value)) {
    return value.toLowerCase();
  }
  return Buffer.from(value, "base64").toString("hex");
}

// A handful of real-world JSON producers emit snake_case (the literal .proto field names) instead
// of the protobuf-JSON-mapping's canonical lowerCamelCase - cheap to tolerate for the multi-word
// top-level fields, so accept either rather than requiring exact spec compliance from every body.
function normalizeStatusCode(code: unknown): NormalizedSpan["statusCode"] {
  if (code === 2 || code === "2" || code === "STATUS_CODE_ERROR") return "STATUS_CODE_ERROR";
  if (code === 1 || code === "1" || code === "STATUS_CODE_OK") return "STATUS_CODE_OK";
  return "STATUS_CODE_UNSET";
}

function pick<T>(obj: Record<string, unknown> | undefined, camel: string, snake: string): T | undefined {
  if (!obj) {
    return undefined;
  }
  return (obj[camel] ?? obj[snake]) as T | undefined;
}

// Accepts the same shape whether it came from decodeProtobufExportRequest() or was parsed
// directly from a JSON request body - both are plain objects with (mostly) camelCase keys by the
// time they reach here, see protoTypes.ts's toObject options comment.
// Nothing below may throw: this runs outside routes/otlp.ts's decode try/catch, in an async
// handler, so a throw is an unhandled rejection rather than a 400. Every list and object off the
// wire is checked rather than asserted - "an exporter sent this" is not "this matches the spec".
function objectList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter(item => item && typeof item === "object") as Record<string, unknown>[]) : [];
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizeExportRequest(parsed: Record<string, unknown>): NormalizedSpan[] {
  const spans: NormalizedSpan[] = [];
  const resourceSpansList = objectList(pick<unknown[]>(parsed, "resourceSpans", "resource_spans"));

  for (const rs of resourceSpansList) {
    const resource = objectOrUndefined(rs.resource);
    const resourceAttributes = keyValueListToRecord(resource?.attributes as never);
    const scopeSpansList = objectList(pick<unknown[]>(rs, "scopeSpans", "scope_spans"));

    for (const ss of scopeSpansList) {
      const scope = objectOrUndefined(ss.scope);
      const scopeName = typeof scope?.name === "string" ? scope.name : null;
      const spanList = objectList(ss.spans);

      for (const span of spanList) {
        const status = objectOrUndefined(span.status);
        const events = objectList(span.events);
        spans.push({
          traceIdHex: idToHex(pick(span, "traceId", "trace_id")) ?? "",
          spanIdHex: idToHex(pick(span, "spanId", "span_id")) ?? "",
          parentSpanIdHex: idToHex(pick(span, "parentSpanId", "parent_span_id")),
          name: typeof span.name === "string" && span.name ? span.name : "unknown",
          // 0n for anything unparseable, which mapping.ts already treats as "no timestamp".
          startTimeUnixNano: parseUnixNanosOrZero(pick(span, "startTimeUnixNano", "start_time_unix_nano")),
          endTimeUnixNano: parseUnixNanosOrZero(pick(span, "endTimeUnixNano", "end_time_unix_nano")),
          attributes: keyValueListToRecord(span.attributes as never),
          resourceAttributes,
          scopeName,
          // The proto3-JSON mapping allows enums as either name strings ("STATUS_CODE_ERROR") or
          // numbers (2), and real JSON exporters (OTel JS among them) send the number - normalize
          // both to the string enum here so downstream checks (extractError) compare one shape.
          statusCode: normalizeStatusCode(status?.code),
          statusMessage: typeof status?.message === "string" ? status.message : null,
          events: events.map(e => ({
            name: typeof e.name === "string" ? e.name : "",
            attributes: keyValueListToRecord(e.attributes as never),
          })),
        });
      }
    }
  }

  return spans;
}
