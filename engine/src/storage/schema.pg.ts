import { pgTable, text, integer, jsonb, timestamp, doublePrecision, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// See schema.sqlite.ts's projects table for the full comment.
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull(),
  // See schema.sqlite.ts's projects.isDefault for the full comment.
  isDefault: boolean("is_default").notNull().default(false),
  // See schema.sqlite.ts's projects.coverageMode block for the full comment.
  coverageMode: text("coverage_mode").notNull().default("all"),
  sampleRate: doublePrecision("sample_rate").notNull().default(1),
  retentionDays: integer("retention_days").notNull().default(30),
  redactionMode: text("redaction_mode").notNull().default("standard"),
  latencyThresholdMs: integer("latency_threshold_ms").notNull().default(20000),
  topicsEnabled: boolean("topics_enabled").notNull().default(false),
  coherenceSweepEnabled: boolean("coherence_sweep_enabled").notNull().default(true),
  disabledBuiltinPatterns: jsonb("disabled_builtin_patterns"),
  organizationId: text("organization_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

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
  // See schema.sqlite.ts's traces.cacheReadTokens/cacheWriteTokens for the full comment.
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  // See schema.sqlite.ts's traces.spanId/parentSpanId/startedAt for the full comment.
  spanId: text("span_id"),
  parentSpanId: text("parent_span_id"),
  startedAt: timestamp("started_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  // See schema.sqlite.ts's traces.agentId for the full comment.
  agentId: text("agent_id"),
  // See schema.sqlite.ts's traces.projectId for the full comment.
  projectId: text("project_id"),
});

// See schema.sqlite.ts's agents table for the full comment.
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const datasets = pgTable("datasets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  numberOfRequests: integer("number_of_requests").notNull().default(1),
  // See schema.sqlite.ts's datasets.similarityConfig for the exact shape.
  similarityConfig: jsonb("similarity_config"),
  // See schema.sqlite.ts's datasets.codeScorers for the exact shape.
  codeScorers: jsonb("code_scorers"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  questions: jsonb("questions").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const evaluationSettings = pgTable("evaluation_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  numberOfRequests: integer("number_of_requests").notNull().default(1),
  similarityConfig: jsonb("similarity_config"),
  codeScorers: jsonb("code_scorers"),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  judgePrompt: text("judge_prompt"),
  judgeModel: text("judge_model"),
  isDefault: boolean("is_default").notNull().default(false),
  status: text("status").notNull().default("published"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const evaluationRuns = pgTable("evaluation_runs", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  evaluationSubject: jsonb("evaluation_subject"),
  // See schema.sqlite.ts's evaluationRuns.version for the full comment.
  version: text("version"),
  runSource: text("run_source"),
  sdkInfo: jsonb("sdk_info"),
  smokeTestVariants: jsonb("smoke_test_variants"),
  status: text("status").notNull().default("in_progress"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
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
    traceId: text("trace_id"),
    isSmokeTestVariant: boolean("is_smoke_test_variant").notNull().default(false),
    smokeTestVariantText: text("smoke_test_variant_text"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    vectorSimilarity: doublePrecision("vector_similarity"),
    jaccardSimilarity: doublePrecision("jaccard_similarity"),
    bleuScore: doublePrecision("bleu_score"),
    rougeScore: doublePrecision("rouge_score"),
    // See schema.sqlite.ts's evaluationRunResults.codeScorerResults for the exact shape.
    codeScorerResults: jsonb("code_scorer_results"),
    rating: doublePrecision("rating"),
    justification: text("justification"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    projectId: text("project_id"),
  },
  table => ({
    runIdempotencyUnique: uniqueIndex("evaluation_run_results_run_id_idempotency_key").on(
      table.runId,
      table.idempotencyKey
    ),
  })
);

// See schema.sqlite.ts's datasetVersions/evaluationSettingsVersions for the full comment.
export const datasetVersions = pgTable("dataset_versions", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  changeSummary: text("change_summary"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const evaluationSettingsVersions = pgTable("evaluation_settings_versions", {
  id: text("id").primaryKey(),
  evaluationSettingsId: text("evaluation_settings_id").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  changeSummary: text("change_summary"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's playgroundRuns for the full comment.
export const playgroundRuns = pgTable("playground_runs", {
  id: text("id").primaryKey(),
  kind: text("kind"),
  snapshot: jsonb("snapshot").notNull(),
  results: jsonb("results").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
  promptId: text("prompt_id"),
});

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
  sampleRate: doublePrecision("sample_rate").notNull().default(1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: jsonb("agent_ids"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const monitorProfiles = pgTable(
  "monitor_profiles",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    failureDetectionEnabled: boolean("failure_detection_enabled").notNull().default(true),
    infoDetectionEnabled: boolean("info_detection_enabled").notNull().default(true),
    // See schema.sqlite.ts's monitorProfiles.topicsEnabled for the full comment.
    topicsEnabled: boolean("topics_enabled").notNull().default(false),
    coverageMode: text("coverage_mode").notNull().default("all"),
    sampleRate: doublePrecision("sample_rate").notNull().default(1),
    retentionDays: integer("retention_days").notNull().default(30),
    redactionMode: text("redaction_mode").notNull().default("standard"),
    thresholdOverrides: jsonb("threshold_overrides"),
    approvalPolicy: jsonb("approval_policy"),
    channels: jsonb("channels"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
    projectId: text("project_id"),
  },
  table => ({
    agentIdUnique: uniqueIndex("monitor_profiles_agent_id").on(table.projectId, table.agentId),
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
    reviewStatus: text("review_status"),
    recommendedActions: jsonb("recommended_actions"),
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    agentId: text("agent_id"),
    traceId: text("trace_id"),
    evidence: jsonb("evidence"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }).notNull(),
    projectId: text("project_id"),
  },
  table => ({
    patternAgentUnique: uniqueIndex("monitor_signals_pattern_key_agent_id").on(
      table.projectId,
      table.patternKey,
      table.agentId
    ),
  })
);

export const monitorSignalFeedback = pgTable("monitor_signal_feedback", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  // See schema.sqlite.ts's monitorSignalFeedback.eventId for the full comment.
  eventId: text("event_id"),
  metric: text("metric").notNull(),
  originalScore: doublePrecision("original_score"),
  correctedScore: doublePrecision("corrected_score"),
  rationale: text("rationale").notNull(),
  queuedForAutotune: boolean("queued_for_autotune").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's monitorEvents for the full comment.
export const monitorEvents = pgTable("monitor_events", {
  id: text("id").primaryKey(),
  signalId: text("signal_id"),
  patternKey: text("pattern_key").notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  polarity: text("polarity").notNull(),
  agentId: text("agent_id"),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  onlineEvaluatorId: text("online_evaluator_id"),
  rating: doublePrecision("rating"),
  justification: text("justification"),
  customEvaluatorId: text("custom_evaluator_id"),
  matched: boolean("matched"),
  // See schema.sqlite.ts's monitorEvents for the full comment.
  score: doublePrecision("score"),
  sessionId: text("session_id"),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's monitorClassifications for the full comment.
export const monitorClassifications = pgTable("monitor_classifications", {
  id: text("id").primaryKey(),
  traceId: text("trace_id"),
  agentId: text("agent_id"),
  intent: text("intent").notNull(),
  sentiment: text("sentiment").notNull(),
  issueType: text("issue_type").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
  // See schema.sqlite.ts's embedding column for the full comment.
  embedding: jsonb("embedding"),
});

// See schema.sqlite.ts's monitorOnlineEvaluators for the full comment.
export const monitorOnlineEvaluators = pgTable("monitor_online_evaluators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  sampleRate: doublePrecision("sample_rate").notNull().default(0.1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: jsonb("agent_ids"),
  enabled: boolean("enabled").notNull().default(true),
  alertThreshold: doublePrecision("alert_threshold").default(5),
  severity: text("severity").notNull().default("medium"),
  scope: text("scope").notNull().default("trace"),
  idleSeconds: integer("idle_seconds").notNull().default(120),
  builtinKey: text("builtin_key"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's customEvaluators for the full comment.
export const customEvaluators = pgTable("custom_evaluators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  sampleRate: doublePrecision("sample_rate").notNull().default(0.1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: jsonb("agent_ids"),
  enabled: boolean("enabled").notNull().default(true),
  invertMatch: boolean("invert_match").notNull().default(false),
  severity: text("severity").notNull().default("medium"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's agentConnectors for the full comment.
export const agentConnectors = pgTable("agent_connectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  headers: jsonb("headers"),
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's outcomeReports for the full comment.
export const outcomeReports = pgTable("outcome_reports", {
  id: text("id").primaryKey(),
  traceId: text("trace_id"),
  evaluationRunResultId: text("evaluation_run_result_id"),
  outcome: text("outcome").notNull(),
  isNegative: boolean("is_negative").notNull(),
  reason: text("reason"),
  reportedBy: text("reported_by"),
  reportedAt: timestamp("reported_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's userFeedback for the full comment.
export const userFeedback = pgTable("user_feedback", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  rating: text("rating").notNull(),
  comment: text("comment"),
  endUserId: text("end_user_id"),
  createdAt: timestamp("created_at").notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's improvementProposals for the full comment.
export const improvementProposals = pgTable("improvement_proposals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name").notNull(),
  status: text("status").notNull(),
  triggerReason: text("trigger_reason").notNull(),
  currentText: text("current_text").notNull(),
  proposal: jsonb("proposal").notNull(),
  validation: jsonb("validation"),
  createdAt: timestamp("created_at").notNull(),
  resolvedAt: timestamp("resolved_at"),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's gateResults for the full comment.
export const gateResults = pgTable("gate_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  datasetId: text("dataset_id").notNull(),
  passed: boolean("passed").notNull(),
  averageRating: doublePrecision("average_rating"),
  baselineRunId: text("baseline_run_id"),
  baselineAverage: doublePrecision("baseline_average"),
  checks: jsonb("checks"),
  caller: text("caller"),
  createdAt: timestamp("created_at").notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's sweepLeases for the full comment.
export const sweepLeases = pgTable("sweep_leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
});

// See schema.sqlite.ts's sessionScores for the full comment.
export const sessionScores = pgTable("session_scores", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  kind: text("kind").notNull(),
  rating: doublePrecision("rating"),
  justification: text("justification"),
  driftSpanId: text("drift_span_id"),
  findings: jsonb("findings"),
  spanCount: integer("span_count").notNull(),
  judgeModel: text("judge_model").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's toolSchemas/toolSchemaVersions for the full comment.
export const toolSchemas = pgTable("tool_schemas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  testEndpointUrl: text("test_endpoint_url"),
  resolvedEvidence: jsonb("resolved_evidence"),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const toolSchemaVersions = pgTable("tool_schema_versions", {
  id: text("id").primaryKey(),
  toolSchemaId: text("tool_schema_id").notNull(),
  version: integer("version").notNull(),
  definition: text("definition").notNull(),
  source: text("source").notNull().default("manual"),
  reasoning: text("reasoning"),
  basedOnVersion: integer("based_on_version"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's prompts/promptVersions for the full comment.
export const prompts = pgTable("prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id").notNull(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    source: text("source").notNull().default("manual"),
    reasoning: text("reasoning"),
    basedOnVersion: integer("based_on_version"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    projectId: text("project_id"),
  },
  table => ({
    promptVersionUnique: uniqueIndex("prompt_versions_prompt_id_version").on(
      table.projectId,
      table.promptId,
      table.version
    ),
  })
);

// See schema.sqlite.ts's portabilityModels for the full comment - deliberately instance-wide, not
// project-scoped.
export const portabilityModels = pgTable("portability_models", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  pricePerMInputTokens: doublePrecision("price_per_m_input_tokens").notNull(),
  pricePerMOutputTokens: doublePrecision("price_per_m_output_tokens").notNull(),
  // See schema.sqlite.ts's portabilityModels for the full comment on the fallback-to-input-rate
  // behavior when these are null.
  pricePerMCacheReadTokens: doublePrecision("price_per_m_cache_read_tokens"),
  pricePerMCacheWriteTokens: doublePrecision("price_per_m_cache_write_tokens"),
  isDefault: boolean("is_default").notNull().default(false),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

// See schema.sqlite.ts's evaluationAnalyses for the full explanation.
export const evaluationAnalyses = pgTable("evaluation_analyses", {
  evaluationId: text("evaluation_id").primaryKey(),
  status: text("status").notNull(),
  judgeModel: text("judge_model").notNull(),
  judgeModels: jsonb("judge_models"),
  analysis: jsonb("analysis"),
  statistics: jsonb("statistics"),
  judgeEvidence: jsonb("judge_evidence"),
  error: text("error"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  projectId: text("project_id"),
});

// See schema.sqlite.ts's appSettings for the full comment - deliberately instance-wide, not
// project-scoped.
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey(),
  openaiApiKey: text("openai_api_key"),
  anthropicApiKey: text("anthropic_api_key"),
  geminiApiKey: text("gemini_api_key"),
  authSecret: text("auth_secret"),
  metricPackSeededAt: timestamp("metric_pack_seeded_at", { mode: "date" }),
  metricPackVersion: integer("metric_pack_version"),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

// See schema.sqlite.ts's auth block for the full comment (better-auth core + organization
// plugin tables, auth_* model names).
export const authUsers = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

export const authSessions = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull(),
  activeOrganizationId: text("active_organization_id"),
});

export const authAccounts = pgTable("auth_account", {
  id: text("id").primaryKey(),
  // See schema.sqlite.ts's authAccounts.issuer for why this exists and why it is nullable.
  issuer: text("issuer"),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
});

export const authVerifications = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

export const authOrganizations = pgTable("auth_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  metadata: text("metadata"),
});

export const authMembers = pgTable("auth_member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const authInvitations = pgTable("auth_invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  // See schema.sqlite.ts's authInvitations.createdAt.
  createdAt: timestamp("created_at"),
  inviterId: text("inviter_id").notNull(),
});

export type PgSchema = {
  projects: typeof projects;
  traces: typeof traces;
  agents: typeof agents;
  datasets: typeof datasets;
  evaluationSettings: typeof evaluationSettings;
  evaluationRuns: typeof evaluationRuns;
  evaluationRunResults: typeof evaluationRunResults;
  datasetVersions: typeof datasetVersions;
  evaluationSettingsVersions: typeof evaluationSettingsVersions;
  playgroundRuns: typeof playgroundRuns;
  monitorSignalFeedback: typeof monitorSignalFeedback;
  monitorPatterns: typeof monitorPatterns;
  monitorProfiles: typeof monitorProfiles;
  monitorSignals: typeof monitorSignals;
  monitorEvents: typeof monitorEvents;
  monitorClassifications: typeof monitorClassifications;
  monitorOnlineEvaluators: typeof monitorOnlineEvaluators;
  customEvaluators: typeof customEvaluators;
  agentConnectors: typeof agentConnectors;
  outcomeReports: typeof outcomeReports;
  sessionScores: typeof sessionScores;
  toolSchemas: typeof toolSchemas;
  toolSchemaVersions: typeof toolSchemaVersions;
  prompts: typeof prompts;
  promptVersions: typeof promptVersions;
  portabilityModels: typeof portabilityModels;
  evaluationAnalyses: typeof evaluationAnalyses;
  appSettings: typeof appSettings;
};
