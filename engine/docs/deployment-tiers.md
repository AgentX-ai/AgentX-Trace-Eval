# Deployment tiers

One engine binary, one wire API. The tier is a deployment choice (ADR-0001), never a fork.

| Tier | Control plane | Telemetry (spans) | Configure with |
|---|---|---|---|
| Self-host | SQLite | SQLite, same file | nothing - the default |
| Team | Postgres | Postgres | `AGENTX_DB_URL=postgres://...` |
| Enterprise | Postgres | ClickHouse | `AGENTX_DB_URL=...` + `AGENTX_TELEMETRY_URL=http://user:pass@ch:8123/db` |

## How to run self-host (SQLite)

The default. Nothing to configure:

```bash
agentx-trace-eval --dev    # via the Python SDK launcher, or:
yarn dev                   # from engine/ in a checkout
```

## How to run the team tier (Postgres)

Point one env var at your database:

```bash
AGENTX_DB_URL=postgres://user:pass@host:5432/agentx agentx-server
```

Fresh installs get a natively partitioned traces table (daily partitions, drop-based
retention via `AGENTX_PG_PARTITION_RETENTION_DAYS`). Existing databases keep their
non-partitioned table and row-delete retention; both are detected automatically.

## How to run the enterprise tier (Postgres + ClickHouse)

### 1. Start it

Pick one. Docker Compose (repo root):

```bash
docker compose -f docker-compose.enterprise.yml up -d
```

Kubernetes (Helm chart in `deploy/helm/agentx`; no public image yet, build and push the
repo `Dockerfile` first):

```bash
helm install agentx deploy/helm/agentx \
  --set image.repository=<your-registry>/agentx-server
```

For managed databases, point the chart at them (the in-chart StatefulSets are then skipped):

```bash
helm install agentx deploy/helm/agentx \
  --set image.repository=<your-registry>/agentx-server \
  --set postgres.externalUrl=postgres://user:pass@pg:5432/agentx \
  --set clickhouse.externalUrl=http://user:pass@ch:8123/default
```

Or run the binary directly against your own databases:

```bash
AGENTX_DB_URL=postgres://user:pass@pg:5432/agentx \
AGENTX_TELEMETRY_URL=http://user:pass@ch:8123/default \
agentx-server
```

The engine creates and migrates everything on boot, including the ClickHouse
`agentx_spans` table with its TTL. No manual DDL.

### 2. Verify spans actually land in ClickHouse

This failure mode is silent, so check it explicitly:

```bash
# 1. Boot log must say so. If this line is missing, spans are going to Postgres.
docker compose -f docker-compose.enterprise.yml logs engine | grep "Telemetry store"
#    -> Telemetry store: ClickHouse (clickhouse:8123, TTL 90d)

# 2. Create a project, send one trace.
curl -s -X POST http://localhost:4700/api/v1/projects \
  -H 'content-type: application/json' -d '{"name":"smoke"}'
#    -> copy project.apiKey from the response
curl -s -X POST http://localhost:4700/api/v1/ingest/traces \
  -H 'content-type: application/json' -H "x-api-key: $KEY" \
  -d '{"name":"smoke-agent","input":"hi","output":"ok","monitor":false}'

# 3. The stored counter must move.
curl -s http://localhost:4700/metrics | grep agentx_ingest_spans_stored_total

# 4. (Optional) See the row in ClickHouse itself.
docker compose -f docker-compose.enterprise.yml exec clickhouse \
  clickhouse-client --password agentx --query "SELECT count() FROM agentx_spans"
```

### 3. Set retention

```bash
AGENTX_TELEMETRY_TTL_DAYS=30   # before first boot: baked into the table's TTL
```

On an existing install, bootstrap does not rewrite the TTL; change it in place:

```sql
ALTER TABLE agentx_spans MODIFY TTL toDateTime(created_at) + INTERVAL 30 DAY
```

### 4. Back up and restore

Control plane: normal Postgres backups. Spans (append-only, so incrementals work well):

```bash
# Backup: ClickHouse native format dump (or clickhouse-backup / volume snapshots).
clickhouse-client --query "SELECT * FROM agentx_spans FORMAT Native" > spans.native

# Restore into a fresh table (the engine creates it on boot).
clickhouse-client --query "INSERT INTO agentx_spans FORMAT Native" < spans.native
```

The restore path is rehearsed automatically: `node engine/scripts/chaos.mjs` round-trips a
backup and asserts byte-equality, along with the other runbook failure modes.

### 5. Measure it on your hardware

```bash
node engine/scripts/bench.mjs --base http://localhost:4700 --seconds 30
node engine/scripts/chaos.mjs
```

`bench.mjs` prints sustained spans/s and ack/query latency percentiles; CI re-runs both
(nightly benchmark with regression floors, weekly chaos drills).

## Scale-out rule

The engine stays a SINGLE instance in every tier: it is the one telemetry writer (the Helm
chart pins `replicas: 1` with a `Recreate` strategy for exactly this reason). Scale reads and
judges before scaling writers; multi-writer ingest is a named future ADR.

## Measured capacity (phase 5 baseline)

Single engine process, Apple Silicon laptop, 32 concurrent senders, production-shaped payload
mix (`engine/scripts/bench.mjs`).

| | SQLite tier | ClickHouse tier |
|---|---|---|
| Sustained ingest (stored) | 2,312 spans/s | 2,333 spans/s |
| Ingest ack p95 | 18 ms | 18 ms |
| Dashboard query p95 | 8 ms | 8 ms |

At this concurrency the HTTP layer, not storage, is the bound - the tiers separate at higher
retention and query windows, where columnar storage and TTL retention keep ClickHouse flat.

## Tuning knobs

| Env | Default | Meaning |
|---|---|---|
| `AGENTX_TELEMETRY_URL` | unset | ClickHouse URL; unset keeps spans relational |
| `AGENTX_TELEMETRY_TTL_DAYS` | 90 | ClickHouse TTL retention |
| `AGENTX_PG_PARTITION_RETENTION_DAYS` | unset | Partitioned Postgres: drop partitions older than this |
| `AGENTX_INGEST_FLUSH_MS` | 10 | Micro-batch window; requests inside it share one INSERT |
| `AGENTX_INGEST_FLUSH_SIZE` | 500 | Early-flush batch size |
| `AGENTX_INGEST_QUEUE_MAX` | 10000 | Bound; beyond it ingest answers 429 + Retry-After |
| `AGENTX_INGEST_MAX_FIELD_CHARS` | 100000 | Payload field cap (truncated with a marker) |
| `AGENTX_RATE_LIMIT_DATA_PLANE` | 6000/min | Per-window request ceiling; `AGENTX_RATE_LIMIT=off` for benches |
| `AGENTX_METRICS_TOKEN` | unset | When set, `GET /metrics` requires `Authorization: Bearer <token>` (set it on internet-exposed deployments) |

Self-metrics: `GET /metrics` (Prometheus text) - queue depth, stored/deduped/rejected/dropped
counters. `agentx_ingest_spans_dropped_total` above zero is an incident; see the runbook.
