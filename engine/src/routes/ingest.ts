import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import {
  ingestTraceSchema,
  ingestTraceQueued,
  listTracesPaginated,
  getTraceRow,
  toTraceDetailWireWithCost,
  listSessionSpans,
} from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";
import { evaluateTraceAgainst } from "../core/evaluate/runs.js";
import { traceQuota } from "../core/shared/usage.js";
import type { Db } from "../storage/db.js";

async function countTracesToday(db: Db): Promise<number> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return traceStoreFor(db).countRoots(dayStart);
}
import { runOnlineEvaluators } from "../core/monitor/onlineEvaluators.js";
import { traceStoreFor } from "../core/trace/store/index.js";
import { runCustomEvaluators } from "../core/monitor/customEvaluators.js";
import { runClassification } from "../core/monitor/topics.js";
import { logger } from "../log.js";
import { runRules } from "../core/monitor/rules.js";

// Path matters here: AgentX-Python's IngestClient builds its endpoint as
// f"{base_url}/ingest/traces" (agentx/tracing/ingest_client.py). Mounting this router at
// /api/v1/ingest with a POST /traces route reproduces that exactly, so pointing the existing
// SDK at AGENTX_API_BASE_URL=http://localhost:<port>/api/v1 works with zero SDK changes.
export const ingestRouter = asyncRouter();

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
  // Daily trace quota (unset = unlimited; see core/shared/usage.ts). Child spans of an
  // already-counted interaction ride free - the quota is about interactions, not tree size.
  const quota = traceQuota();
  if (quota !== null && !parsed.data.parent_span_id) {
    const used = await countTracesToday(scopedDb(req));
    if (used >= quota) {
      res.status(429).json({
        error: `Daily trace quota reached (${quota}/day for this project). Quota resets at midnight; raise AGENTX_QUOTA_TRACES_PER_DAY to change the ceiling.`,
      });
      return;
    }
  }

  const db = scopedDb(req);
  // The post-ingest pipeline (detection, online/custom evaluators, topics) runs only after the
  // span durably lands AND only if it won the idempotency conflict (ADR-0005) - a replay racing
  // in concurrently must not double-bill judges or double-count events. The guard structure
  // mirrors the pre-queue behavior exactly.
  const runPipeline = (traceId: string, agentId: string | null) => {

    // trace_id is the one field send_trace_sync() reads; `deduped` lets a re-sync importer
    // (agentx-moveworks) skip re-evaluating spans the engine already had. The fire-and-forget
    // enqueue() path used by default doesn't inspect the body at all, so this shape covers both.
    // Sent as soon as the trace itself is durably stored, not after the checks below finish: those
    // used to be awaited here too, so a workspace with several online evaluators (each check is a
    // real judge call) routinely pushed this response past the SDK's sync=True 10-second timeout,
    // the client gave up and returned trace_id=None even though ingestion itself had already
    // succeeded and the real id was about to be sent.
    // traceId is the canonical (camelCase) key; trace_id stays as the legacy alias every
    // existing SDK reads. Same one-wire-two-spellings posture as the ingest schema's aliases.
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

    // Eval-run traffic never triggers monitoring on its own: the run's evaluator already judges
    // every case, so detection would double-count, online judges would double-bill, and topics
    // would classify synthetic questions. This is server-side belt to the SDK's monitor=False
    // suspenders - a caller that stamps source but forgets the flag is still safe. An EXPLICIT
    // monitor=true wins: that is someone deliberately pointing checks at eval traffic.
    if (parsed.data.source === "eval-run" && parsed.data.monitor !== true) {
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
      db,
      traceForMonitor,
      parsed.data.monitor ? { agentId, traceId, patternIds: parsed.data.pattern_ids } : { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Monitor check failed:");
    });

    // Independent of the `monitor` flag above: online evaluators are a server-side-configured
    // feature (opt in by creating one, not by a per-call flag), see core/monitor/onlineEvaluators.ts.
    runOnlineEvaluators(
      db,
      { input: parsed.data.input, output: parsed.data.output, metadata: parsed.data.metadata },
      { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Online evaluator scoring failed:");
    });

    // Same independent, opt-in-by-creating-one posture as online evaluators above - see
    // core/monitor/customEvaluators.ts.
    runCustomEvaluators(db, traceForMonitor, { agentId, traceId }).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Custom evaluator scoring failed:");
    });

    // Automation rules (core/monitor/rules.ts): filter + sample + route. Same detached posture
    // as the scorers above, but rules never score - they move a trace somewhere (review queue,
    // dataset, webhook), so a broken rule can cost a routing action, never a judge verdict.
    runRules(
      db,
      { ...traceForMonitor, model: parsed.data.model ?? null, name: parsed.data.name ?? null },
      { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Automation rules failed:");
    });

    // Third independent pass, same fire-and-forget shape - see core/monitor/topics.ts. Opt-in
    // via topicsEnabled (checked inside runClassification itself).
    runClassification(
      db,
      { input: parsed.data.input, output: parsed.data.output },
      { agentId, traceId }
    ).catch(err => {
      logger.error({ err: err instanceof Error ? err.message : err }, "Trace classification failed:");
    });
  };

  const { traceId, agentId, deduped, accepted, dropped } = await ingestTraceQueued(db, parsed.data);

  if (dropped) {
    // The storage flush failed after its retry - honesty over optimism (ADR-0005): a 503 makes
    // the SDK redeliver; span ids keep the redelivery idempotent.
    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: "Trace storage is unavailable - the span was not stored; retry." });
    return;
  }

  if (!accepted) {
    // Explicit backpressure (ADR-0005): the queue is full, shed load visibly. The SDK backs
    // off and retries; nothing was stored, nothing is silently dropped.
    res.setHeader("Retry-After", "1");
    res.status(429).json({ error: "Ingest queue is full - retry with backoff (Retry-After: 1s)." });
    return;
  }

  // trace_id is the one field send_trace_sync() reads; `deduped` lets a re-sync importer skip
  // re-evaluating spans the engine already had. Acked once the span is accepted into the
  // bounded queue (ADR-0005: at-least-once, drained on shutdown) - the flush interval is
  // bounded, so the row is durable within AGENTX_INGEST_FLUSH_MS under normal operation.
  res.status(200).json({ trace_id: traceId, traceId, deduped });

  // The ack above already means "durably stored" (the queued path resolves on batch commit), so
  // the pipeline runs detached after responding, exactly as before the queue existed. A deduped
  // replay was already checked and judged on first arrival.
  if (!deduped) {
    runPipeline(traceId, agentId);
  }
});

// Not part of the SDK-compatible surface (the SDK only ever POSTs here, see the comment above),
// this is what AgentX-web-front's dashboard actually calls to list traces (Governance > Observe).
// Cursor-paginated, matching src/data/queries/evaluate/useGetProductionTraces.ts's params/
// response shape exactly, see core/trace/ingest.ts's listTracesPaginated.
ingestRouter.get("/traces", async (req: Request, res: Response) => {
  const { limit, cursor, framework, search, source } = req.query;
  const result = await listTracesPaginated(scopedDb(req), {
    limit: limit ? Number(limit) : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    framework: typeof framework === "string" ? framework : undefined,
    // "production" | "eval" | "all"; absent = all, for SDK/API compatibility. The dashboard's
    // Live Traces sends "production" by default.
    source: source === "production" || source === "eval" || source === "all" ? source : undefined,
    search: typeof search === "string" ? search : undefined,
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

// One-trace offline evaluation - the self-host backend for the SDK's
// tracer.evaluate_trace(trace_id, dataset_id) and the Moveworks importer's --evaluate-against:
// grade the trace's recorded input/output against the dataset/config's criteria as a real
// one-result run. See core/evaluate/runs.ts's evaluateTraceAgainst.
ingestRouter.post("/traces/:traceId/evaluate", async (req: Request, res: Response) => {
  const { traceId } = req.params;
  const targetId = typeof req.body?.datasetId === "string" ? req.body.datasetId : "";
  if (!traceId || !targetId) {
    res.status(400).json({ error: "traceId and datasetId are required" });
    return;
  }
  const outcome = await evaluateTraceAgainst(scopedDb(req), traceId, targetId);
  if ("error" in outcome) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  res.status(200).json(outcome);
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
