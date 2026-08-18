import { Router, type Request, type Response } from "express";
import { scopedDb } from "../auth/apiKey.js";
import {
  ingestTraceSchema,
  ingestTrace,
  listTracesPaginated,
  getTraceRow,
  toTraceDetailWireWithCost,
  listSessionSpans,
} from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";
import { runOnlineEvaluators } from "../core/monitor/onlineEvaluators.js";
import { runCustomEvaluators } from "../core/monitor/customEvaluators.js";
import { runClassification } from "../core/monitor/topics.js";

// Path matters here: AgentX-Python's IngestClient builds its endpoint as
// f"{base_url}/ingest/traces" (agentx/tracing/ingest_client.py). Mounting this router at
// /api/v1/ingest with a POST /traces route reproduces that exactly, so pointing the existing
// SDK at AGENTX_API_BASE_URL=http://localhost:<port>/api/v1 works with zero SDK changes.
export const ingestRouter = Router();

// See routes/otlp.ts's identical constant for the full rationale (Braintrust/Langfuse both
// default online scoring to the trace/root level, not per-span). Applies here too now that a
// span_tree-enabled SDK trace can send a child span through this same route.
const MONITOR_CHILD_SPANS = process.env.AGENTX_MONITOR_CHILD_SPANS === "true";

ingestRouter.post("/traces", async (req: Request, res: Response) => {
  const parsed = ingestTraceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid trace payload", details: parsed.error.flatten() });
    return;
  }
  const { traceId, agentId, deduped } = await ingestTrace(scopedDb(req), parsed.data);

  // trace_id is the one field send_trace_sync() reads (see ingest_client.py); the fire-and-forget
  // enqueue() path used by default doesn't inspect the body at all, so this shape covers both.
  // Sent as soon as the trace itself is durably stored, not after the checks below finish: those
  // used to be awaited here too, so a workspace with several online evaluators (each check is a
  // real judge call) routinely pushed this response past the SDK's sync=True 10-second timeout,
  // the client gave up and returned trace_id=None even though ingestion itself had already
  // succeeded and the real id was about to be sent.
  res.status(200).json({ trace_id: traceId });

  // Root spans only by default (see the MONITOR_CHILD_SPANS constant above) - a child span from a
  // span_tree-enabled trace skips Monitor/online-evaluator/classification entirely rather than
  // being scored as if it were the whole interaction.
  if (parsed.data.parent_span_id && !MONITOR_CHILD_SPANS) {
    return;
  }

  // A replayed span (same span_id, already stored - e.g. a Moveworks re-sync or an OTel retry)
  // was already checked and judged the first time: re-running the passes below would double-bill
  // every judge call and double-count every recorded event.
  if (deduped) {
    return;
  }

  // Explicit opt-out (tracer.trace(..., monitor=False)): skip every ingest-time check - pattern/
  // built-in detection, online + custom evaluators, topics. Eval-run traces send this: the run's
  // own evaluator already judges each case, so re-judging the trace would double every judge
  // bill for zero information.
  if (parsed.data.monitor === false) {
    return;
  }

  // Checked in the background, after responding: no background job queue in self-host (see plan
  // task #110), this is the same in-process fire-and-forget shape, just no longer blocking the
  // response the caller is actually waiting on. A caller polling client.monitor.signals or
  // .online_evaluators.ratings/events right after this call (as the sample scripts do) already
  // has to poll/retry regardless, detection was never guaranteed to finish inside the old
  // synchronous window either, just usually did.
  //
  // Both calls are wrapped in .catch(): callJudgeJson throws a clear error on a missing judge API
  // key (core/evaluate/judge.ts, deliberate UX for the direct-call case), and an unhandled
  // rejection here (now fully detached from the request/response cycle) would otherwise be a
  // silent, uncaught background rejection instead of a logged one.
  //
  // Same opt-in-by-existing posture as online evaluators below: active patterns and built-in
  // checks run on every root trace, no per-agent dashboard toggle required (the per-agent
  // monitoring profile concept is no longer a UI-level gate; an agent with a profile row that
  // was explicitly disabled still opts out inside runMonitorCheck). monitor=true with explicit
  // pattern_ids still restricts detection to exactly those patterns.
  const traceForMonitor = {
    input: parsed.data.input,
    output: parsed.data.output,
    error: parsed.data.error ?? null,
    toolCalls: (parsed.data.tool_calls as Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }>) ?? null,
    latencyMs: parsed.data.latency_ms ?? null,
  };
  runMonitorCheck(
    scopedDb(req),
    traceForMonitor,
    parsed.data.monitor ? { agentId, traceId, patternIds: parsed.data.pattern_ids } : { agentId, traceId }
  ).catch(err => {
    console.error("Monitor check failed:", err instanceof Error ? err.message : err);
  });

  // Independent of the `monitor` flag above: online evaluators are a server-side-configured
  // feature (opt in by creating one, not by a per-call flag), see core/monitor/onlineEvaluators.ts.
  runOnlineEvaluators(
    scopedDb(req),
    { input: parsed.data.input, output: parsed.data.output, metadata: parsed.data.metadata },
    { agentId, traceId }
  ).catch(err => {
    console.error("Online evaluator scoring failed:", err instanceof Error ? err.message : err);
  });

  // Same independent, opt-in-by-creating-one posture as online evaluators above - see
  // core/monitor/customEvaluators.ts.
  runCustomEvaluators(scopedDb(req), traceForMonitor, { agentId, traceId }).catch(err => {
    console.error("Custom evaluator scoring failed:", err instanceof Error ? err.message : err);
  });

  // Third independent pass, same fire-and-forget shape - see core/monitor/topics.ts. Opt-in via
  // AgentMonitoringProfile.topicsEnabled (checked inside runClassification itself), so this is a
  // no-op unless the dashboard's per-agent "Topics" toggle was actually turned on.
  runClassification(
    scopedDb(req),
    { input: parsed.data.input, output: parsed.data.output },
    { agentId, traceId }
  ).catch(err => {
    console.error("Trace classification failed:", err instanceof Error ? err.message : err);
  });
});

// Not part of the SDK-compatible surface (the SDK only ever POSTs here, see the comment above),
// this is what AgentX-web-front's dashboard actually calls to list traces (Governance > Observe).
// Cursor-paginated, matching src/data/queries/evaluate/useGetProductionTraces.ts's params/
// response shape exactly, see core/trace/ingest.ts's listTracesPaginated.
ingestRouter.get("/traces", async (req: Request, res: Response) => {
  const { limit, cursor, framework } = req.query;
  const result = await listTracesPaginated(scopedDb(req), {
    limit: limit ? Number(limit) : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    framework: typeof framework === "string" ? framework : undefined,
  });
  res.status(200).json(result);
});

// Single-trace detail for AgentX-web-front's self-host trace dialog (src/components/dialogs/
// TraceDialog/TraceDialog.tsx -> TraceDetails.tsx). The hosted platform's equivalent dialog reads
// from a different, hosted-only endpoint (chat/conversation/message/traces/:id) tied to its own
// conversation/message model, which doesn't exist here - this is the self-host-specific
// counterpart, powering the same shared TraceDetails component via its own dedicated hook
// (useGetSelfHostTrace), the same "separate hook per host-mode" split useGetProductionTraces
// already uses for the list view, rather than branching inside one hook.
ingestRouter.get("/traces/:traceId", async (req: Request, res: Response) => {
  const { traceId } = req.params;
  if (!traceId) {
    res.status(400).json({ error: "traceId is required" });
    return;
  }
  const row = await getTraceRow(scopedDb(req), traceId);
  if (!row) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.status(200).json(await toTraceDetailWireWithCost(scopedDb(req), row));
});

// Every span belonging to one OTel trace (sessionId = the OTel traceId, see otel/mapping.ts's
// otelSpanToIngestInput), for the self-host trace dialog's span-tree navigation panel. Deliberately
// its own route rather than a sessionId filter on GET /traces above: that one is cursor-paginated
// and capped at 100/page, wrong shape for "give me every span in this session" (see
// core/trace/ingest.ts's listSessionSpans).
ingestRouter.get("/sessions/:sessionId/spans", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const spans = await listSessionSpans(scopedDb(req), sessionId);
  res.status(200).json({ spans });
});
