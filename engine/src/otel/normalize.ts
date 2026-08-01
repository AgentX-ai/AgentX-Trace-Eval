import { keyValueListToRecord } from "./attributes.js";

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
// (bytes: String, see protoTypes.ts) and a spec-compliant OTLP/JSON body — same conversion either
// way. Rendered as hex (32/16 chars) to match how every OTel backend and the W3C tracecontext spec
// display ids, not how they're transmitted.
function base64ToHex(b64: string | undefined | null): string | null {
  if (!b64) {
    return null;
  }
  return Buffer.from(b64, "base64").toString("hex");
}

// A handful of real-world JSON producers emit snake_case (the literal .proto field names) instead
// of the protobuf-JSON-mapping's canonical lowerCamelCase — cheap to tolerate for the multi-word
// top-level fields, so accept either rather than requiring exact spec compliance from every body.
function pick<T>(obj: Record<string, unknown> | undefined, camel: string, snake: string): T | undefined {
  if (!obj) {
    return undefined;
  }
  return (obj[camel] ?? obj[snake]) as T | undefined;
}

// Accepts the same shape whether it came from decodeProtobufExportRequest() or was parsed
// directly from a JSON request body — both are plain objects with (mostly) camelCase keys by the
// time they reach here, see protoTypes.ts's toObject options comment.
export function normalizeExportRequest(parsed: Record<string, unknown>): NormalizedSpan[] {
  const spans: NormalizedSpan[] = [];
  const resourceSpansList = (pick<unknown[]>(parsed, "resourceSpans", "resource_spans") ?? []) as Record<
    string,
    unknown
  >[];

  for (const rs of resourceSpansList) {
    const resource = rs.resource as Record<string, unknown> | undefined;
    const resourceAttributes = keyValueListToRecord(resource?.attributes as never);
    const scopeSpansList = (pick<unknown[]>(rs, "scopeSpans", "scope_spans") ?? []) as Record<string, unknown>[];

    for (const ss of scopeSpansList) {
      const scope = ss.scope as Record<string, unknown> | undefined;
      const scopeName = typeof scope?.name === "string" ? scope.name : null;
      const spanList = (ss.spans ?? []) as Record<string, unknown>[];

      for (const span of spanList) {
        const status = span.status as Record<string, unknown> | undefined;
        const events = (span.events ?? []) as Record<string, unknown>[];
        spans.push({
          traceIdHex: base64ToHex(pick(span, "traceId", "trace_id")) ?? "",
          spanIdHex: base64ToHex(pick(span, "spanId", "span_id")) ?? "",
          parentSpanIdHex: base64ToHex(pick(span, "parentSpanId", "parent_span_id")),
          name: typeof span.name === "string" && span.name ? span.name : "unknown",
          startTimeUnixNano: BigInt((pick<string>(span, "startTimeUnixNano", "start_time_unix_nano") ?? "0") || "0"),
          endTimeUnixNano: BigInt((pick<string>(span, "endTimeUnixNano", "end_time_unix_nano") ?? "0") || "0"),
          attributes: keyValueListToRecord(span.attributes as never),
          resourceAttributes,
          scopeName,
          statusCode: (status?.code as string | undefined) ?? "STATUS_CODE_UNSET",
          statusMessage: (status?.message as string | undefined) ?? null,
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
