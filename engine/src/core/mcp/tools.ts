import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../../storage/db.js";
import { getDb } from "../../storage/db.js";
import { engineVersion } from "../../version.js";
import { authMode } from "../../auth/mode.js";
import { logger } from "../../log.js";
import { recordAuditEvent } from "../audit/auditLog.js";
import { getProjectRow } from "../project/projects.js";
import { getTraceRow, listSessionSpans, listTracesPaginated, toTraceDetailWireWithCost } from "../trace/ingest.js";
import { listSessions } from "../monitor/sessions.js";
import { listSessionScores } from "../monitor/sessionScores.js";
import { getKpis, type MonitoringWindow } from "../monitor/events.js";
import { getSignal, listSignals } from "../monitor/signals.js";
import { listAgentsWire, resolveExistingAgentId } from "../monitor/agents.js";
import { getTopIntents } from "../monitor/topics.js";
import { getDataset, listDatasets } from "../evaluate/datasets.js";
import { getRun, listRuns } from "../evaluate/runs.js";
import { getPromptWithVersionsWire, listPromptsWire } from "../evaluate/prompts.js";
import { listToolSchemasWire } from "../evaluate/toolSchemas.js";
import { getCoverage } from "../insights/coverage.js";
import { probe } from "../insights/probe.js";

// The tool surface of the self-host MCP server. Names and argument shapes mirror the hosted
// AgentX MCP wherever the same concept exists, so a prompt or skill written against one works
// against the other. Every tool is read-only and calls the same core function the matching
// dashboard route calls, with the same project-scoped Db - the MCP is another client of the
// engine, never a side door.
//
// Results are returned as JSON text: Claude reads it fine, and structured output would demand a
// second, duplicated schema per tool that nothing else consumes yet.

export type McpPrincipal =
  | { kind: "project-key" }
  | { kind: "oauth"; clientId: string; userId: string | null; grantId: string };

export type McpContext = {
  db: Db;
  projectId: string;
  organizationId: string | null;
  principal: McpPrincipal;
  ip: string | null;
};

// Long payloads (a full agent transcript) blow past what a tool result should carry; list views
// clip them and say so, detail views return everything.
const CLIP = 600;
function clip(value: unknown): unknown {
  if (typeof value === "string" && value.length > CLIP) {
    return `${value.slice(0, CLIP)}... [${value.length - CLIP} more chars, use the detail tool]`;
  }
  return value;
}

function compactTrace<T extends { input?: unknown; output?: unknown; metadata?: unknown }>(trace: T): T {
  return { ...trace, input: clip(trace.input), output: clip(trace.output), metadata: undefined };
}

const window = z.enum(["24h", "7d", "30d"]).optional().describe("Time window (default 7d)");
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).optional().describe(`Max rows (default ${fallback}, max ${max})`);

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function notFound(what: string, id: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${what} ${id} was not found in this project` }] };
}

function actorOf(ctx: McpContext): { actor: string; actorType: "project-key" | "mcp-token" } {
  return ctx.principal.kind === "project-key"
    ? { actor: `project:${ctx.projectId}`, actorType: "project-key" }
    : { actor: ctx.principal.userId ? `user:${ctx.principal.userId}` : `project:${ctx.projectId}`, actorType: "mcp-token" };
}

export function registerTools(server: McpServer, ctx: McpContext): void {
  const { db } = ctx;

  // One registration helper so every tool gets the same three things: read-only annotation,
  // an error envelope instead of a protocol-level failure, and an audit row naming the tool,
  // the project and the principal (routes/auditTap.ts cannot see inside a JSON-RPC body).
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>
  ): void {
    server.registerTool(
      name,
      { description, inputSchema: shape as unknown as ZodRawShapeCompat, annotations: { readOnlyHint: true, openWorldHint: false } },
      (async (args: unknown) => {
        let result: CallToolResult;
        try {
          result = await handler(args as z.infer<z.ZodObject<S>>);
        } catch (err) {
          logger.error({ err, tool: name, projectId: ctx.projectId }, "MCP tool failed");
          result = { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
        }
        const { actor, actorType } = actorOf(ctx);
        void recordAuditEvent(getDb(), {
          actor,
          actorType,
          action: "mcp.tool_call",
          method: "POST",
          path: "/mcp",
          status: result.isError ? 500 : 200,
          entityType: "mcp_tool",
          entityId: name,
          summary: { tool: name, ...(ctx.principal.kind === "oauth" ? { clientId: ctx.principal.clientId } : {}) },
          ip: ctx.ip,
          projectId: ctx.projectId,
        }).catch((err: unknown) => logger.error({ err }, "MCP audit write failed (call unaffected)"));
        return result;
      }) as Parameters<McpServer["registerTool"]>[2]
    );
  }

  // ---- identity -------------------------------------------------------------------------

  tool("agentx_whoami", "Which AgentX project this connection is scoped to, how it authenticated, and the engine version.", {}, async () => {
    const project = await getProjectRow(db, ctx.projectId);
    return text({
      project: project ? { id: project.id, name: project.name } : null,
      organizationId: ctx.organizationId,
      authMode: authMode(),
      authenticatedWith: ctx.principal.kind === "project-key" ? "project API key" : "OAuth access token",
      engineVersion: engineVersion(),
    });
  });

  // ---- trace ----------------------------------------------------------------------------

  tool(
    "agentx_list_traces",
    "List recent traces (agent runs) in this project, newest first. Inputs/outputs are clipped; use agentx_get_trace for the full record.",
    {
      limit: limit(100, 20),
      cursor: z.string().optional().describe("nextCursor from a previous page"),
      search: z.string().optional().describe("Substring match on name, input or output"),
      framework: z.string().optional().describe("Filter by framework label, e.g. langchain"),
      source: z.enum(["production", "eval", "all"]).optional().describe("Traffic source (default all)"),
    },
    async args => {
      const page = await listTracesPaginated(db, { ...args, limit: args.limit ?? 20 });
      return text({ ...page, traces: page.traces.map(compactTrace) });
    }
  );

  tool("agentx_get_trace", "Full detail of one trace: input, output, tool calls, tokens, latency, estimated cost.", { traceId: z.string() }, async ({ traceId }) => {
    const row = await getTraceRow(db, traceId);
    if (!row) return notFound("Trace", traceId);
    return text(await toTraceDetailWireWithCost(db, row));
  });

  tool(
    "agentx_list_sessions",
    "Multi-turn sessions (traces sharing a session id) with turn counts and judge scores.",
    { window },
    async ({ window: w }) => text(await listSessions(db, (w ?? "7d") as MonitoringWindow))
  );

  tool(
    "agentx_get_session",
    "Every span of one session in order (clipped) plus the session-level judge verdicts.",
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const spans = await listSessionSpans(db, sessionId);
      if (spans.length === 0) return notFound("Session", sessionId);
      return text({ sessionId, spans: spans.map(compactTrace), scores: await listSessionScores(db, sessionId) });
    }
  );

  // ---- monitor --------------------------------------------------------------------------

  tool(
    "agentx_get_kpis",
    "Monitoring KPIs for the window: run volume, health/failure/downvote/tool-failure rates, p95 latency, deltas vs the previous window.",
    { window },
    async ({ window: w }) => text(await getKpis(db, (w ?? "7d") as MonitoringWindow))
  );

  tool(
    "agentx_list_signals",
    "Monitor signals (detected failure patterns, judge findings) with occurrence counts. Defaults to open failures.",
    {
      severity: z.enum(["low", "medium", "high", "critical"]).optional(),
      status: z.string().optional().describe("e.g. open, acknowledged, resolved"),
      agentId: z.string().optional().describe("Agent id or name"),
      polarity: z.enum(["failure", "success", "all"]).optional(),
      limit: limit(100, 20),
    },
    async args => {
      const signals = await listSignals(
        db,
        {
          severity: args.severity,
          status: args.status,
          agentId: args.agentId ? await resolveExistingAgentId(db, args.agentId) : undefined,
          polarity: args.polarity,
        },
        args.limit ?? 20
      );
      return text({ signals });
    }
  );

  tool("agentx_get_signal", "One signal with its occurrences and the evidence behind them.", { signalId: z.string() }, async ({ signalId }) => {
    const signal = await getSignal(db, signalId);
    return signal ? text(signal) : notFound("Signal", signalId);
  });

  tool("agentx_list_agents", "Agents that have reported traces into this project, with per-agent monitoring profile summary.", {}, async () =>
    text({ agents: await listAgentsWire(db) })
  );

  tool(
    "agentx_list_topics",
    "What users actually ask about: top classified intents in the window (Topics must be enabled on the project).",
    { window, limit: limit(50, 10) },
    async ({ window: w, limit: n }) => text({ topics: await getTopIntents(db, (w ?? "7d") as MonitoringWindow, n ?? 10) })
  );

  // ---- evaluate -------------------------------------------------------------------------

  tool("agentx_list_datasets", "Evaluation datasets in this project (case counts, scorer config; cases omitted).", {}, async () => {
    const datasets = await listDatasets(db);
    return text({
      datasets: datasets.map(({ questions, ...rest }) => ({
        ...rest,
        caseCount: Array.isArray(questions) ? questions.length : 0,
      })),
    });
  });

  tool("agentx_get_dataset", "One dataset including every case (question, expected result, metadata).", { datasetId: z.string() }, async ({ datasetId }) => {
    const dataset = await getDataset(db, datasetId);
    return dataset ? text(dataset) : notFound("Dataset", datasetId);
  });

  tool(
    "agentx_list_evaluations",
    "Evaluation runs, newest first, with average ratings and per-scorer breakdown (results omitted).",
    { limit: limit(100, 20) },
    async ({ limit: n }) => {
      const runs = await listRuns(db, n ?? 20);
      return text({ evaluations: runs.map(run => ({ ...run, results: undefined })) });
    }
  );

  tool(
    "agentx_get_evaluation",
    "One evaluation run: summary, scorer breakdown and (by default) every scored result.",
    { evaluationId: z.string(), includeResults: z.boolean().optional().describe("Default true") },
    async ({ evaluationId, includeResults }) => {
      const run = await getRun(db, evaluationId);
      if (!run) return notFound("Evaluation", evaluationId);
      return text(includeResults === false ? { ...run, results: undefined } : run);
    }
  );

  tool("agentx_list_prompts", "Prompt Registry entries (name, current version, timestamps).", {}, async () => text({ prompts: await listPromptsWire(db) }));

  tool("agentx_get_prompt", "One prompt with every version's text, source and reasoning.", { promptId: z.string() }, async ({ promptId }) => {
    const prompt = await getPromptWithVersionsWire(db, promptId);
    return prompt ? text(prompt) : notFound("Prompt", promptId);
  });

  tool("agentx_list_tool_schemas", "Tool Schema registry entries with current version and quality signal counts.", {}, async () =>
    text({ toolSchemas: await listToolSchemasWire(db) })
  );

  // ---- insights -------------------------------------------------------------------------

  tool(
    "agentx_get_coverage",
    "How well the datasets cover production topics: traffic-weighted, breadth and risk-weighted coverage with per-topic state.",
    { window, datasetIds: z.array(z.string()).optional().describe("Restrict to these datasets (default all)") },
    async ({ window: w, datasetIds }) => text(await getCoverage(db, { window: (w ?? "30d") as MonitoringWindow, datasetIds }))
  );

  tool(
    "agentx_probe_coverage",
    "Ask whether the datasets already cover one specific user query: covered, adjacent, gap, or not asked in production.",
    {
      query: z.string().min(1),
      window,
      datasetIds: z.array(z.string()).optional(),
    },
    async ({ query, window: w, datasetIds }) => text(await probe(db, { query, window: (w ?? "30d") as MonitoringWindow, datasetIds }))
  );
}
