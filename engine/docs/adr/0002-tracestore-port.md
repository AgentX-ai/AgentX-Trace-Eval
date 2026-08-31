# ADR-0002: A TraceStore port with per-backend adapters, pinned by one contract suite

Status: accepted (2026-08-29)

## Context

Seventeen modules read or write the traces table directly through drizzle, each carrying the
two-dialect (SQLite/Postgres) branching by hand. Adding a third backend that is not SQL, or
not row-oriented, is impossible without a seam.

## Decision

All span access goes through the `TraceStore` interface (`src/core/trace/store/traceStore.ts`):
batch ingest, point reads (span id, trace id, session id), window queries with the small set of
filters the product actually uses, windowed aggregation, retention pruning, and project
deletion. `SqlTraceStore` implements it over the existing drizzle handles for SQLite and
Postgres; `ClickHouseTraceStore` (ADR-0003) implements it natively.

A single golden contract suite (`src/test/traceStore.contract.test.ts`) runs the same scenario
against every available backend. A behavior difference between backends is a failing build.

## Consequences

- No route or core module touches `db.schema.traces` outside the store implementations; a
  lint-style test enforces the boundary.
- The port's query surface is deliberately narrow. New read shapes extend the port explicitly
  rather than reaching around it.

## Rejected

- ORM-level abstraction only: leaks aggregation SQL and dialect branches everywhere, which is
  the current state being replaced.
- ClickHouse-only enterprise path without the port: forks the product.
