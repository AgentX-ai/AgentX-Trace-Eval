import protobuf from "protobufjs";
import { COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO } from "./protoSchema.js";

// Parsed once at module load (not per-request): protobuf.parse() builds a reflection Root from
// .proto text, same as protobuf.load() would from files on disk, just without needing a
// filesystem. Order matters (common has no imports; resource and trace both reference common;
// trace_service references trace) so every referenced type already exists in the shared root by
// the time resolveAll() runs.
const root = new protobuf.Root();
for (const source of [COMMON_PROTO, RESOURCE_PROTO, TRACE_PROTO, TRACE_SERVICE_PROTO]) {
  protobuf.parse(source, root, { keepCase: false });
}
root.resolveAll();

export const ExportTraceServiceRequestType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
);
export const ExportTraceServiceResponseType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse"
);

// keepCase: false (the parse-time default) auto-camelCases every field name (resource_spans ->
// resourceSpans, trace_id -> traceId, ...), so toObject() output here has the exact same shape as
// an OTLP/JSON body from a real exporter (which uses the protobuf canonical JSON mapping's
// lowerCamelCase convention) — normalize.ts/attributes.ts handle both with one code path.
export const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
  oneofs: true,
  defaults: false,
};

export function decodeProtobufExportRequest(buffer: Uint8Array): Record<string, unknown> {
  const message = ExportTraceServiceRequestType.decode(buffer);
  return ExportTraceServiceRequestType.toObject(message, TO_OBJECT_OPTIONS);
}

export function encodeProtobufResponse(partialSuccess?: { rejectedSpans: number; errorMessage: string }): Uint8Array {
  const message = ExportTraceServiceResponseType.fromObject(
    partialSuccess ? { partialSuccess } : {}
  );
  return ExportTraceServiceResponseType.encode(message).finish();
}
