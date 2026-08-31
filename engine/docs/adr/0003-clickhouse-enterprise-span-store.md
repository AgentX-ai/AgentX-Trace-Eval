# ADR-0003: ClickHouse is the enterprise span store

Status: accepted (2026-08-29)

## Context

At sustained production traffic (tens of millions of spans, 90+ day retention) a row-store
holds spans poorly: JSON payloads dominate storage, window aggregations scan wide, and
retention churns vacuum. The observability industry converged on columnar stores for this
table; Langfuse (v3), SigNoz, HyperDX, and Helicone all run spans on ClickHouse.

## Decision

The enterprise tier stores spans in ClickHouse:

- `MergeTree` ordered by `(project_id, created_at, trace_id)`, partitioned by day
  (`toYYYYMMDD(created_at)`).
- `ZSTD` codecs on payload columns; `LowCardinality(String)` for model/framework/kind fields.
- `TTL created_at + INTERVAL retention DAY` for retention (ADR-0007).
- Rollups stay relational in every tier: the ingest queue maintains the per-minute rollup
  table in the control-plane database (ADR-0006). Native ClickHouse materialized views are a
  named future optimization, not part of this decision.
- All queries carry `project_id` in the primary key prefix; tenant isolation is enforced in the
  adapter and covered by cross-project leak tests.

Single node plus backups first. The schema (partitioning, project scoping) is designed so
replication and sharding are additive, recorded here as future ADRs.

## Rejected

- TimescaleDB: attractive as "still Postgres", but the TSL license and managed-hosting limits
  make it awkward to require of enterprises.
- Elasticsearch: cost and aggregation fit.
- Parquet on object storage with DuckDB: right for a future cold-archive tier, wrong for the
  live query path.
