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
  numberOfRequests: integer("number_of_requests").notNull().default(1),
  // { vectorSimilarity?: { enabled, model? }, jaccardSimilarity?: { enabled }, bleuScore?: { enabled },
  // rougeScore?: { enabled } } — matches AgentX-Python's DatasetBuilder/EvaluationSettingsBuilder
  // wire payload exactly, so no reshaping is needed on either side of the create/update routes.
  similarityConfig: text("similarity_config", { mode: "json" }),
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
  numberOfRequests: integer("number_of_requests").notNull().default(1),
  // See datasets.similarityConfig's comment for the exact shape.
  similarityConfig: text("similarity_config", { mode: "json" }),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  // Null means "use the built-in default" (see core/evaluate/judge.ts), same convention as the
  // hosted SaaS's EvaluationSettings.judgePrompt/judgeModel.
  judgePrompt: text("judge_prompt"),
  judgeModel: text("judge_model"),
  // Only meaningful for a standalone config (no dataset twin) — used by EvaluationConfigSelector
  // to preselect a judge config when starting a run without picking one explicitly. At most one
  // row has isDefault=true at a time (enforced in core/evaluate/evaluationSettings.ts, not here).
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("published"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const evaluationRuns = sqliteTable("evaluation_runs", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  evaluationSubject: text("evaluation_subject", { mode: "json" }),
  // Extracted from evaluationSubject.version / evaluationSubject.metadata.version at initRun time
  // (core/evaluate/runs.ts) so it's a queryable/groupable column instead of buried in an opaque
  // JSON blob — the external-agent analog to autotune: tag two SDK runs of the same dataset with
  // different version labels, compare their average ratings (getVersionComparison below).
  version: text("version"),
  runSource: text("run_source"),
  sdkInfo: text("sdk_info", { mode: "json" }),
  // [{ questionIndex, variants: string[] }] — generated once at initRun time (core/evaluate/
  // judge.ts's generateSmokeTestVariants) for questions with main_question.smokeTest.enabled,
  // frozen for the lifetime of the run so a later call can't see it change mid-run.
  smokeTestVariants: text("smoke_test_variants", { mode: "json" }),
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
    traceId: text("trace_id"),
    isSmokeTestVariant: integer("is_smoke_test_variant", { mode: "boolean" }).notNull().default(false),
    smokeTestVariantText: text("smoke_test_variant_text"),
    // From the SDK result's `timings: { latencyMs, inputTokens, outputTokens }` (see
    // AgentX-Python's normalize_result) — top-level input_tokens/output_tokens on the callable's
    // returned dict, or metadata.input_tokens/prompt_tokens as a fallback.
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    vectorSimilarity: real("vector_similarity"),
    jaccardSimilarity: real("jaccard_similarity"),
    bleuScore: real("bleu_score"),
    rougeScore: real("rouge_score"),
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
  // Routing/throttling metadata, not part of detection itself (see core/monitor/conditions.ts for
  // that) — not yet enforced in core/monitor/detect.ts's detectCustomPatterns (which still runs
  // every enabled pattern against every trace, unscoped/unsampled); persisted here so the
  // dashboard's pattern editor round-trips these fields instead of silently dropping them.
  sampleRate: real("sample_rate").notNull().default(1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: text("agent_ids", { mode: "json" }),
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
    // Notification channel ids, e.g. ["slack:#alerts"] — self-host has no notification delivery
    // yet, stored so the dashboard's settings dialog round-trips the field.
    channels: text("channels", { mode: "json" }),
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
    reviewStatus: text("review_status"),
    recommendedActions: text("recommended_actions", { mode: "json" }),
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

// One reviewer note per POST /agent-monitoring/signals/:id/feedback call (not deduped/upserted
// like signals themselves — each submission is its own record, matching
// AgentSignalFeedback/SignalFeedbackDialog's "Previous feedback" list in AgentX-web-front).
export const monitorSignalFeedback = sqliteTable("monitor_signal_feedback", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  metric: text("metric").notNull(),
  originalScore: real("original_score"),
  correctedScore: real("corrected_score"),
  rationale: text("rationale").notNull(),
  queuedForAutotune: integer("queued_for_autotune", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// One row per detection *check* (matched or healthy), timestamped — monitor_signals only stores
// deduped aggregates (occurrenceCount/firstSeenAt/lastSeenAt), which is enough for triage but not
// for anything windowed (Overview's KPI strip/trend chart/top-failing breakdown all need to know
// *when* things happened, not just totals-to-date). Written alongside monitor_signals' existing
// upsert in core/monitor/detect.ts, not instead of it.
export const monitorEvents = sqliteTable("monitor_events", {
  id: text("id").primaryKey(),
  // Null for a healthy-response event, since upsertSignal still writes a monitor_signals row for
  // those (the "healthy-response" dedup key) — set to that row's id here too for consistency, kept
  // nullable in case a future caller records an event with nowhere to point it.
  signalId: text("signal_id"),
  patternKey: text("pattern_key").notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  polarity: text("polarity").notNull(),
  agentId: text("agent_id"),
  traceId: text("trace_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // Set only for type: "online_eval_score" rows (core/monitor/onlineEvaluators.ts) — a continuous
  // judge rating on sampled live traffic, distinct from every other row here which is a
  // failure/healthy pattern-match tally. core/monitor/events.ts's KPI/trend classification
  // explicitly skips rows with an onlineEvaluatorId set, so this doesn't corrupt that math.
  onlineEvaluatorId: text("online_evaluator_id"),
  rating: real("rating"),
  justification: text("justification"),
});

// Mirrors monitor_patterns' routing fields (sampleRate/scopeMode/agentIds, see core/monitor/
// routing.ts) — the same filter+sample primitive, applied to a judge-scoring config instead of a
// pattern-matching one. References an evaluationSettings row for its criteria/judge prompt/judge
// model (evaluationSettingsId) rather than storing its own copy — that used to be inline before
// Evaluate's standalone-config creation UI existed; now that it does, the "Evaluator" config is
// the single source of truth, reused via EvaluationConfigSelector on the frontend.
export const monitorOnlineEvaluators = sqliteTable("monitor_online_evaluators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  // Every check here is a real LLM call against the user's own API key (unlike pattern-matching,
  // which is usually free string/regex matching) — defaults meaningfully lower than a pattern's.
  sampleRate: real("sample_rate").notNull().default(0.1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: text("agent_ids", { mode: "json" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // NULL: never raise a Signal for a low score on this evaluator (the pre-Signals-integration
  // behavior). Not-null: a score below this raises/updates a Signal the same way a failing
  // Pattern match does, see core/monitor/onlineEvaluators.ts's runOnlineEvaluators.
  alertThreshold: real("alert_threshold").default(5),
  severity: text("severity").notNull().default("medium"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// The external-agent prompt registry (see core/evaluate/prompts.ts): AgentX doesn't own the
// external agent's code, so it can't branch/merge/apply a config the way native autotune does.
// Instead, like LangSmith's Prompt Hub / Langfuse's Prompt Management, AgentX becomes the
// prompt's source of truth — the SDK pulls prompts.currentVersion's text at runtime, and a
// human-approved "propose improvement" step (core/evaluate/prompts.ts's
// proposePromptImprovement, reusing core/evaluate/judge.ts's callJudgeJson) writes new rows here,
// never straight into a caller's code.
export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id").notNull(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    // "manual": a human wrote/edited this version directly. "proposed": accepted from
    // proposePromptImprovement's judge-generated suggestion (reasoning/basedOnVersion set).
    source: text("source").notNull().default("manual"),
    reasoning: text("reasoning"),
    basedOnVersion: integer("based_on_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => ({
    promptVersionUnique: uniqueIndex("prompt_versions_prompt_id_version").on(table.promptId, table.version),
  })
);

// Model Portability's candidate models + $/M-token pricing (core/evaluate/models.ts) —
// dashboard-editable rather than the hardcoded array it started as, so a stale price or a missing
// model doesn't need a code change/redeploy to fix. `id` is the model string itself (e.g.
// "gpt-4.1", whatever gets sent to the provider's API), not a separate generated row id — that's
// the natural unique key here, no reason to add a second one.
export const portabilityModels = sqliteTable("portability_models", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  pricePerMInputTokens: real("price_per_m_input_tokens").notNull(),
  pricePerMOutputTokens: real("price_per_m_output_tokens").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SqliteSchema = {
  traces: typeof traces;
  datasets: typeof datasets;
  evaluationSettings: typeof evaluationSettings;
  evaluationRuns: typeof evaluationRuns;
  evaluationRunResults: typeof evaluationRunResults;
  monitorPatterns: typeof monitorPatterns;
  monitorSignalFeedback: typeof monitorSignalFeedback;
  monitorProfiles: typeof monitorProfiles;
  monitorSignals: typeof monitorSignals;
  monitorEvents: typeof monitorEvents;
  monitorOnlineEvaluators: typeof monitorOnlineEvaluators;
  prompts: typeof prompts;
  promptVersions: typeof promptVersions;
  portabilityModels: typeof portabilityModels;
};
