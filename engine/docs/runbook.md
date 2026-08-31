# Trace store runbook

First stop for every incident: `GET /metrics` and the engine log. Every failure mode below is
rehearsed for real by `engine/scripts/chaos.mjs` (run weekly in CI, runnable anywhere docker
exists) - if an incident behaves differently than this document says, the drill suite is the
reproduction harness.

## Ingest answering 429
The bounded queue is shedding load (ADR-0005) - by design under burst. SDKs back off on
Retry-After and redeliver; span ids make retries idempotent, nothing is lost. Sustained 429s
mean the backend cannot keep up: check `agentx_ingest_queue_depth` vs `AGENTX_INGEST_QUEUE_MAX`,
then the storage backend's health. Raising the queue bound buys burst absorption, not
throughput.

## agentx_ingest_spans_dropped_total > 0
A batch failed its insert AND the one retry - spans were lost, visibly. The log line
"Ingest batch failed after retry" carries the cause. Typical: telemetry store down longer than
the retry window, or disk full. Fix the backend; the counter not moving again is the all-clear.

## ClickHouse down (enterprise tier)
Ingest requests fail their flush (one retry, then the span is dropped with the counter above
and the route answers **503 + Retry-After** so clients redeliver); the control plane and
dashboard shell stay up. The engine does not buffer to disk by design - the SDK queue and
retries are the buffer. On recovery, ingestion resumes with no operator action.

## Charts look wrong / slow after an upgrade
The Monitor dashboard reads per-minute rollups (ADR-0006) with an automatic raw-scan fallback
whenever rollups do not fully cover the window (pre-feature history, custom past ranges). Wrong
numbers on the DEFAULT view mean a rollup bug: file it; rollups are derived data, spans stay
the source of truth.

## Retention
ClickHouse: TTL, engine-native. SQL tiers: hourly-throttled deletes (core/monitor/events.ts).
A retention-days change applies within the hour; a ClickHouse TTL change needs
`ALTER TABLE agentx_spans MODIFY TTL` today (bootstrap only sets it at create).

## Backup / restore
Control plane: normal Postgres/SQLite backups, plus the NDJSON export surface (README).
ClickHouse: `clickhouse-backup` or filesystem snapshots of /var/lib/clickhouse; spans are
append-only, so incremental strategies work well. Restore drill: boot the compose profile
against restored volumes and check `/metrics` plus a trace list.
