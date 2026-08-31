# ADR-0005: Ingest is batched, bounded, and idempotent; backpressure is explicit

Status: accepted (2026-08-29)

## Context

Ingest inserts one row per span, per request, and runs detection inline. Batching is the
difference between hundreds and tens of thousands of spans per second on every backend,
including SQLite. An observability product must also fail honestly: silent drops poison trust.

## Decision

- Spans enter an in-process bounded queue (default 10,000 spans) and flush in micro-batches:
  whichever comes first of 500 spans or 10 ms. Requests arriving inside one flush window share
  one multi-row INSERT - that coalescing is the entire throughput win.
- The ack means "durably stored": the request awaits its batch's commit (bounded by the flush
  window), so read-your-writes holds for every client. Amended from the original ack-on-enqueue
  draft, which broke visibility guarantees the SDK and product genuinely rely on.
- Delivery is at-least-once. The existing `(project_id, span_id)` idempotency key deduplicates
  replays at the store.
- When the queue is full the API answers `429` with `Retry-After`; the SDK backs off and
  retries. Load is shed visibly, never silently. Queue depth is exported as a self-metric.
- Payloads are capped (default 100 KB per input/output field) with an explicit
  `agentx.truncated` marker; the cap is configuration, the marker is not.
- Detection and scoring consume ingested spans asynchronously and never gate the ack.

## Rejected

- Kafka or an external queue: right at multi-node scale, pure operational tax before it. The
  429 contract means adding one later changes no client.
- Fire-and-forget ingest: observability data that lies.
