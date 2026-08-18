import type { Request, Response } from "express";
import express from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import { ingestTraceSchema, ingestTrace, type IngestTraceInput } from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";
import { runOnlineEvaluators } from "../core/monitor/onlineEvaluators.js";
import { runCustomEvaluators } from "../core/monitor/customEvaluators.js";
import { runClassification } from "../core/monitor/topics.js";
import { decodeProtobufExportRequest, encodeProtobufResponse } from "../otel/protoTypes.js";
import { normalizeExportRequest } from "../otel/normalize.js";
import { otelSpanToIngestInput, reconstructParentToolCalls } from "../otel/mapping.js";

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

  const spans = normalizeExportRequest(parsed);
  const db = scopedDb(req);
  let rejected = 0;
  let lastError = "";
  // Ingested first, fully independent of the (possibly slow) checks below: a batch export can
  // carry many spans, and awaiting a real judge call per online evaluator per span before ever
  // responding routinely pushed well past what an OTel exporter's own export timeout tolerates,
  // an exporter that gives up mid-batch doesn't know the spans it already sent were, in fact,
  // ingested successfully. Collected here so the checks can run in the background after
  // responding, same fix as routes/ingest.ts's POST /traces.
  const checkTargets: { traceId: string; agentId: string | null; input: IngestTraceInput }[] = [];

  // Whole batch mapped first, then the tool-call reconstruction pass (child gen_ai.tool.name
  // spans folded into their parent interaction's tool_calls - see mapping.ts), THEN per-span
  // validation/ingest: reconstruction has to see sibling spans together, which a map-and-ingest
  // single pass never could.
  const candidates = spans.map(otelSpanToIngestInput);
  reconstructParentToolCalls(candidates);

  for (const candidate of candidates) {
    const validation = ingestTraceSchema.safeParse(candidate);
    if (!validation.success) {
      rejected++;
      lastError = validation.error.message;
      continue;
    }
    const input = validation.data;
    const { traceId, agentId, deduped } = await ingestTrace(db, input);
    // A replayed span (OTel exporter retry) was already checked/judged on first arrival -
    // skipping it here mirrors routes/ingest.ts's own deduped guard.
    if (!deduped) {
      checkTargets.push({ traceId, agentId, input });
    }
  }

  const partialSuccess = rejected > 0 ? { rejectedSpans: rejected, errorMessage: lastError } : undefined;
  if (isProtobuf) {
    res.status(200).type("application/x-protobuf").send(Buffer.from(encodeProtobufResponse(partialSuccess)));
  } else {
    res.status(200).json(partialSuccess ? { partialSuccess } : {});
  }

  // Checked in the background, after responding: a judge failure (missing API key, provider
  // outage) must never break OTLP ingestion, and now that these run detached from the request
  // they're wrapped in .catch() rather than try/catch so a rejection is logged instead of
  // becoming a silent unhandled one.
  for (const { traceId, agentId, input } of checkTargets) {
    if (input.parent_span_id && !MONITOR_CHILD_SPANS) {
      continue;
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
        console.error("Monitor check failed:", err instanceof Error ? err.message : err);
      });
    }

    runOnlineEvaluators(db, { input: input.input, output: input.output, metadata: input.metadata }, { agentId, traceId }).catch(err => {
      console.error("Online evaluator scoring failed:", err instanceof Error ? err.message : err);
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
      console.error("Custom evaluator scoring failed:", err instanceof Error ? err.message : err);
    });

    runClassification(db, { input: input.input, output: input.output }, { agentId, traceId }).catch(err => {
      console.error("Trace classification failed:", err instanceof Error ? err.message : err);
    });
  }
});
