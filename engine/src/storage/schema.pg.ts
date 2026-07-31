import { pgTable, text, integer, jsonb, timestamp, doublePrecision, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// Same shape as schema.sqlite.ts (see that file's note), pg-core column types instead of
// sqlite-core, so a self-host deployment can point AGENTX_DB_URL at a real Postgres instead
// of the default local SQLite file.
export const traces = pgTable("traces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  latencyMs: integer("latency_ms"),
  framework: text("framework"),
  model: text("model"),
  toolCalls: jsonb("tool_calls"),
  metadata: jsonb("metadata"),
  sessionId: text("session_id"),
  performanceSummary: jsonb("performance_summary"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const datasets = pgTable("datasets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  questions: jsonb("questions").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const evaluationSettings = pgTable("evaluation_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  judgePrompt: text("judge_prompt"),
  judgeModel: text("judge_model"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const evaluationRuns = pgTable("evaluation_runs", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  evaluationSubject: jsonb("evaluation_subject"),
  runSource: text("run_source"),
  sdkInfo: jsonb("sdk_info"),
  status: text("status").notNull().default("in_progress"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const evaluationRunResults = pgTable(
  "evaluation_run_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    batchId: text("batch_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    caseId: text("case_id"),
    questionIndex: integer("question_index"),
    runNumber: integer("run_number"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    rating: doublePrecision("rating"),
    justification: text("justification"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  },
  table => ({
    runIdempotencyUnique: uniqueIndex("evaluation_run_results_run_id_idempotency_key").on(
      table.runId,
      table.idempotencyKey
    ),
  })
);

// Monitor (plan task #110). See schema.sqlite.ts's note for the same tables: built-in checks
// aren't stored rows, only custom patterns/profiles/signals are.
export const monitorPatterns = pgTable("monitor_patterns", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  detectorKind: text("detector_kind").notNull().default("contains"),
  conditions: jsonb("conditions").notNull(),
  severity: text("severity").notNull().default("medium"),
  polarity: text("polarity").notNull().default("failure"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const monitorProfiles = pgTable(
  "monitor_profiles",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    failureDetectionEnabled: boolean("failure_detection_enabled").notNull().default(true),
    infoDetectionEnabled: boolean("info_detection_enabled").notNull().default(true),
    coverageMode: text("coverage_mode").notNull().default("all"),
    sampleRate: doublePrecision("sample_rate").notNull().default(1),
    retentionDays: integer("retention_days").notNull().default(30),
    redactionMode: text("redaction_mode").notNull().default("standard"),
    thresholdOverrides: jsonb("threshold_overrides"),
    approvalPolicy: jsonb("approval_policy"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  },
  table => ({
    agentIdUnique: uniqueIndex("monitor_profiles_agent_id").on(table.agentId),
  })
);

export const monitorSignals = pgTable(
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
    evidence: jsonb("evidence"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }).notNull(),
  },
  table => ({
    patternAgentUnique: uniqueIndex("monitor_signals_pattern_key_agent_id").on(table.patternKey, table.agentId),
  })
);

export type PgSchema = {
  traces: typeof traces;
  datasets: typeof datasets;
  evaluationSettings: typeof evaluationSettings;
  evaluationRuns: typeof evaluationRuns;
  evaluationRunResults: typeof evaluationRunResults;
  monitorPatterns: typeof monitorPatterns;
  monitorProfiles: typeof monitorProfiles;
  monitorSignals: typeof monitorSignals;
};
