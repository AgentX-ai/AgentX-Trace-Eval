import { z } from "zod";

// The wire contract for the dashboard surfaces most prone to drift. These schemas are the
// single written form of each response shape: the contract integration test
// (src/test/contract.integration.test.ts) parses LIVE engine responses with them, and
// GET /api/v1/openapi.json (routes/openapi.ts) publishes them, so the frontend's hand-written
// types and the Python SDK have one authority to check against instead of three hand-copies
// drifting apart (the `{ monitoringDefaults }` wrapper and the metrics `end` field both bit us
// exactly that way).
//
// Every object is `.strict()`: a field the engine starts sending that the schema doesn't list
// FAILS the contract test - adding a wire field requires updating the contract in the same
// commit, which is the point.

const isoDate = z.string().refine(v => !Number.isNaN(Date.parse(v)), "not an ISO date-time");

// ---- GET /agent-monitoring/metrics -----------------------------------------------------------

export const monitorMetricsBucketSchema = z
  .object({
    ts: z.number(),
    spansLlm: z.number(),
    spansTool: z.number(),
    spansOther: z.number(),
    traces: z.number(),
    errors: z.number(),
    latencyP50: z.number().nullable(),
    latencyP95: z.number().nullable(),
    tokensPrompt: z.number(),
    tokensCompletion: z.number(),
    costPrompt: z.number(),
    costCached: z.number(),
    costCompletion: z.number(),
    toolCalls: z.number(),
    toolFailures: z.number(),
    byTool: z.record(z.number()),
    byModelCost: z.record(z.number()),
  })
  .strict();

export const monitorMetricsResponseSchema = z
  .object({
    window: z.string(),
    bucketMs: z.number(),
    start: z.number(),
    end: z.number(),
    buckets: z.array(monitorMetricsBucketSchema),
    totals: monitorMetricsBucketSchema.omit({ ts: true, byTool: true, byModelCost: true }).strict(),
    tools: z.array(z.object({ name: z.string(), count: z.number(), failed: z.number() }).strict()),
    models: z.array(z.object({ name: z.string(), cost: z.number(), tokens: z.number() }).strict()),
    facets: z
      .object({ agents: z.array(z.string()), models: z.array(z.string()), tools: z.array(z.string()) })
      .strict(),
  })
  .strict();

// ---- monitoring defaults (GET /agent-monitoring/settings, PUT .../monitoring-defaults) -------

export const monitoringDefaultsSchema = z
  .object({
    // Legacy pair: still on the wire for old clients, read by nothing (see projects.ts).
    coverageMode: z.string(),
    sampleRate: z.number(),
    retentionDays: z.number(),
    latencyThresholdMs: z.number(),
    topicsEnabled: z.boolean(),
    topicsSampleRate: z.number().min(0).max(1),
    coherenceSweepEnabled: z.boolean(),
    enabledBuiltinPatterns: z.array(z.string()),
  })
  .strict();

export const settingsResponseSchema = z
  .object({
    apiKey: z.string().nullable(),
    monitoringDefaults: monitoringDefaultsSchema,
    llm: z.record(z.object({ configured: z.boolean(), masked: z.string().nullable() }).strict()),
  })
  .strict();

export const monitoringDefaultsPutResponseSchema = z.object({ monitoringDefaults: monitoringDefaultsSchema }).strict();

// ---- GET /ingest/traces ----------------------------------------------------------------------

export const traceListItemSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    latencyMs: z.number().optional(),
    error: z.string().optional(),
    framework: z.string().optional(),
    model: z.string().optional(),
    toolCalls: z.unknown().optional(),
    sessionId: z.string().optional(),
    spanId: z.string().optional(),
    // Always present and always resolved (core/trace/spanKind.ts): the engine classifies each
    // span once so no reader has to re-derive it. Never optional - "chain" is the answer for a
    // span nothing could be said about, not an absent field.
    spanKind: z.enum(["agent", "llm", "tool", "retrieval", "chain", "embedding", "reranker", "guardrail", "evaluator", "prompt"]),
    parentSpanId: z.string().optional(),
    startedAt: isoDate.optional(),
    source: z.literal("sdk"),
    createdAt: isoDate,
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
  })
  .strict();

export const tracesPageSchema = z
  .object({
    traces: z.array(traceListItemSchema),
    hasNextPage: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();

// ---- GET /agent-monitoring/signals -----------------------------------------------------------

const populatedAgentRef = z.object({ _id: z.string(), name: z.string() }).strict();

export const signalOccurrenceSchema = z
  .object({
    id: z.string(),
    agentId: populatedAgentRef.optional(),
    traceId: z.string().optional(),
    sessionId: z.string().optional(),
    seenAt: isoDate,
    query: z.string().optional(),
    responsePreview: z.string().optional(),
    rating: z.number().optional(),
    justification: z.string().optional(),
  })
  .strict();

export const signalSchema = z
  .object({
    _id: z.string(),
    workspaceId: z.string(),
    patternKey: z.string(),
    type: z.string(),
    severity: z.string(),
    polarity: z.string(),
    status: z.string(),
    reviewStatus: z.string().optional(),
    recommendedActions: z.unknown().optional(),
    summary: z.string(),
    rootCause: z.string().optional(),
    agentId: populatedAgentRef.optional(),
    evidence: z.unknown().optional(),
    occurrenceCount: z.number(),
    occurrences: z.array(signalOccurrenceSchema),
    firstSeenAt: isoDate,
    lastSeenAt: isoDate,
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();

export const signalsResponseSchema = z.object({ signals: z.array(signalSchema) }).strict();

// ---- GET /agent-monitoring/review-queue -------------------------------------------------------

export const reviewQueueItemSchema = z
  .object({
    _id: z.string(),
    traceId: z.string(),
    sessionId: z.string().optional(),
    source: z.enum(["manual", "rule", "signal"]),
    status: z.enum(["pending", "labeled", "skipped"]),
    label: z.enum(["good", "bad"]).optional(),
    correctedScore: z.number().nullable(),
    judgeScoreAtQueue: z.number().nullable(),
    note: z.string().optional(),
    reviewedBy: z.string().optional(),
    reviewedAt: isoDate.nullable(),
    createdAt: isoDate,
    trace: z
      .object({
        agentName: z.string().optional(),
        query: z.string(),
        responsePreview: z.string(),
        error: z.string().optional(),
        model: z.string().optional(),
        latencyMs: z.number().nullable(),
        seenAt: isoDate.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

// ---- GET /agent-monitoring/rules --------------------------------------------------------------

export const ruleSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    filter: z
      .object({
        scopeMode: z.enum(["all", "selected"]).optional(),
        agentIds: z.array(z.string()).optional(),
        model: z.string().optional(),
        status: z.enum(["any", "error"]).optional(),
        contains: z.string().optional(),
      })
      .strict(),
    sampleRate: z.number(),
    action: z.enum(["review", "dataset", "webhook"]),
    actionConfig: z.object({ datasetId: z.string().optional(), url: z.string().optional() }).strict(),
    firedCount: z.number(),
    lastFiredAt: isoDate.nullable(),
    createdAt: isoDate,
  })
  .strict();

export const rulesResponseSchema = z.object({ rules: z.array(ruleSchema) }).strict();

export const reviewQueueResponseSchema = z
  .object({ items: z.array(reviewQueueItemSchema), pending: z.number(), cap: z.number() })
  .strict();

// ---- GET /evaluate/runs/pairwise --------------------------------------------------------------

export const pairwiseSummarySchema = z
  .object({
    total: z.number(),
    aWins: z.number(),
    bWins: z.number(),
    ties: z.number(),
    winner: z.enum(["a", "b", "tie"]),
    // null unless the batch judged both orders - there is no flip rate to report otherwise.
    flipRate: z.number().nullable(),
  })
  .strict();

export const pairwiseBatchSummarySchema = z
  .object({
    batchId: z.string(),
    runAId: z.string(),
    runBId: z.string(),
    judgeModel: z.string().nullable(),
    summary: pairwiseSummarySchema,
    createdAt: isoDate,
  })
  .strict();

export const pairwiseListResponseSchema = z.object({ comparisons: z.array(pairwiseBatchSummarySchema) }).strict();

// ---- GET /agent-monitoring/judge-scorers -----------------------------------------------------

export const judgeScorerSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    seeded: z.boolean(),
    judge: z
      .object({
        acceptanceCriteria: z.string().optional(),
        rejectionCriteria: z.string().optional(),
        evaluationCriteria: z.string().optional(),
        judgePrompt: z.string().optional(),
        judgeModel: z.string().optional(),
        toolContext: z.enum(["none", "simple", "detailed"]),
        // Reference-centric rubric: offline-only, online enable is a 409.
        requiresExpected: z.boolean(),
      })
      .strict(),
    offline: z
      .object({
        numberOfRequests: z.number(),
        vectorSimilarity: z.unknown().optional(),
        jaccardSimilarity: z.unknown().optional(),
        bleuScore: z.unknown().optional(),
        rougeScore: z.unknown().optional(),
        thresholds: z.unknown().optional(),
        sovereigntyIndex: z.unknown().optional(),
        codeScorers: z.unknown().optional(),
        isDefault: z.boolean(),
        status: z.string(),
      })
      .strict(),
    online: z
      .object({
        profileId: z.string(),
        enabled: z.boolean(),
        sampleRate: z.number(),
        scopeMode: z.string(),
        agentIds: z.array(z.string()),
        alertThreshold: z.number(),
        severity: z.string(),
        scope: z.string(),
        idleSeconds: z.number(),
        builtinKey: z.string().optional(),
      })
      .strict()
      .nullable(),
    createdAt: isoDate,
    versionCount: z.number(),
  })
  .strict();

export const judgeScorersResponseSchema = z.object({ judgeScorers: z.array(judgeScorerSchema) }).strict();

// ---- registry --------------------------------------------------------------------------------

// What /api/v1/openapi.json publishes and the contract test iterates. Grows a row per surface
// as coverage expands; adding a row is all it takes to put an endpoint under contract.
export const WIRE_CONTRACT = [
  {
    method: "get" as const,
    path: "/agent-monitoring/metrics",
    summary: "Bucketed monitor metrics for the dashboard grid",
    response: monitorMetricsResponseSchema,
    name: "MonitorMetricsResponse",
  },
  {
    method: "get" as const,
    path: "/agent-monitoring/settings",
    summary: "Project settings incl. monitoring defaults and LLM key status",
    response: settingsResponseSchema,
    name: "SettingsResponse",
  },
  {
    method: "put" as const,
    path: "/agent-monitoring/settings/monitoring-defaults",
    summary: "Patch project monitoring defaults",
    response: monitoringDefaultsPutResponseSchema,
    name: "MonitoringDefaultsPutResponse",
  },
  {
    method: "get" as const,
    path: "/ingest/traces",
    summary: "Cursor-paginated trace list with database-side search",
    response: tracesPageSchema,
    name: "TracesPage",
  },
  {
    method: "get" as const,
    path: "/agent-monitoring/signals",
    summary: "Monitoring signals",
    response: signalsResponseSchema,
    name: "SignalsResponse",
  },
  {
    method: "get" as const,
    path: "/agent-monitoring/rules",
    summary: "Automation rules: filter + sample + route",
    response: rulesResponseSchema,
    name: "RulesResponse",
  },
  {
    method: "get" as const,
    path: "/evaluate/runs/pairwise",
    summary: "Head-to-head comparisons between two evaluation runs",
    response: pairwiseListResponseSchema,
    name: "PairwiseListResponse",
  },
  {
    method: "get" as const,
    path: "/agent-monitoring/review-queue",
    summary: "Human-review queue for traces that raised no signal",
    response: reviewQueueResponseSchema,
    name: "ReviewQueueResponse",
  },
  {
    method: "get" as const,
    path: "/agent-monitoring/judge-scorers",
    summary: "Judge scorer catalog",
    response: judgeScorersResponseSchema,
    name: "JudgeScorersResponse",
  },
];
