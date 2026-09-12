import type { Request, Response } from "express";
import { reserveTraceRoots } from "../core/shared/traceQuota.js";
import express from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import { ingestTraceSchema, beginIngestTraceQueued, type IngestTraceInput, type QueuedIngestResult } from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";
import { traceQuota } from "../core/shared/usage.js";
import { traceStoreFor } from "../core/trace/store/index.js";
import type { Db } from "../storage/db.js";

import { runOnlineEvaluators } from "../core/monitor/onlineEvaluators.js";
import { runScorerGroupsOnline } from "../core/monitor/scorerGroups.js";
import { runCustomEvaluators } from "../core/monitor/customEvaluators.js";
import { runRules } from "../core/monitor/rules.js";
import { runClassification } from "../core/monitor/topics.js";
import { decodeProtobufExportRequest, encodeProtobufResponse } from "../otel/protoTypes.js";
import { normalizeExportRequest } from "../otel/normalize.js";
import { otelSpanToIngestInput, reconstructParentToolCalls } from "../otel/mapping.js";
import { logger } from "../log.js";

// A real OTLP/HTTP trace receiver: point any OpenTelemetry SDK/exporter or the Collector's
// otlphttpexporter at this base URL (http://localhost:<port>/api/v1/otel) and it works, same as
// pointing one at LangSmith's `/otel` endpoint - most OTel HTTP exporters append `/v1/traces` to
// whatever base endpoint is configured, hence mounting POST /v1/traces here rather than at the
// router root. Auth reuses the existing requireApiKey middleware (see index.ts): set
// OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<local API key>" on the exporter, no new auth mechanism
// needed.
//
// Both OTLP/HTTP wire formats are supported: protobuf (the default and, for Python's
// opentelemetry-exporter-otlp-proto-http, the ONLY transport it ships - see otel/protoSchema.ts)
// and JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json, common from Node/JS exporters and hand-rolled
// clients). One incoming span becomes one AgentX trace row (core/trace/ingest.ts's existing
// ingestTrace, reused unchanged) - see otel/mapping.ts for the GenAI/OpenLLMetry/OpenInference
// attribute-to-field mapping and its disclosed limitations.
export const otlpRouter = asyncRouter();

// Scoped to this router (only activates for this content-type) so it can coexist with the
// app-level express.json() already mounted in index.ts - body-parser middlewares pass through
// untouched when the request's Content-Type doesn't match their `type` filter, so JSON requests
// still reach this route with req.body already parsed, and protobuf requests still have an
// unconsumed body stream for this to read.
otlpRouter.use(express.raw({ type: "application/x-protobuf", limit: "10mb" }));

// Traces ingested this way have no explicit per-call `monitor: true` opt-in on the wire (unlike
// the SDK's tracer.trace(..., monitor=True) call) - defaulted on, since pointing an OTel exporter
// at this endpoint at all is itself the opt-in signal, and leaving it off by default would
// silently leave Observe empty for anyone trying this out. AGENTX_OTEL_MONITOR=false disables it.
const MONITOR_OTEL_TRACES = process.env.AGENTX_OTEL_MONITOR !== "false";

// Braintrust and Langfuse both default online scoring to the trace/root level, not per-span -
// scoring a tool call's output as if it were the whole interaction is misleading, and it
// multiplies judge-API calls by however many spans a trace has. Root spans (no parent_span_id)
// always get checked; a child span (real hierarchy, from this OTel path or from a span_tree-
// enabled SDK trace) is skipped by default. AGENTX_MONITOR_CHILD_SPANS=true restores the old
// per-span behavior for an operator who deliberately wants it.
const MONITOR_CHILD_SPANS = process.env.AGENTX_MONITOR_CHILD_SPANS === "true";

// Per-request span cap: everything past normalization is per-span work (mapping, validation,
// queued ingest, up to six background checks each) with the whole batch held in memory, so an
// unbounded export is a one-request amplification vector. 5000 is an order of magnitude above
// any sane exporter batch (the OTel SDK default is 512); the whole request is refused with 413
// before any span is processed, so a conforming exporter can split and resend without dupes.
const MAX_SPANS_PER_EXPORT = 5000;

// Counts spans straight off the parsed envelope, BEFORE normalizeExportRequest allocates a
// NormalizedSpan (attributes record included) per span - materializing 100k spans just to
// refuse them is exactly the amplification the cap exists to prevent. Handles both wire key
// spellings, like the envelope check below; anything shaped too strangely to count here still
// hits the post-normalize backstop.
function countWireSpans(parsed: Record<string, unknown>): number {
  const resourceSpans = parsed.resourceSpans ?? parsed.resource_spans;
  if (!Array.isArray(resourceSpans)) return 0;
  let n = 0;
  for (const rs of resourceSpans) {
    if (!rs || typeof rs !== "object") continue;
    const rec = rs as Record<string, unknown>;
    const scopeSpans = rec.scopeSpans ?? rec.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      if (!ss || typeof ss !== "object") continue;
      const spans = (ss as Record<string, unknown>).spans;
      if (Array.isArray(spans)) n += spans.length;
    }
  }
  return n;
}

otlpRouter.post("/v1/traces", async (req: Request, res: Response) => {
  const isProtobuf = Boolean(req.is("application/x-protobuf"));
  // Any other content type leaves req.body an empty object, which reads here as a valid export of
  // zero spans - so a proxy rewriting the header, or a client defaulting to form-urlencoded, got a
  // 200 while every span was dropped. OTLP/HTTP specifies exactly these two.
  const isJson = Boolean(req.is("application/json"));
  if (!isProtobuf && !isJson) {
    res.status(415).json({
      error: `OTLP/HTTP requires Content-Type: application/x-protobuf or application/json (received ${
        req.headers["content-type"] ? `"${req.headers["content-type"]}"` : "none"
      })`,
    });
    return;
  }
  let parsed: Record<string, unknown>;

  try {
    if (isProtobuf) {
      const buffer = req.body as Buffer;
      if (!buffer || buffer.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }
      parsed = decodeProtobufExportRequest(buffer);
    } else {
      if (!req.body || typeof req.body !== "object") {
        res.status(400).json({ error: "Expected an OTLP ExportTraceServiceRequest JSON body" });
        return;
      }
      parsed = req.body as Record<string, unknown>;
    }
  } catch (err) {
    res.status(400).json({ error: `Failed to decode OTLP payload: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // A body with NO resourceSpans key at all is not an ExportTraceServiceRequest - a proxy
  // that unwrapped the envelope, or a hand-rolled client posting {"spans": [...]}. Answering
  // the OTLP "everything accepted" 200 would drop every span while the exporter reads green -
  // the same silent-drop failure the content-type gate above already closes for its dimension.
  // A genuinely empty {"resourceSpans": []} stays a 200: that IS a valid empty export.
  const hasEnvelope =
    parsed !== null &&
    typeof parsed === "object" &&
    ("resourceSpans" in (parsed as object) || "resource_spans" in (parsed as object));
  if (!hasEnvelope) {
    res.status(400).json({ error: "body carried no resourceSpans - not an ExportTraceServiceRequest" });
    return;
  }
  // Cap enforced on the raw envelope first, before normalization materializes anything.
  const wireSpanCount = countWireSpans(parsed);
  if (wireSpanCount > MAX_SPANS_PER_EXPORT) {
    res.status(413).json({
      error: `too many spans in one export (${wireSpanCount} > ${MAX_SPANS_PER_EXPORT}) - nothing was ingested, split the batch and resend`,
    });
    return;
  }
  const spans = normalizeExportRequest(parsed);
  // Backstop for envelope shapes countWireSpans couldn't walk.
  if (spans.length > MAX_SPANS_PER_EXPORT) {
    res.status(413).json({
      error: `too many spans in one export (${spans.length} > ${MAX_SPANS_PER_EXPORT}) - nothing was ingested, split the batch and resend`,
    });
    return;
  }
  const db = scopedDb(req);
  let rejected = 0;
  let lastError = "";
  // Ingested first, fully independent of the (possibly slow) checks below: a batch export can
  // carry many spans, and awaiting a real judge call per online evaluator per span before ever
  // responding routinely pushed well past what an OTel exporter's own export timeout tolerates,
  // an exporter that gives up mid-batch doesn't know the spans it already sent were, in fact,
  // ingested successfully. Collected here so the checks can run in the background after
  // responding, same fix as routes/ingest.ts's POST /traces.

  // Whole batch mapped first, then the tool-call reconstruction pass (child gen_ai.tool.name
  // spans folded into their parent interaction's tool_calls - see mapping.ts), THEN per-span
  // validation/ingest: reconstruction has to see sibling spans together, which a map-and-ingest
  // single pass never could.
  // Per-span isolation: one malformed span (an attribute shape the mapper chokes on) must
  // reject THAT span into partialSuccess, not 500 the batch into an exporter retry loop that
  // redelivers the same poison forever.
  const candidates: ReturnType<typeof otelSpanToIngestInput>[] = [];
  let mappingRejected = 0;
  for (const span of spans) {
    try {
      const mapped = otelSpanToIngestInput(span);
      // A span whose id the normalizer rejected has NO dedupe key - storing it makes the 429
      // "safe to retry, span ids make the stored part idempotent" answer a lie (each retry
      // re-inserts it). Rejected into partialSuccess like any other unmappable span.
      if (!mapped.span_id) {
        mappingRejected++;
        logger.warn("OTLP: span carried no decodable span id - rejected into partialSuccess (undedupable)");
        continue;
      }
      candidates.push(mapped);
    } catch (err) {
      mappingRejected++;
      logger.warn({ err }, "OTLP: span failed to map - rejected into partialSuccess");
    }
  }
  reconstructParentToolCalls(candidates);

  // The daily trace quota applies to OTLP roots exactly as it does to SDK ingest - without
  // this, AGENTX_QUOTA_TRACES_PER_DAY silently meant "SDK traffic only" and an OTel exporter
  // walked past the cap. Counted once per export (root spans in this batch) and answered as
  // 429, which OTLP/HTTP exporters treat as retryable-with-backoff.
  const quota = traceQuota();
  if (quota !== null) {
    const incomingRoots = candidates.filter(c => !c.parent_span_id).length;
    if (incomingRoots > 0) {
      // Reserved, not check-then-acted - see core/shared/traceQuota.ts.
      if (!(await reserveTraceRoots(scopedDb(req), incomingRoots, quota))) {
        res.status(429).setHeader("Retry-After", "60");
        res.json({
          error: `Daily trace quota reached (${quota}/day for this project). Quota resets at midnight UTC; raise AGENTX_QUOTA_TRACES_PER_DAY to change the ceiling.`,
        });
        return;
      }
    }
  }

  // Checked after the span durably lands (queued ingest, ADR-0005): a judge failure must
  // never break OTLP ingestion, and only conflict WINNERS run - an exporter retry that raced
  // in concurrently cannot double-bill judges.
  const runChecksFor = ({ traceId, agentId, input }: { traceId: string; agentId: string | null; input: IngestTraceInput }) => {
    if (input.parent_span_id && !MONITOR_CHILD_SPANS) {
      return;
    }

    if (MONITOR_OTEL_TRACES) {
      runMonitorCheck(
        db,
        {
          input: input.input,
          output: input.output,
          error: input.error ?? null,
          toolCalls: (input.tool_calls as Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }>) ?? null,
          latencyMs: input.latency_ms ?? null,
        },
        { agentId, traceId }
      ).catch(err => {
        logger.error({ err: err instanceof Error ? err.message : err }, "Monitor check failed:");
      });
    }

    runOnlineEvaluators(db, { input: input.input, output: input.output, metadata: input.metadata }, { agentId, traceId }).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Online evaluator scoring failed:");
    });

    runScorerGroupsOnline(db, { input: input.input, output: input.output }, { agentId, traceId }).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Scorer group scoring failed:");
    });

    runCustomEvaluators(
      db,
      {
        input: input.input,
        output: input.output,
        error: input.error ?? null,
        toolCalls: (input.tool_calls as Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }>) ?? null,
      },
      { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Custom evaluator scoring failed:");
    });

    // Automation rules run on OTel traffic exactly like SDK traffic - an OTel-instrumented
    // install previously got zero rule-driven review sampling, dataset curation, or webhooks,
    // silently (routes/ingest.ts had this call, this path did not).
    runRules(
      db,
      {
        input: input.input,
        output: input.output,
        error: input.error ?? null,
        model: input.model ?? null,
        name: input.name ?? null,
      },
      { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Automation rules failed:");
    });

    runClassification(db, { input: input.input, output: input.output }, { agentId, traceId }).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Trace classification failed:");
    });
    };

  // Two phases (ADR-0005): every span is ENQUEUED before any span is awaited, so the whole
  // OTLP export coalesces into shared micro-batches. Awaiting each span's commit inside the
  // enqueue loop would serialize one flush (and one full flush-timer wait) per span - a
  // 1,000-span export would take longer than the exporter's own export timeout.
  const settling: Array<{ settle: Promise<QueuedIngestResult>; input: IngestTraceInput }> = [];
  let queueFull = 0;
  for (const candidate of candidates) {
    const validation = ingestTraceSchema.safeParse(candidate);
    if (!validation.success) {
      rejected++;
      lastError = validation.error.message;
      continue;
    }
    const input = validation.data;
    const { accepted, settle } = await beginIngestTraceQueued(db, input);
    if (!accepted) {
      queueFull++;
      continue;
    }
    settling.push({ settle, input });
  }

  let droppedCount = 0;
  for (const { settle, input } of settling) {
    const { traceId, agentId, deduped, dropped } = await settle;
    if (dropped) {
      droppedCount++;
      continue;
    }
    // A replayed span (OTel exporter retry) was already checked/judged on first arrival -
    // the deduped guard mirrors routes/ingest.ts.
    if (!deduped) {
      runChecksFor({ traceId, agentId, input });
    }
  }

  // Backpressure and storage failure answer with RETRYABLE codes (429/503), never
  // partialSuccess: per OTLP/HTTP, partial-success spans "will not be retried" by conforming
  // exporters, which would turn load shedding into permanent data loss. Redelivering the whole
  // export is safe - span ids make the already-stored part idempotent. partialSuccess is
  // reserved for schema-invalid spans, which genuinely must not be retried.
  if (queueFull > 0) {
    res.status(429).set("Retry-After", "1").json({ message: `ingest queue full - ${queueFull} spans shed, retry with backoff` });
    return;
  }
  if (droppedCount > 0) {
    res.status(503).set("Retry-After", "2").json({ message: `trace storage unavailable - ${droppedCount} spans not stored, retry` });
    return;
  }
  const totalRejected = rejected + mappingRejected;
  const partialSuccess =
    totalRejected > 0
      ? { rejectedSpans: totalRejected, errorMessage: lastError || (mappingRejected > 0 ? "spans failed to map" : "") }
      : undefined;
  if (isProtobuf) {
    res.status(200).type("application/x-protobuf").send(Buffer.from(encodeProtobufResponse(partialSuccess)));
  } else {
    res.status(200).json(partialSuccess ? { partialSuccess } : {});
  }

});
