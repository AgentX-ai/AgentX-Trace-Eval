# ADR-0004: OpenTelemetry GenAI semantic conventions are the canonical span schema

Status: accepted (2026-08-29)

## Context

The engine already accepts OTLP/HTTP, but its stored span model is an ad-hoc field set that
grew with the product. "Industry standard" has a literal meaning for telemetry schemas: the
OpenTelemetry GenAI semantic conventions (`gen_ai.*`). Aligning to them makes AgentX ingest
anything an OTel-instrumented stack emits and future-proofs the ClickHouse schema against our
own renames.

## Decision

The canonical span model is OTel + GenAI semconv. Engine-native fields map as follows;
anything without a semconv home lives under the `agentx.*` attribute namespace. The wire API
keeps its current field names; this mapping governs storage, OTLP ingest, and export.

| Engine field | Canonical home | Notes |
|---|---|---|
| `spanId` / `parentSpanId` | OTel `span_id` / `parent_span_id` | ids stay caller-supplied, deduped per project |
| `name` (root) | OTel span name + `gen_ai.agent.name` | root span is the agent turn |
| `name` (child) | OTel span name | tool/step name |
| `spanKind` | `gen_ai.operation.name` | `chat` (llm), `execute_tool` (tool), `retrieve` (retrieval), `invoke_agent` (agent) |
| `model` | `gen_ai.request.model` / `gen_ai.response.model` | single field today; response model wins |
| `inputTokens` / `outputTokens` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | |
| `cacheReadTokens` / `cacheWriteTokens` | `gen_ai.usage.cache_read_input_tokens` / `gen_ai.usage.cache_creation_input_tokens` | incubating semconv, Anthropic-shaped |
| `input` / `output` | `gen_ai.input.messages` / `gen_ai.output.messages` | stored as payload columns, capped (ADR-0005) |
| `error` | OTel span status `ERROR` + `error.type` | |
| `latencyMs` | span `end_time - start_time` | kept denormalized for query convenience |
| `startedAt` / `createdAt` | span start/end timestamps | `createdAt` remains the ingest clock |
| `sessionId` | `session.id` | general semconv |
| `toolCalls` | `gen_ai.tool.name` + child spans | summary array kept as `agentx.tool_calls` |
| `framework` | `agentx.framework` | no semconv home; candidates tracked upstream |
| `source` ("eval-run") | `agentx.source` | excludes eval traffic from production KPIs |
| `performanceSummary` | `agentx.performance_summary` | |
| `metadata` | `agentx.metadata.*` | free-form user attributes |
| `agentId` | `gen_ai.agent.id` | |
| `projectId` | tenant key, not an attribute | primary-key prefix in every backend |

## Physical naming

The ClickHouse span table (greenfield, queried directly by external tooling) uses the semconv
names physically: `gen_ai_input_messages`, `gen_ai_usage_input_tokens`,
`gen_ai_operation_name`, `gen_ai_agent_id`, `session_id`, with AgentX-only fields under
`agentx_*`. The relational schemas predate this ADR and keep their historical names; the table
above is the bridge. Value vocabularies (span kinds, traffic sources) remain the engine's own
and converge on semconv values as a separate, explicitly-versioned step.

## Consequences

- The OTLP receiver is a first-class ingest path: a semconv-conformant span round-trips into
  the same storage shape as SDK ingest.
- Exports (backup, future cold archive) emit semconv attribute names.

## Rejected

- Freezing today's field set as the enterprise schema: every deviation from semconv becomes a
  permanent translation layer at every integration boundary.
