import { Router, type Request, type Response } from "express";
import { getDb } from "../storage/db.js";
import { ingestTraceSchema, ingestTrace, listTracesPaginated } from "../core/trace/ingest.js";
import { runMonitorCheck } from "../core/monitor/detect.js";

// Path matters here: AgentX-Python's IngestClient builds its endpoint as
// f"{base_url}/ingest/traces" (agentx/tracing/ingest_client.py). Mounting this router at
// /api/v1/ingest with a POST /traces route reproduces that exactly, so pointing the existing
// SDK at AGENTX_API_BASE_URL=http://localhost:<port>/api/v1 works with zero SDK changes.
export const ingestRouter = Router();

ingestRouter.post("/traces", async (req: Request, res: Response) => {
  const parsed = ingestTraceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid trace payload", details: parsed.error.flatten() });
    return;
  }
  const { traceId } = await ingestTrace(getDb(), parsed.data);

  // Mirrors tracer.trace(..., monitor=True, pattern_ids=[...]): checked synchronously here so a
  // caller polling client.monitor.signals right after this call (as the sample scripts do) sees
  // the result. No background job queue in self-host, see plan task #110.
  if (parsed.data.monitor) {
    await runMonitorCheck(
      getDb(),
      {
        input: parsed.data.input,
        output: parsed.data.output,
        error: parsed.data.error ?? null,
        toolCalls: (parsed.data.tool_calls as Array<{ name?: string; output?: unknown; input?: unknown; success?: boolean }>) ?? null,
        latencyMs: parsed.data.latency_ms ?? null,
      },
      { agentId: parsed.data.name, traceId, patternIds: parsed.data.pattern_ids }
    );
  }

  // trace_id is the one field send_trace_sync() reads (see ingest_client.py); the fire-and-forget
  // enqueue() path used by default doesn't inspect the body at all, so this shape covers both.
  res.status(200).json({ trace_id: traceId });
});

// Not part of the SDK-compatible surface (the SDK only ever POSTs here, see the comment above),
// this is what AgentX-web-front's dashboard actually calls to list traces (Governance > Observe).
// Cursor-paginated, matching src/data/queries/evaluate/useGetProductionTraces.ts's params/
// response shape exactly, see core/trace/ingest.ts's listTracesPaginated.
ingestRouter.get("/traces", async (req: Request, res: Response) => {
  const { limit, cursor, framework } = req.query;
  const result = await listTracesPaginated(getDb(), {
    limit: limit ? Number(limit) : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    framework: typeof framework === "string" ? framework : undefined,
  });
  res.status(200).json(result);
});
