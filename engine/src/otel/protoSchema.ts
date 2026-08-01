// Vendored from open-telemetry/opentelemetry-proto (Apache-2.0), the wire schema OTLP/HTTP
// exporters (Python's opentelemetry-exporter-otlp-proto-http, Node's
// @opentelemetry/exporter-trace-otlp-http, the Collector's otlphttpexporter, and every
// OpenLLMetry/OpenInference-instrumented app) encode against. Field numbers/types are copied
// verbatim from https://github.com/open-telemetry/opentelemetry-proto (main, trace/v1); only the
// prose comments are trimmed since they don't affect the wire format. Kept as inline TS string
// constants (parsed by protobufjs at process startup, see protoTypes.ts) rather than on-disk
// .proto files: a Bun-compiled single-binary distribution (see build.sh) has no filesystem to read
// sibling files from, but a plain string bundled into the binary works identically under tsx/node/
// bun. Four files (common/resource/trace/trace_service) because trace.proto imports the other two.

export const COMMON_PROTO = `
syntax = "proto3";
package opentelemetry.proto.common.v1;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}
`;

export const RESOURCE_PROTO = `
syntax = "proto3";
package opentelemetry.proto.resource.v1;
import "opentelemetry/proto/common/v1/common.proto";

message Resource {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}
`;

export const TRACE_PROTO = `
syntax = "proto3";
package opentelemetry.proto.trace.v1;
import "opentelemetry/proto/common/v1/common.proto";
import "opentelemetry/proto/resource/v1/resource.proto";

message TracesData {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  opentelemetry.proto.resource.v1.Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ScopeSpans {
  opentelemetry.proto.common.v1.InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  fixed32 flags = 16;
  string name = 5;

  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }
  SpanKind kind = 6;

  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;

  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  repeated Event events = 11;
  uint32 dropped_events_count = 12;

  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
  repeated Link links = 13;
  uint32 dropped_links_count = 14;

  Status status = 15;
}

message Status {
  reserved 1;
  string message = 2;
  enum StatusCode {
    STATUS_CODE_UNSET = 0;
    STATUS_CODE_OK = 1;
    STATUS_CODE_ERROR = 2;
  }
  StatusCode code = 3;
}
`;

export const TRACE_SERVICE_PROTO = `
syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;
import "opentelemetry/proto/trace/v1/trace.proto";

message ExportTraceServiceRequest {
  repeated opentelemetry.proto.trace.v1.ResourceSpans resource_spans = 1;
}

message ExportTraceServiceResponse {
  ExportTracePartialSuccess partial_success = 1;
}

message ExportTracePartialSuccess {
  int64 rejected_spans = 1;
  string error_message = 2;
}
`;
