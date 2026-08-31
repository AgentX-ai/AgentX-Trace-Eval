# Capacity SLOs

Proposed targets; the phase-5 benchmark harness is the authority and replaces this table with
measured numbers. Regressions beyond threshold fail the nightly benchmark run.

| Objective | Team (Postgres) | Enterprise (ClickHouse) |
|---|---|---|
| Sustained ingest | 1,000 spans/s | 25,000 spans/s |
| Ingest ack p95 | < 50 ms | < 50 ms |
| Dashboard query p95 (30d window) | < 500 ms | < 300 ms |
| Trace detail p95 | < 200 ms | < 200 ms |
| Retention at target ingest | 30 days | 90+ days |
| Storage per 1M spans (compressed) | measure | < 2 GB target |

Method: the harness generates a realistic payload mix (sizes drawn from production-shaped
distributions, 20 percent tool spans, 10 percent retrieval, session ids on 40 percent),
sustains load for the configured duration (60 s in nightly CI; run longer locally for soak
numbers), then runs the dashboard query set sequentially and reports its percentiles.
