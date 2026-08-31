# Architecture Decision Records

Numbered, append-only. A decision changes only by writing the successor ADR that names what
changed and why; the old record stays. Template: Context, Decision, Consequences, Rejected.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-telemetry-control-plane-split.md) | Telemetry and control plane are separate concerns | accepted |
| [0002](0002-tracestore-port.md) | A TraceStore port with per-backend adapters, pinned by one contract suite | accepted |
| [0003](0003-clickhouse-enterprise-span-store.md) | ClickHouse is the enterprise span store | accepted |
| [0004](0004-otel-genai-canonical-schema.md) | OpenTelemetry GenAI semantic conventions are the canonical span schema | accepted |
| [0005](0005-ingest-batching-backpressure.md) | Ingest is batched, bounded, and idempotent; backpressure is explicit | accepted |
| [0006](0006-rollups-query-path.md) | Dashboards read rollups, never raw spans | accepted |
| [0007](0007-retention-engine-property.md) | Retention is a property of the storage engine, not a DELETE loop | accepted |

Companion documents: [capacity SLOs](../capacity-slos.md).
