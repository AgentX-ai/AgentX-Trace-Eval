# ADR-0007: Retention is a property of the storage engine, not a DELETE loop

Status: accepted (2026-08-29)

## Context

Retention today is `DELETE WHERE created_at < cutoff`, run inline during detection. On a hot
Postgres table this is the classic bloat-and-vacuum trap, and inline execution puts prune cost
on the request path.

## Decision

- ClickHouse: a `TTL` clause on the span table (rollups are relational in every tier, ADR-0006,
  and age out with the relational prune below).
- Postgres: daily partitions; instance-level retention drops whole partitions.
- SQLite/relational: deletes throttled to at most once an hour per (project, scope), triggered
  opportunistically from the detection path rather than a scheduler.

Retention runs off the request path everywhere. Per-project retention settings keep working;
the store adapter translates them into its engine's mechanism.

## Rejected

- Keeping DELETE-on-ingest: measured request-path stalls and unbounded vacuum debt at volume.
