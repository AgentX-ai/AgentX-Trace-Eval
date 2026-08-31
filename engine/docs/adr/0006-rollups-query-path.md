# ADR-0006: Dashboards read rollups, never raw spans

Status: accepted (2026-08-29)

## Context

The metrics endpoint loads a window of raw span rows into memory and buckets them in
JavaScript per request. Cost grows with traffic, not with chart resolution.

## Decision

A per-minute rollup stream is maintained at ingest, keyed
`(project_id, minute, production)` with per-agent and per-tool splits inside the row's data
blob: span counts by kind, token sums per model (cost is priced at READ time from live
pricing, never baked in), tool call and failure counts, error counts, and a fixed log-scale
latency histogram (mergeable, so any window's p50/p95 derive from bucket sums;
Prometheus-style).

- Every tier (ClickHouse included): a relational rollup table in the control-plane database,
  upserted right after each ingest batch commits - non-transactional and failure-tolerant by
  design (a rollup write error is logged and never fails ingestion; raw spans stay the source
  of truth, and the read path's coverage check falls back to the raw scan). ClickHouse
  materialized views are a possible future replacement, deliberately not taken yet: one rollup
  implementation, one behavior, three tiers.

Monitor charts and KPI endpoints query rollups. Raw spans serve trace detail, Observe, and
sampled inspection only. Rollup rows age out on the same retention clock as their spans.

## Rejected

- Query-time aggregation with caching: cache invalidation on live data, still O(traffic) on
  every miss.
- Exact percentiles: requires raw scans by definition; the histogram error (log-scale bucket
  width) is bounded and documented.
