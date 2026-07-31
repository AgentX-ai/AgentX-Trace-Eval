import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

// First vertical slice: just enough to prove Trace ingest end-to-end (CLI -> engine -> DB ->
// SDK-compatible response). Evaluate/Monitor tables land alongside their own core ports
// (see plan tasks #109/#110); this file grows, it isn't the final schema.
export const traces = sqliteTable("traces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  input: text("input", { mode: "json" }),
  output: text("output", { mode: "json" }),
  error: text("error"),
  latencyMs: integer("latency_ms"),
  framework: text("framework"),
  model: text("model"),
  toolCalls: text("tool_calls", { mode: "json" }),
  metadata: text("metadata", { mode: "json" }),
  sessionId: text("session_id"),
  performanceSummary: text("performance_summary", { mode: "json" }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Evaluate (plan task #109). Mirrors the hosted SaaS's Dataset (questions/test cases) vs
// EvaluationSettings (grading config) split, since the AgentX-Python SDK's init_run(dataset_id,
// evaluation_settings_id=...) expects both to be independently creatable/referenceable.
export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  // Array of { main_question: { query, expectedResults, judgeGuideline }, follow_up_questions: [] }
  // matching the SDK's DatasetQuestion/TestCase shape.
  questions: text("questions", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const evaluationSettings = sqliteTable("evaluation_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  // Null means "use the built-in default" (see core/evaluate/judge.ts), same convention as the
  // hosted SaaS's EvaluationSettings.judgePrompt/judgeModel.
  judgePrompt: text("judge_prompt"),
  judgeModel: text("judge_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const evaluationRuns = sqliteTable("evaluation_runs", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  evaluationSubject: text("evaluation_subject", { mode: "json" }),
  runSource: text("run_source"),
  sdkInfo: text("sdk_info", { mode: "json" }),
  status: text("status").notNull().default("in_progress"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const evaluationRunResults = sqliteTable(
  "evaluation_run_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    batchId: text("batch_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    caseId: text("case_id"),
    questionIndex: integer("question_index"),
    runNumber: integer("run_number"),
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    error: text("error", { mode: "json" }),
    rating: real("rating"),
    justification: text("justification"),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => ({
    // Idempotency: re-submitting the same idempotencyKey for a run returns the existing score
    // instead of re-scoring, matching the hosted SaaS's dedup behavior in POST /runs/:id/results.
    runIdempotencyUnique: uniqueIndex("evaluation_run_results_run_id_idempotency_key").on(
      table.runId,
      table.idempotencyKey
    ),
  })
);

// Monitor (plan task #110). Built-in checks (empty response, trace error, tool failure, latency
// regression) aren't stored rows, they're evaluated in code (see core/monitor/detect.ts) against
// each ingested trace; only custom patterns are persisted here.
export const monitorPatterns = sqliteTable("monitor_patterns", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  detectorKind: text("detector_kind").notNull().default("contains"),
  // Array of AgentMonitoringPatternCondition: { connector, negate, sources, detector, value,
  // caseSensitive }, evaluated by core/monitor/conditions.ts's evaluatePatternConditions.
  conditions: text("conditions", { mode: "json" }).notNull(),
  severity: text("severity").notNull().default("medium"),
  polarity: text("polarity").notNull().default("failure"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const monitorProfiles = sqliteTable(
  "monitor_profiles",
  {
    id: text("id").primaryKey(),
    // Self-host has no agent registry, this is just whatever id string the caller uses
    // (client.monitor.profile.get/update(agent_id)), scoped per that string.
    agentId: text("agent_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    failureDetectionEnabled: integer("failure_detection_enabled", { mode: "boolean" }).notNull().default(true),
    infoDetectionEnabled: integer("info_detection_enabled", { mode: "boolean" }).notNull().default(true),
    coverageMode: text("coverage_mode").notNull().default("all"),
    sampleRate: real("sample_rate").notNull().default(1),
    retentionDays: integer("retention_days").notNull().default(30),
    redactionMode: text("redaction_mode").notNull().default("standard"),
    // e.g. { latencyMs: 15000 } to override the built-in "Latency regression" pattern's default.
    thresholdOverrides: text("threshold_overrides", { mode: "json" }),
    approvalPolicy: text("approval_policy", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => ({
    agentIdUnique: uniqueIndex("monitor_profiles_agent_id").on(table.agentId),
  })
);

export const monitorSignals = sqliteTable(
  "monitor_signals",
  {
    id: text("id").primaryKey(),
    patternKey: text("pattern_key").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    polarity: text("polarity").notNull().default("failure"),
    status: text("status").notNull().default("open"),
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    agentId: text("agent_id"),
    traceId: text("trace_id"),
    evidence: text("evidence", { mode: "json" }),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => ({
    // Dedup key: a re-detected signal for the same pattern (scoped to the same agent, since
    // self-host doesn't group across agents the way the hosted SaaS's platform-wide patterns do)
    // increments occurrenceCount instead of creating a new row.
    patternAgentUnique: uniqueIndex("monitor_signals_pattern_key_agent_id").on(table.patternKey, table.agentId),
  })
);

export type SqliteSchema = {
  traces: typeof traces;
  datasets: typeof datasets;
  evaluationSettings: typeof evaluationSettings;
  evaluationRuns: typeof evaluationRuns;
  evaluationRunResults: typeof evaluationRunResults;
  monitorPatterns: typeof monitorPatterns;
  monitorProfiles: typeof monitorProfiles;
  monitorSignals: typeof monitorSignals;
};
