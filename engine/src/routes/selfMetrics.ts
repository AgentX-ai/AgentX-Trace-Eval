import type { Request, Response } from "express";
import express from "express";
import { ingestQueueMetrics } from "../core/trace/ingestQueue.js";

// Self-metrics (phase 6 of the trace-store plan): the engine observing itself. Prometheus text
// format on the engine's one port, open by default (self-host convenience; the content is
// deliberately operational-only - queue counters, RSS, uptime - never span content, keys, or
// per-project data). Internet-exposed deployments set AGENTX_METRICS_TOKEN and scrape with
// `Authorization: Bearer <token>` (Prometheus: `authorization: credentials:`). Every number
// here is also the first thing the runbook asks for (docs/runbook.md); counters are
// process-lifetime.
export const selfMetricsRouter = express.Router();

selfMetricsRouter.get("/metrics", (req: Request, res: Response) => {
  const token = process.env.AGENTX_METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.status(401).type("text/plain").send("metrics require Authorization: Bearer <AGENTX_METRICS_TOKEN>\n");
    return;
  }
  const m = ingestQueueMetrics;
  const mem = process.memoryUsage();
  const lines = [
    "# HELP agentx_ingest_queue_depth Spans currently queued for flush.",
    "# TYPE agentx_ingest_queue_depth gauge",
    `agentx_ingest_queue_depth ${m.depth}`,
    "# HELP agentx_ingest_queue_max_depth High-water mark of the ingest queue.",
    "# TYPE agentx_ingest_queue_max_depth gauge",
    `agentx_ingest_queue_max_depth ${m.maxDepth}`,
    "# HELP agentx_ingest_spans_total Spans accepted into the queue.",
    "# TYPE agentx_ingest_spans_total counter",
    `agentx_ingest_spans_total ${m.accepted}`,
    "# HELP agentx_ingest_spans_stored_total Spans durably stored.",
    "# TYPE agentx_ingest_spans_stored_total counter",
    `agentx_ingest_spans_stored_total ${m.stored}`,
    "# HELP agentx_ingest_spans_deduped_total Replays deduped by the idempotency key.",
    "# TYPE agentx_ingest_spans_deduped_total counter",
    `agentx_ingest_spans_deduped_total ${m.deduped}`,
    "# HELP agentx_ingest_spans_rejected_total Spans shed with 429 (queue full).",
    "# TYPE agentx_ingest_spans_rejected_total counter",
    `agentx_ingest_spans_rejected_total ${m.rejected}`,
    "# HELP agentx_ingest_spans_dropped_total Spans lost after a failed batch retry - should be 0.",
    "# TYPE agentx_ingest_spans_dropped_total counter",
    `agentx_ingest_spans_dropped_total ${m.dropped}`,
    "# HELP agentx_ingest_batches_total Flush batches executed.",
    "# TYPE agentx_ingest_batches_total counter",
    `agentx_ingest_batches_total ${m.batches}`,
    "# HELP agentx_process_resident_memory_bytes Resident set size.",
    "# TYPE agentx_process_resident_memory_bytes gauge",
    `agentx_process_resident_memory_bytes ${mem.rss}`,
    "# HELP agentx_process_uptime_seconds Engine process uptime.",
    "# TYPE agentx_process_uptime_seconds gauge",
    `agentx_process_uptime_seconds ${Math.round(process.uptime())}`,
  ];
  res.status(200).type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});
