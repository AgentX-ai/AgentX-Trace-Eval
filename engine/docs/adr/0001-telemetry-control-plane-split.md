# ADR-0001: Telemetry and control plane are separate concerns

Status: accepted (2026-08-29)

## Context

The engine stores two workloads with opposite shapes in one database. Governance entities
(projects, datasets, scorers, signals, evaluation runs, auth) are relational: point reads,
updates, transactions, modest volume. Spans are log-shaped: append-only, time-ordered,
unbounded volume, read by window, aged out by retention. At production traffic the span
workload dominates storage and I/O, and its maintenance behavior (vacuum pressure from
retention deletes, index growth) degrades the transactional tables sharing the instance.

## Decision

Span and rollup storage sits behind a dedicated port (ADR-0002). Governance entities stay in
the relational store (SQLite or Postgres) with full transactional durability, at every tier.
The deployment tiers are:

| Tier | Control plane | Telemetry |
|---|---|---|
| Self-host | SQLite | SQLite (same file) |
| Team | Postgres | Postgres (partitioned) |
| Enterprise | Postgres | ClickHouse |

One engine binary, one wire API; the tier is a deployment choice, never a fork.

## Consequences

Every read of span data anywhere in the engine must go through the port, because in the
enterprise tier the rows are not in the relational database at all. Joins between governance
tables and spans become application-level joins.

## Rejected

- One schema for everything: couples retention and vacuum behavior to transactional tables.
- A separate telemetry service: operational tax before any deployment needs it; the port keeps
  that door open without paying for it now.
