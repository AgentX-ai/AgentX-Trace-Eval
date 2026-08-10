import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

// Self-host's project registry (see core/project/projects.ts): a project's own apiKey IS what
// selects it on every request (routes resolve `x-api-key` -> project via requireApiKey, see
// auth/apiKey.ts) — no separate project_id needs to be sent on any call. Every other table below
// (except portabilityModels/appSettings, which stay instance-wide — see their own comments) carries
// a project_id column so one self-host instance can host multiple fully isolated projects, each
// with its own traces/agents/patterns/datasets/prompts.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull(),
  // The auto-created project an existing single-project install migrates into (see storage/db.ts's
  // backfillDefaultProjectSqlite) — always exactly one true row. Used by the unauthenticated
  // /dev/bootstrap endpoint to know which project's key to hand back for the zero-setup dev
  // experience, same isDefault convention already used by evaluationSettings/portabilityModels.
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Project-level monitoring defaults (formerly per-agent AgentMonitoringProfile fields — see
  // core/monitor/profiles.ts's toWire comment): apply uniformly to every agent in this project.
  // monitor_profiles keeps its own coverageMode/sampleRate/retentionDays/redactionMode columns for
  // SDK wire-compat, but nothing reads them for behavior anymore — these are the real source of
  // truth as of the project-level Settings screen.
  coverageMode: text("coverage_mode").notNull().default("all"),
  sampleRate: real("sample_rate").notNull().default(1),
  retentionDays: integer("retention_days").notNull().default(30),
  redactionMode: text("redaction_mode").notNull().default("standard"),
  latencyThresholdMs: integer("latency_threshold_ms").notNull().default(20000),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

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
  // Subsets of inputTokens (not additional tokens) — a prompt-caching write/read, when the
  // provider reports one. See core/trace/ingest.ts's ingestTraceSchema comment for the full
  // per-provider field mapping, and core/evaluate/models.ts's estimateCostUSD for how these price
  // differently from a regular input token.
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  // Real span hierarchy — populated only by the OTel ingestion path (otel/mapping.ts's
  // otelSpanToIngestInput), always null for SDK-native tracer.trace() calls, which have no span
  // concept. spanId/parentSpanId let a session's rows (sessionId = the OTel traceId) be assembled
  // into a tree; startedAt is the absolute span start (otherwise only the derived latencyMs
  // duration survives ingestion, never enough on its own for a waterfall's relative positioning).
  spanId: text("span_id"),
  parentSpanId: text("parent_span_id"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // Resolved agent identity (core/monitor/agents.ts's resolveAgentId), nullable since it's
  // backfilled for pre-existing rows by a one-time migration (storage/db.ts) rather than set at
  // insert time historically. `name` stays the free-text display string traced under; this is the
  // real relation every other monitor_* table's agentId column now points at too.
  agentId: text("agent_id"),
  // Which project this trace belongs to — resolved from the ingesting request's API key, not sent
  // explicitly. Nullable/backfilled the same way agentId was (storage/db.ts's one-time migration).
  projectId: text("project_id"),
});

// Self-host's agent registry (see core/monitor/agents.ts): `name` is deliberately NOT unique — an
// explicit POST /agents (client.agents.register()) always creates a new row, which is the only way
// to end up with two agents sharing a display name, disambiguated from then on by `id`. The
// implicit path (tracing under a name with no explicit agent_id) still resolves to a single,
// stable agent per distinct name via resolveAgentId, exactly like today's name-only behavior.
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
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
  // Array of { id, name, code, enabled } — user-defined JS/TS scoring functions, self-host only
  // (core/evaluate/codeScorer.ts executes `code` in-process via node:vm). Open-ended and
  // dataset-defined, unlike the 4 fixed similarity metrics above, hence one JSON column here
  // rather than a column per scorer.
  codeScorers: text("code_scorers", { mode: "json" }),
  acceptanceCriteria: text("acceptance_criteria"),
  rejectionCriteria: text("rejection_criteria"),
  evaluationCriteria: text("evaluation_criteria"),
  // Array of { main_question: { query, expectedResults, judgeGuideline }, follow_up_questions: [] }
  // matching the SDK's DatasetQuestion/TestCase shape.
  questions: text("questions", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

export const evaluationSettings = sqliteTable("evaluation_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  numberOfRequests: integer("number_of_requests").notNull().default(1),
  // See datasets.similarityConfig's comment for the exact shape.
  similarityConfig: text("similarity_config", { mode: "json" }),
  // See datasets.codeScorers's comment for the exact shape.
  codeScorers: text("code_scorers", { mode: "json" }),
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
  projectId: text("project_id"),
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
  projectId: text("project_id"),
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
    // Array of { name, score: number | null, reasoning?, error? } — one entry per enabled code
    // scorer on the dataset at run time (core/evaluate/codeScorer.ts). Open-ended/named like
    // datasets.codeScorers, hence one JSON column rather than fixed columns.
    codeScorerResults: text("code_scorer_results", { mode: "json" }),
    rating: real("rating"),
    justification: text("justification"),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    projectId: text("project_id"),
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

// Edit history for a dataset's own (questions-only) fields — separate log from
// evaluationSettingsVersions below even for a dataset+settings twin sharing one id, mirroring the
// hosted SaaS's DatasetVersion/EvaluationSettingsVersion split (see core/evaluate/versions.ts).
// One row per save that actually changed a tracked field, newest-first by createdAt; no `creator`
// column, since self-host has only the one synthetic LOCAL_USER (see routes/evaluateDashboard.ts).
export const datasetVersions = sqliteTable("dataset_versions", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  // { name, description, questions, status } — see core/evaluate/versions.ts's DATASET_SNAPSHOT_FIELDS.
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  // Computed field-diff against the prior version ("Updated acceptance criteria, questions"), or
  // "Created" for the first version — see core/evaluate/versions.ts's buildChangeSummary. Always
  // present (unlike the hosted SaaS's async LLM-generated summary this mirrors in shape only).
  changeSummary: text("change_summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Edit history for an EvaluationSettings grading config — see datasetVersions' comment above for
// the general shape/rationale. Applies equally to a dataset's twin config and a standalone
// Evaluator config (no dataset attached), since both are just rows in evaluationSettings.
export const evaluationSettingsVersions = sqliteTable("evaluation_settings_versions", {
  id: text("id").primaryKey(),
  evaluationSettingsId: text("evaluation_settings_id").notNull(),
  // See core/evaluate/versions.ts's SETTINGS_SNAPSHOT_FIELDS for the exact field list.
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  changeSummary: text("change_summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Interactive Playground's own run history (core/evaluate/playgroundRuns.ts) — a persistence
// layer that sits next to, not inside, core/evaluate/playground.ts's runPlayground (still pure
// "compute and return", untouched). No workspaceId column, same as monitor_patterns/
// monitor_online_evaluators — self-host has no real multi-tenant concept, the frontend sends one
// as a no-op query param for API-shape consistency only. Pruned to the most recent N rows on every
// insert (see prunePlaygroundRuns), so this never grows unbounded like a real persisted resource.
export const playgroundRuns = sqliteTable("playground_runs", {
  id: text("id").primaryKey(),
  // { models: PortabilityModel[]; questions: (TestCase & {index})[] } — the frontend's
  // RunSnapshot verbatim, no transformation either direction.
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  // Record<cellKey, CellState> — the full current results map, overwritten wholesale on every
  // incremental update (the frontend always holds the complete up-to-date object already).
  results: text("results", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
  // Which prompt (prompts.id) this session was testing, when started from the prompt registry —
  // lets a human review left on a cell here become evidence for that prompt's improvement
  // pipeline (see core/evaluate/prompts.ts's gatherPlaygroundExamples). Null for a promptless
  // session (typed directly into the message editor), same as everywhere else this stays optional.
  promptId: text("prompt_id"),
});

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
  projectId: text("project_id"),
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
    // Opt-in (default false): a per-trace classification judge call, real LLM spend, so existing
    // installs shouldn't get it for free on upgrade. Reuses this profile's own sampleRate — no
    // separate rate knob. See core/monitor/topics.ts's runClassification.
    topicsEnabled: integer("topics_enabled", { mode: "boolean" }).notNull().default(false),
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
    projectId: text("project_id"),
  },
  table => ({
    // Unique per project+agent, not globally per agent — two different projects' agents never
    // collide on this index even if (hypothetically) their ids ever matched.
    agentIdUnique: uniqueIndex("monitor_profiles_agent_id").on(table.projectId, table.agentId),
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
    projectId: text("project_id"),
  },
  table => ({
    // Dedup key: a re-detected signal for the same pattern (scoped to the same agent, since
    // self-host doesn't group across agents the way the hosted SaaS's platform-wide patterns do)
    // increments occurrenceCount instead of creating a new row. projectId included so two
    // projects' agents never dedup against each other.
    patternAgentUnique: uniqueIndex("monitor_signals_pattern_key_agent_id").on(
      table.projectId,
      table.patternKey,
      table.agentId
    ),
  })
);

// One reviewer note per POST /agent-monitoring/signals/:id/feedback call (not deduped/upserted
// like signals themselves — each submission is its own record, matching
// AgentSignalFeedback/SignalFeedbackDialog's "Previous feedback" list in AgentX-web-front).
export const monitorSignalFeedback = sqliteTable("monitor_signal_feedback", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  // Which occurrence (monitor_events.id) this note is about — nullable since older rows and some
  // signal sources predate per-occurrence text ever being resolvable. See core/monitor/feedback.ts.
  eventId: text("event_id"),
  metric: text("metric").notNull(),
  originalScore: real("original_score"),
  correctedScore: real("corrected_score"),
  rationale: text("rationale").notNull(),
  queuedForAutotune: integer("queued_for_autotune", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
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
  // Set only for type: "custom_eval_check" rows (core/monitor/customEvaluators.ts) — a per-check
  // boolean verdict, recorded whether or not it raised a Signal. Same "skip in KPI/trend
  // classification" treatment as onlineEvaluatorId above.
  customEvaluatorId: text("custom_evaluator_id"),
  matched: integer("matched", { mode: "boolean" }),
  // Optional metadata a custom evaluator's endpoint can additionally report alongside `matched` —
  // never drives the matched/hit decision, just recorded for visibility. Not reused for
  // onlineEvaluatorId rows (see EventRow's own comment in core/monitor/events.ts).
  score: real("score"),
  projectId: text("project_id"),
});

// One row per classified trace (core/monitor/topics.ts's runClassification, gated by
// monitor_profiles.topicsEnabled) — a separate table rather than overloading monitor_events, since
// "top intents this week" wants real GROUP BY-able columns, not a JSON blob stuffed into a column
// (justification) that's already semantically owned by the online-evaluator flow.
export const monitorClassifications = sqliteTable("monitor_classifications", {
  id: text("id").primaryKey(),
  traceId: text("trace_id"),
  agentId: text("agent_id"),
  intent: text("intent").notNull(),
  sentiment: text("sentiment").notNull(),
  issueType: text("issue_type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
  // JSON-encoded number[] (text-embedding-3-small, see core/evaluate/judge.ts's computeEmbedding)
  // of this classification's input+output text — null when no OPENAI_API_KEY was set or the
  // embeddings call failed, same graceful-degradation posture as the rest of this file. Powers
  // the Topics "Map" view's UMAP projection (core/monitor/topics.ts's getTopicsMap); not
  // backfilled for rows classified before this column existed.
  embedding: text("embedding", { mode: "json" }),
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
  projectId: text("project_id"),
});

// Promoted out of Pattern's condition-row "external" detector (core/monitor/conditions.ts) — a
// URL the user controls, POSTed the trace, expected to answer {matches, reason}. See
// core/monitor/customEvaluators.ts's runCustomEvaluators for the full contract.
export const customEvaluators = sqliteTable("custom_evaluators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  sampleRate: real("sample_rate").notNull().default(0.1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: text("agent_ids", { mode: "json" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // false: matches===true raises a Signal (the common case — "flag it when my endpoint says so").
  // true: inverted, matches===false raises a Signal instead — mirrors the old per-condition
  // `negate` flag from the Pattern builder this was extracted from.
  invertMatch: integer("invert_match", { mode: "boolean" }).notNull().default(false),
  severity: text("severity").notNull().default("medium"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
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
  projectId: text("project_id"),
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

// Model Portability's candidate models + $/M-token pricing (core/evaluate/models.ts) —
// dashboard-editable rather than the hardcoded array it started as, so a stale price or a missing
// model doesn't need a code change/redeploy to fix. `id` is the model string itself (e.g.
// "gpt-4.1", whatever gets sent to the provider's API), not a separate generated row id — that's
// the natural unique key here, no reason to add a second one.
//
// Deliberately instance-wide, not project-scoped: this is a shared reference pricing catalog, not
// data belonging to any one project — no reason to make every new project re-enter the same
// gpt-4o-mini price. (A "custom" row's own baseUrl/apiKey is per-model already, so a bring-your-own
// endpoint one project adds is still visible to others — acceptable for a local single-operator
// instance; revisit if that turns out wrong in practice.)
export const portabilityModels = sqliteTable("portability_models", {
  id: text("id").primaryKey(),
  // "openai" | "anthropic" | "custom" — a custom row is any bring-your-own OpenAI-compatible
  // endpoint (vLLM, Ollama, LM Studio, ...), routed through the same "openai" call path in
  // core/evaluate/judge.ts's resolveModelRouting, just with a per-model client instead of the
  // global one.
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  pricePerMInputTokens: real("price_per_m_input_tokens").notNull(),
  pricePerMOutputTokens: real("price_per_m_output_tokens").notNull(),
  // Nullable: null means "not configured," and estimateCostUSD (core/evaluate/models.ts) falls back
  // to pricePerMInputTokens above for that token type — byte-identical cost to before this feature
  // for any model that hasn't opted in. See traces.cacheReadTokens/cacheWriteTokens's comment for
  // the full per-provider field mapping these get multiplied against.
  pricePerMCacheReadTokens: real("price_per_m_cache_read_tokens"),
  pricePerMCacheWriteTokens: real("price_per_m_cache_write_tokens"),
  // At most one row is default at a time (enforced in core/evaluate/models.ts, not here) — sorted
  // first by listPortabilityModels, so it's what judge-model dropdowns preselect. Same isDefault
  // convention as evaluationSettings above.
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Only set for provider "custom" — null for openai/anthropic rows, which use Platform Settings'
  // shared provider keys instead. apiKey is plaintext, same posture as every other secret this
  // engine stores locally (see appSettings' own comment).
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// One row per evaluation run (evaluationId = evaluationRuns.id), replaced wholesale on
// re-analyze — see core/evaluate/analysis.ts. Deliberately not the hosted SaaS's job-queue
// pipeline (no job queue exists in this engine, see routes/evaluations.ts's comment on why that
// was left for a future pass): up to MAX_JUDGES judges independently re-rate every sampled item in
// parallel, synchronously within the one HTTP request, no confidence-weighted fusion/tie-break.
export const evaluationAnalyses = sqliteTable("evaluation_analyses", {
  evaluationId: text("evaluation_id").primaryKey(),
  status: text("status").notNull(),
  // Primary/writer judge (judgeModels[0]) — kept for rows written before judgeModels existed.
  judgeModel: text("judge_model").notNull(),
  // All judges used for this analysis (1-3) — see core/evaluate/analysis.ts's MAX_JUDGES. Nullable:
  // rows written before multi-judge support only have judgeModel.
  judgeModels: text("judge_models", { mode: "json" }),
  // AnalysisSchema-shaped (src/types/evaluate.ts on the frontend) minus instructionChanges, which
  // is always [] — self-host has no native agent config to apply a change to. Null on failure.
  analysis: text("analysis", { mode: "json" }),
  // { numberOfRuns, averageRating, minRating, maxRating, ratingVariance } — pure arithmetic over
  // evaluation_run_results.rating, computed at analysis time, not re-derived per read.
  statistics: text("statistics", { mode: "json" }),
  // The worst-N sample rows actually shown to the judge(s), each with every judge's own rating —
  // for the panel's judgeEvidence display.
  judgeEvidence: text("judge_evidence", { mode: "json" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Singleton row (id is always "default") — self-host has no per-user/per-workspace settings
// concept, so one row for the whole instance is enough. Plaintext, same security posture as the
// .env file these keys used to live in exclusively (self-host is single-user/local-disk either
// way) — see Platform Settings' own design note for why this isn't treated as a gap.
//
// Deliberately instance-wide, not project-scoped, same reasoning as portabilityModels above: these
// are the running process's own OpenAI/Anthropic credentials used to actually call out for judging
// across every project on this instance, not per-project billing.
export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  openaiApiKey: text("openai_api_key"),
  anthropicApiKey: text("anthropic_api_key"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SqliteSchema = {
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
  monitorPatterns: typeof monitorPatterns;
  monitorSignalFeedback: typeof monitorSignalFeedback;
  monitorProfiles: typeof monitorProfiles;
  monitorSignals: typeof monitorSignals;
  monitorEvents: typeof monitorEvents;
  monitorClassifications: typeof monitorClassifications;
  monitorOnlineEvaluators: typeof monitorOnlineEvaluators;
  customEvaluators: typeof customEvaluators;
  prompts: typeof prompts;
  promptVersions: typeof promptVersions;
  portabilityModels: typeof portabilityModels;
  evaluationAnalyses: typeof evaluationAnalyses;
  appSettings: typeof appSettings;
};
