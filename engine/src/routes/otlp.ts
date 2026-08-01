import { Router, type Request, type Response } from "express";
import express from "express";
import { getDb } from "../storage/db.js";
import { ingestTraceSchema, ingestTrace } from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";
import { decodeProtobufExportRequest, encodeProtobufResponse } from "../otel/protoTypes.js";
import { normalizeExportRequest } from "../otel/normalize.js";
import { otelSpanToIngestInput } from "../otel/mapping.js";

// A real OTLP/HTTP trace receiver: point any OpenTelemetry SDK/exporter or the Collector's
// otlphttpexporter at this base URL (http://localhost:<port>/api/v1/otel) and it works, same as
// pointing one at LangSmith's `/otel` endpoint — most OTel HTTP exporters append `/v1/traces` to
// whatever base endpoint is configured, hence mounting POST /v1/traces here rather than at the
// router root. Auth reuses the existing requireApiKey middleware (see index.ts): set
// OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<local API key>" on the exporter, no new auth mechanism
// needed.
//
// Both OTLP/HTTP wire formats are supported: protobuf (the default and, for Python's
// opentelemetry-exporter-otlp-proto-http, the ONLY transport it ships — see otel/protoSchema.ts)
// and JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json, common from Node/JS exporters and hand-rolled
// clients). One incoming span becomes one AgentX trace row (core/trace/ingest.ts's existing
// ingestTrace, reused unchanged) — see otel/mapping.ts for the GenAI/OpenLLMetry/OpenInference
// attribute-to-field mapping and its disclosed limitations.
export const otlpRouter = Router();

// Scoped to this router (only activates for this content-type) so it can coexist with the
// app-level express.json() already mounted in index.ts — body-parser middlewares pass through
// untouched when the request's Content-Type doesn't match their `type` filter, so JSON requests
// still reach this route with req.body already parsed, and protobuf requests still have an
// unconsumed body stream for this to read.
otlpRouter.use(express.raw({ type: "application/x-protobuf", limit: "10mb" }));

// Traces ingested this way have no explicit per-call `monitor: true` opt-in on the wire (unlike
// the SDK's tracer.trace(..., monitor=True) call) — defaulted on, since pointing an OTel exporter
// at this endpoint at all is itself the opt-in signal, and leaving it off by default would
// silently leave Observe empty for anyone trying this out. AGENTX_OTEL_MONITOR=false disables it.
const MONITOR_OTEL_TRACES = process.env.AGENTX_OTEL_MONITOR !== "false";

otlpRouter.post("/v1/traces", async (req: Request, res: Response) => {
  const isProtobuf = Boolean(req.is("application/x-protobuf"));
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
  const db = getDb();
  let rejected = 0;
  let lastError = "";

  for (const span of spans) {
    const candidate = otelSpanToIngestInput(span);
    const validation = ingestTraceSchema.safeParse(candidate);
    if (!validation.success) {
      rejected++;
      lastError = validation.error.message;
      continue;
    }
    const input = validation.data;
    const { traceId } = await ingestTrace(db, input);

    if (MONITOR_OTEL_TRACES) {
      await runMonitorCheck(
        db,
        {
          input: input.input,
          output: input.output,
          error: input.error ?? null,
          toolCalls: (input.tool_calls as Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }>) ?? null,
          latencyMs: input.latency_ms ?? null,
        },
        { agentId: input.name, traceId }
      );
    }
  }

  const partialSuccess = rejected > 0 ? { rejectedSpans: rejected, errorMessage: lastError } : undefined;
  if (isProtobuf) {
    res.status(200).type("application/x-protobuf").send(Buffer.from(encodeProtobufResponse(partialSuccess)));
  } else {
    res.status(200).json(partialSuccess ? { partialSuccess } : {});
  }
});
