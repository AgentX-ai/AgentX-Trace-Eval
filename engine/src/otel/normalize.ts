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

// Bytes fields (trace/span/parent-span id) are base64 in both the protobuf-decoded object
// (bytes: String, see protoTypes.ts) and a spec-compliant OTLP/JSON body - same conversion either
// way. Rendered as hex (32/16 chars) to match how every OTel backend and the W3C tracecontext spec
// display ids, not how they're transmitted.
function base64ToHex(b64: unknown): string | null {
  if (typeof b64 !== "string" || !b64) {
    return null;
  }
  return Buffer.from(b64, "base64").toString("hex");
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
// Nothing below may throw. normalizeExportRequest runs outside routes/otlp.ts's decode
// try/catch, in an async handler, so a throw here is an unhandled rejection rather than a 400 -
// see core/shared/unixNano.ts. Every list and object read off the wire is therefore checked
// rather than asserted, because "an OTel exporter sent this" is not the same as "this matches the
// spec": half-written batches, hand-rolled clients and buggy Collector processors all land here.
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
          traceIdHex: base64ToHex(pick(span, "traceId", "trace_id")) ?? "",
          spanIdHex: base64ToHex(pick(span, "spanId", "span_id")) ?? "",
          parentSpanIdHex: base64ToHex(pick(span, "parentSpanId", "parent_span_id")),
          name: typeof span.name === "string" && span.name ? span.name : "unknown",
          // 0n for anything unparseable, which mapping.ts already treats as "no timestamp" (it
          // only derives a latency from a positive delta, and omits started_at_unix_nano at 0).
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
