import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

// Self-host's project registry (see core/project/projects.ts): a project's own apiKey IS what
// selects it on every request (routes resolve `x-api-key` -> project via requireApiKey, see
// auth/apiKey.ts) - no separate project_id needs to be sent on any call. Every other table below
// (except portabilityModels/appSettings, which stay instance-wide - see their own comments) carries
// a project_id column so one self-host instance can host multiple fully isolated projects, each
// with its own traces/agents/patterns/datasets/prompts.
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull(),
  // The auto-created project an existing single-project install migrates into (see storage/db.ts's
  // backfillDefaultProjectSqlite) - always exactly one true row. Its key is the one printed at
  // engine startup for the operator to copy into the dashboard/SDK, same isDefault convention
  // already used by evaluationSettings/portabilityModels.
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Project-level monitoring defaults (formerly per-agent AgentMonitoringProfile fields - see
  // core/monitor/profiles.ts's toWire comment): apply uniformly to every agent in this project.
  // monitor_profiles keeps its own coverageMode/sampleRate/retentionDays/redactionMode columns for
  // SDK wire-compat, but nothing reads them for behavior anymore - these are the real source of
  // truth as of the project-level Settings screen.
  coverageMode: text("coverage_mode").notNull().default("all"),
  sampleRate: real("sample_rate").notNull().default(1),
  retentionDays: integer("retention_days").notNull().default(30),
  redactionMode: text("redaction_mode").notNull().default("standard"),
  latencyThresholdMs: integer("latency_threshold_ms").notNull().default(20000),
  // Topics classification opt-in (core/monitor/topics.ts's runClassification) - moved here from
  // monitor_profiles.topicsEnabled, the last per-agent monitoring setting left behind when the
  // rest went project-level. The old profile column still exists for wire compat but nothing
  // reads it for behavior anymore; a one-way boot-time backfill (storage/db.ts) copies any
  // enabled profile up to its project once, then clears the profile flags.
  topicsEnabled: integer("topics_enabled", { mode: "boolean" }).notNull().default(false),
  // Idle-session coherence sweep opt-OUT (default on): the built-in whole-session consistency
  // check (core/monitor/sessionScores.ts's runSessionCoherenceCheck) runs automatically from the
  // idle-session sweep for qualifying sessions; the dashboard's per-session button stays as the
  // manual re-run. Default true unlike topicsEnabled: coherence is bounded by the sweep's own
  // per-tick judge budget, so on-by-default doesn't risk unbounded spend.
  coherenceSweepEnabled: integer("coherence_sweep_enabled", { mode: "boolean" }).notNull().default(true),
  // Built-in pattern keys (core/monitor/detect.ts's BUILT_IN_MONITOR_PATTERNS) this project has
  // switched off - the pattern catalog's enable toggle for builtIn rows writes here. Empty/null
  // means all built-ins run (the default).
  disabledBuiltinPatterns: text("disabled_builtin_patterns", { mode: "json" }),
  // Which auth organization owns this project (AGENTX_AUTH=enabled mode). Null in disabled mode
  // and for pre-auth rows; the first owner signup claims all orgless projects.
  organizationId: text("organization_id"),
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
  // Subsets of inputTokens (not additional tokens) - a prompt-caching write/read, when the
  // provider reports one. See core/trace/ingest.ts's ingestTraceSchema comment for the full
  // per-provider field mapping, and core/evaluate/models.ts's estimateCostUSD for how these price
  // differently from a regular input token.
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  // Real span hierarchy - populated only by the OTel ingestion path (otel/mapping.ts's
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
  // Which project this trace belongs to - resolved from the ingesting request's API key, not sent
  // explicitly. Nullable/backfilled the same way agentId was (storage/db.ts's one-time migration).
  projectId: text("project_id"),
});

// Self-host's agent registry (see core/monitor/agents.ts): `name` is deliberately NOT unique - an
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
  // rougeScore?: { enabled } } - matches AgentX-Python's DatasetBuilder/EvaluationSettingsBuilder
  // wire payload exactly, so no reshaping is needed on either side of the create/update routes.
  similarityConfig: text("similarity_config", { mode: "json" }),
  // Array of { id, name, code, enabled } - user-defined JS/TS scoring functions, self-host only
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
  // Only meaningful for a standalone config (no dataset twin) - used by EvaluationConfigSelector
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
  // JSON blob - the external-agent analog to autotune: tag two SDK runs of the same dataset with
  // different version labels, compare their average ratings (getVersionComparison below).
  version: text("version"),
  runSource: text("run_source"),
  sdkInfo: text("sdk_info", { mode: "json" }),
  // [{ questionIndex, variants: string[] }] - generated once at initRun time (core/evaluate/
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
    // AgentX-Python's normalize_result) - top-level input_tokens/output_tokens on the callable's
    // returned dict, or metadata.input_tokens/prompt_tokens as a fallback.
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    vectorSimilarity: real("vector_similarity"),
    jaccardSimilarity: real("jaccard_similarity"),
    bleuScore: real("bleu_score"),
    rougeScore: real("rouge_score"),
    // Array of { name, score: number | null, reasoning?, error? } - one entry per enabled code
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

// Edit history for a dataset's own (questions-only) fields - separate log from
// evaluationSettingsVersions below even for a dataset+settings twin sharing one id, mirroring the
// hosted SaaS's DatasetVersion/EvaluationSettingsVersion split (see core/evaluate/versions.ts).
// One row per save that actually changed a tracked field, newest-first by createdAt; no `creator`
// column, since self-host has only the one synthetic LOCAL_USER (see routes/evaluateDashboard.ts).
export const datasetVersions = sqliteTable("dataset_versions", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  // { name, description, questions, status } - see core/evaluate/versions.ts's DATASET_SNAPSHOT_FIELDS.
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  // Computed field-diff against the prior version ("Updated acceptance criteria, questions"), or
  // "Created" for the first version - see core/evaluate/versions.ts's buildChangeSummary. Always
  // present (unlike the hosted SaaS's async LLM-generated summary this mirrors in shape only).
  changeSummary: text("change_summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Edit history for an EvaluationSettings grading config - see datasetVersions' comment above for
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

// Interactive Playground's own run history (core/evaluate/playgroundRuns.ts) - a persistence
// layer that sits next to, not inside, core/evaluate/playground.ts's runPlayground (still pure
// "compute and return", untouched). No workspaceId column, same as monitor_patterns/
// monitor_online_evaluators - self-host has no real multi-tenant concept, the frontend sends one
// as a no-op query param for API-shape consistency only. Pruned to the most recent N rows on every
// insert (see prunePlaygroundRuns), so this never grows unbounded like a real persisted resource.
export const playgroundRuns = sqliteTable("playground_runs", {
  id: text("id").primaryKey(),
  // "grid" (the classic results grid, null treated as grid for pre-column rows) or "simulation"
  // (a stored Simulate-conversation transcript) - the History view splits on this.
  kind: text("kind"),
  // { models: PortabilityModel[]; questions: (TestCase & {index})[] } - the frontend's
  // RunSnapshot verbatim, no transformation either direction.
  snapshot: text("snapshot", { mode: "json" }).notNull(),
  // Record<cellKey, CellState> - the full current results map, overwritten wholesale on every
  // incremental update (the frontend always holds the complete up-to-date object already).
  results: text("results", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
  // Which prompt (prompts.id) this session was testing, when started from the prompt registry -
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
  // that) - not yet enforced in core/monitor/detect.ts's detectCustomPatterns (which still runs
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
    // installs shouldn't get it for free on upgrade. Reuses this profile's own sampleRate - no
    // separate rate knob. See core/monitor/topics.ts's runClassification.
    topicsEnabled: integer("topics_enabled", { mode: "boolean" }).notNull().default(false),
    coverageMode: text("coverage_mode").notNull().default("all"),
    sampleRate: real("sample_rate").notNull().default(1),
    retentionDays: integer("retention_days").notNull().default(30),
    redactionMode: text("redaction_mode").notNull().default("standard"),
    // e.g. { latencyMs: 15000 } to override the built-in "Latency regression" pattern's default.
    thresholdOverrides: text("threshold_overrides", { mode: "json" }),
    approvalPolicy: text("approval_policy", { mode: "json" }),
    // Notification channel ids, e.g. ["slack:#alerts"] - self-host has no notification delivery
    // yet, stored so the dashboard's settings dialog round-trips the field.
    channels: text("channels", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    projectId: text("project_id"),
  },
  table => ({
    // Unique per project+agent, not globally per agent - two different projects' agents never
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
// like signals themselves - each submission is its own record, matching
// AgentSignalFeedback/SignalFeedbackDialog's "Previous feedback" list in AgentX-web-front).
export const monitorSignalFeedback = sqliteTable("monitor_signal_feedback", {
  id: text("id").primaryKey(),
  signalId: text("signal_id").notNull(),
  // Which occurrence (monitor_events.id) this note is about - nullable since older rows and some
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

// One row per detection *check* (matched or healthy), timestamped - monitor_signals only stores
// deduped aggregates (occurrenceCount/firstSeenAt/lastSeenAt), which is enough for triage but not
// for anything windowed (Overview's KPI strip/trend chart/top-failing breakdown all need to know
// *when* things happened, not just totals-to-date). Written alongside monitor_signals' existing
// upsert in core/monitor/detect.ts, not instead of it.
export const monitorEvents = sqliteTable("monitor_events", {
  id: text("id").primaryKey(),
  // Null for a healthy-response event, since upsertSignal still writes a monitor_signals row for
  // those (the "healthy-response" dedup key) - set to that row's id here too for consistency, kept
  // nullable in case a future caller records an event with nowhere to point it.
  signalId: text("signal_id"),
  patternKey: text("pattern_key").notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  polarity: text("polarity").notNull(),
  agentId: text("agent_id"),
  traceId: text("trace_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // Set only for type: "online_eval_score" rows (core/monitor/onlineEvaluators.ts) - a continuous
  // judge rating on sampled live traffic, distinct from every other row here which is a
  // failure/healthy pattern-match tally. core/monitor/events.ts's KPI/trend classification
  // explicitly skips rows with an onlineEvaluatorId set, so this doesn't corrupt that math.
  onlineEvaluatorId: text("online_evaluator_id"),
  rating: real("rating"),
  justification: text("justification"),
  // Set only for type: "custom_eval_check" rows (core/monitor/customEvaluators.ts) - a per-check
  // boolean verdict, recorded whether or not it raised a Signal. Same "skip in KPI/trend
  // classification" treatment as onlineEvaluatorId above.
  customEvaluatorId: text("custom_evaluator_id"),
  matched: integer("matched", { mode: "boolean" }),
  // Optional metadata a custom evaluator's endpoint can additionally report alongside `matched` -
  // never drives the matched/hit decision, just recorded for visibility. Not reused for
  // onlineEvaluatorId rows (see EventRow's own comment in core/monitor/events.ts).
  score: real("score"),
  // Set only for session-scoped online-evaluator rows (core/monitor/sessionSweep.ts's dual-write)
  // - the verdict is about a whole conversation, and traceId is just the session's last root
  // trace used as an anchor so trace-keyed ground truth (outcomes, user votes) can join. Trace-
  // scoped rows leave this null.
  sessionId: text("session_id"),
  projectId: text("project_id"),
});

// One row per classified trace (core/monitor/topics.ts's runClassification, gated by
// monitor_profiles.topicsEnabled) - a separate table rather than overloading monitor_events, since
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
  // of this classification's input+output text - null when no OPENAI_API_KEY was set or the
  // embeddings call failed, same graceful-degradation posture as the rest of this file. Powers
  // the Topics "Map" view's UMAP projection (core/monitor/topics.ts's getTopicsMap); not
  // backfilled for rows classified before this column existed.
  embedding: text("embedding", { mode: "json" }),
});

// Mirrors monitor_patterns' routing fields (sampleRate/scopeMode/agentIds, see core/monitor/
// routing.ts) - the same filter+sample primitive, applied to a judge-scoring config instead of a
// pattern-matching one. References an evaluationSettings row for its criteria/judge prompt/judge
// model (evaluationSettingsId) rather than storing its own copy - that used to be inline before
// Evaluate's standalone-config creation UI existed; now that it does, the "Evaluator" config is
// the single source of truth, reused via EvaluationConfigSelector on the frontend.
export const monitorOnlineEvaluators = sqliteTable("monitor_online_evaluators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  evaluationSettingsId: text("evaluation_settings_id"),
  // Every check here is a real LLM call against the user's own API key (unlike pattern-matching,
  // which is usually free string/regex matching) - defaults meaningfully lower than a pattern's.
  sampleRate: real("sample_rate").notNull().default(0.1),
  scopeMode: text("scope_mode").notNull().default("all"),
  agentIds: text("agent_ids", { mode: "json" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // NULL: never raise a Signal for a low score on this evaluator (the pre-Signals-integration
  // behavior). Not-null: a score below this raises/updates a Signal the same way a failing
  // Pattern match does, see core/monitor/onlineEvaluators.ts's runOnlineEvaluators.
  alertThreshold: real("alert_threshold").default(5),
  severity: text("severity").notNull().default("medium"),
  // "trace" (default): judge each sampled trace's input/output at ingest, the original behavior.
  // "session": judge whole idle conversations instead - the sweep (core/monitor/sessionSweep.ts)
  // assembles the session transcript once it's been quiet for idleSeconds and scores it against
  // this evaluator's criteria, re-scoring if the session later grows. The two scopes are
  // mutually exclusive per evaluator: a session-scoped one never runs at ingest.
  scope: text("scope").notNull().default("trace"),
  idleSeconds: integer("idle_seconds").notNull().default(120),
  // Non-null marks a system-owned built-in evaluator (core/monitor/builtinEvaluators.ts) - e.g.
  // "session-baseline", the Session Baseline Judge every project gets. Read-only through the API
  // except `enabled`, so the built-in can be paused but never edited away; its rubric lives in a
  // real evaluator config (not code), so judge tuning works on it like any other evaluator.
  builtinKey: text("builtin_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Promoted out of Pattern's condition-row "external" detector (core/monitor/conditions.ts) - a
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
  // false: matches===true raises a Signal (the common case - "flag it when my endpoint says so").
  // true: inverted, matches===false raises a Signal instead - mirrors the old per-condition
  // `negate` flag from the Pattern builder this was extracted from.
  invertMatch: integer("invert_match", { mode: "boolean" }).notNull().default(false),
  severity: text("severity").notNull().default("medium"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// "How to invoke my deployed agent" - a plain POST endpoint the engine calls per dataset question
// (core/evaluate/agentConnectors.ts's callAgentConnector) to drive an offline eval run without a
// human manually running the agent and pushing results via the SDK first (see
// runDatasetAgainstConnector). No sampleRate/scopeMode/agentIds the way customEvaluators has -
// those are ambient per-trace routing concepts for Monitor; a connector is explicitly picked per
// run instead, never applied automatically.
export const agentConnectors = sqliteTable("agent_connectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  // Extra request headers (e.g. an auth token for the customer's own agent endpoint) - plaintext,
  // same posture as appSettings' provider keys (self-host is single-user/local-disk).
  headers: text("headers", { mode: "json" }),
  timeoutMs: integer("timeout_ms").notNull().default(30000),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Ground truth reported back after the fact from a system AgentX doesn't own (e.g. "this incident
// was reopened 3 days later") - closes the "who evaluates the judge" gap a pure LLM-as-judge
// verdict can't answer on its own. traceId is the join key back to whatever verdict AgentX already
// recorded at the time (monitor_events for production/online, evaluation_run_results.trace_id for
// offline - both already exist on those tables), via core/monitor/outcomeCalibration.ts.
// evaluationRunResultId is an optional more direct link when reporting against a specific offline
// result rather than/in addition to a trace. `outcome` is a free string (e.g. "reopened",
// "confirmed_bad", "confirmed_good"), not a rigid enum - every customer's real-world outcome
// taxonomy differs, same "typed but extensible string" posture as monitor_profiles.channels.
export const outcomeReports = sqliteTable("outcome_reports", {
  id: text("id").primaryKey(),
  traceId: text("trace_id"),
  evaluationRunResultId: text("evaluation_run_result_id"),
  outcome: text("outcome").notNull(),
  // The actual calibration signal (core/monitor/outcomeCalibration.ts) - `outcome` is a free
  // human-readable label ("reopened", "escalated to a human", ...) that AgentX has no way to
  // classify as good/bad on its own (string-matching "reopened" as bad is guessable but wrong for
  // plenty of real taxonomies), so the reporter states polarity explicitly instead.
  isNegative: integer("is_negative", { mode: "boolean" }).notNull(),
  reason: text("reason"),
  reportedBy: text("reported_by"),
  reportedAt: integer("reported_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Session-level scores (core/monitor/sessionScores.ts) - a judge verdict over a whole multi-span
// session's assembled conversation, not one trace's input/output. Modeled on Langfuse's
// session-level scores (a score attaches to the sessionId directly) rather than a bespoke
// per-feature table: `kind` is extensible ("coherence" is the first and so far only evaluator
// kind), so a future session-level evaluator adds rows here, not a new table. driftSpanId: for
// coherence, the specific span where the judge saw the conversation lose the thread - null when
// coherent throughout.
// End-user thumbs on a traced response, reported via POST /feedback (usually forwarded by the
// customer's own app when their user clicks a vote button). The cheapest ground truth there is:
// a "down" raises a "negative-feedback" signal directly (no detection pass - the user IS the
// detector) and dual-writes an outcome report so Judge Calibration measures the judges against
// real human reactions. Deliberately NOT recorded as a monitor event: calibration counts events
// as "AgentX flagged it in advance", and feedback arriving after the fact is the report side of
// that comparison, not the prediction side.
export const userFeedback = sqliteTable("user_feedback", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  // "up" | "down"
  rating: text("rating").notNull(),
  comment: text("comment"),
  endUserId: text("end_user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// One row per RECORDED CI-gate evaluation (GET /runs/:id/gate with record=true - the SDK's
// report.gate() records by default; the dashboard's live preview never does). This is what the
// dashboard's CI page lists: actual gate history ("PR #142's gate failed on no-regression"),
// not recomputed previews. `checks` stores the full per-check verdict array verbatim.
// The Improvement Inbox: proposals the background sweep (core/evaluate/improvementSweep.ts)
// generated AND validated on its own when failure evidence crossed a threshold, queued for a
// human to review. status: "pending" (awaiting review) -> "published" | "dismissed". Nothing
// here ever publishes itself - the sweep does the expensive thinking (judge proposal +
// baseline-vs-candidate validation), the human keeps the only pen.
export const improvementProposals = sqliteTable("improvement_proposals", {
  id: text("id").primaryKey(),
  // "prompt" | "tool-schema"
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name").notNull(),
  status: text("status").notNull(),
  // Human-readable "why did this appear" ("6 tool failures in the last 24h")
  triggerReason: text("trigger_reason").notNull(),
  // Snapshot of the published text/definition the proposal was diffed against - kept so the
  // inbox renders a stable diff even if the target moves on before review.
  currentText: text("current_text").notNull(),
  proposal: text("proposal", { mode: "json" }).notNull(),
  validation: text("validation", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  projectId: text("project_id"),
});

export const gateResults = sqliteTable("gate_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  datasetId: text("dataset_id").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  averageRating: real("average_rating"),
  baselineRunId: text("baseline_run_id"),
  baselineAverage: real("baseline_average"),
  checks: text("checks", { mode: "json" }),
  // Free label from the caller ("sdk", "github-actions", ...) so history shows who gated.
  caller: text("caller"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// One row per background sweep name (core/shared/sweepLease.ts): the multi-replica guard that
// keeps N engine replicas sharing one database from each running the same sweep every tick.
// Global on purpose - no project_id, a sweep iterates every project itself.
export const sweepLeases = sqliteTable("sweep_leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessionScores = sqliteTable("session_scores", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  kind: text("kind").notNull(),
  rating: real("rating"),
  justification: text("justification"),
  driftSpanId: text("drift_span_id"),
  // Structured per-turn citations from the session judge ([{spanId, spanIndex, text, tag}]) -
  // what the session detail's judge rail renders as FINDINGS and uses to flag cited turns.
  // spanId null when the transcript was elided (index ambiguity, same rule as driftSpanId).
  findings: text("findings", { mode: "json" }),
  // How many spans the session had when this score was computed - a session has no clean "end"
  // event, so a score is a point-in-time snapshot; a later check on the same (now longer) session
  // appends a new row rather than mutating this one.
  spanCount: integer("span_count").notNull(),
  judgeModel: text("judge_model").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Tool/skill schema registry (core/evaluate/toolSchemas.ts) - the Prompt Registry's pattern
// applied to tool definitions: register the schema an agent's tool actually uses (name must match
// the traced tool-call name, that's the evidence join key - see detect.ts's
// `agent-tool-failure:<name>` patternKey), gather real failures against it, judge-propose a
// rewrite of the description/parameter docs, human approves, version bumps. Deliberately a
// structural near-copy of prompts/promptVersions below rather than a shared "registered asset"
// abstraction - prompts is in production, refactoring it under a generalization wasn't worth the
// risk for a second consumer. Unlike prompts there's no SDK runtime pull (a tool def lives
// hardcoded in the customer's own framework, a much bigger integration ask than reading a prompt
// string) - v1 is registry + suggestions only, applied manually.
export const toolSchemas = sqliteTable("tool_schemas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Optional test endpoint the Playground's "From Tool Schemas" picker carries over as the
  // tool's endpointUrl default. NEVER called by the engine outside a Playground/simulation run -
  // the registry itself stays execution-free (production tools run in the agent's own code).
  testEndpointUrl: text("test_endpoint_url"),
  // Evidence example ids already addressed by an adopted proposal (JSON string[]) - filtered
  // out of future Suggest-improvement evidence (core/evaluate/toolSchemas.ts).
  resolvedEvidence: text("resolved_evidence", { mode: "json" }),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

export const toolSchemaVersions = sqliteTable("tool_schema_versions", {
  id: text("id").primaryKey(),
  toolSchemaId: text("tool_schema_id").notNull(),
  version: integer("version").notNull(),
  // The full tool definition as free text (a JSON schema, a LangChain tool docstring, whatever
  // the customer's framework uses) - same "opaque text, judged not parsed" posture as
  // promptVersions.text.
  definition: text("definition").notNull(),
  source: text("source").notNull().default("manual"),
  reasoning: text("reasoning"),
  basedOnVersion: integer("based_on_version"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// The external-agent prompt registry (see core/evaluate/prompts.ts): AgentX doesn't own the
// external agent's code, so it can't branch/merge/apply a config the way native autotune does.
// Instead, like LangSmith's Prompt Hub / Langfuse's Prompt Management, AgentX becomes the
// prompt's source of truth - the SDK pulls prompts.currentVersion's text at runtime, and a
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

// Model Portability's candidate models + $/M-token pricing (core/evaluate/models.ts) -
// dashboard-editable rather than the hardcoded array it started as, so a stale price or a missing
// model doesn't need a code change/redeploy to fix. `id` is the model string itself (e.g.
// "gpt-4.1", whatever gets sent to the provider's API), not a separate generated row id - that's
// the natural unique key here, no reason to add a second one.
//
// Deliberately instance-wide, not project-scoped: this is a shared reference pricing catalog, not
// data belonging to any one project - no reason to make every new project re-enter the same
// gpt-4o-mini price. (A "custom" row's own baseUrl/apiKey is per-model already, so a bring-your-own
// endpoint one project adds is still visible to others - acceptable for a local single-operator
// instance; revisit if that turns out wrong in practice.)
export const portabilityModels = sqliteTable("portability_models", {
  id: text("id").primaryKey(),
  // "openai" | "anthropic" | "custom" - a custom row is any bring-your-own OpenAI-compatible
  // endpoint (vLLM, Ollama, LM Studio, ...), routed through the same "openai" call path in
  // core/evaluate/judge.ts's resolveModelRouting, just with a per-model client instead of the
  // global one.
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  pricePerMInputTokens: real("price_per_m_input_tokens").notNull(),
  pricePerMOutputTokens: real("price_per_m_output_tokens").notNull(),
  // Nullable: null means "not configured," and estimateCostUSD (core/evaluate/models.ts) falls back
  // to pricePerMInputTokens above for that token type - byte-identical cost to before this feature
  // for any model that hasn't opted in. See traces.cacheReadTokens/cacheWriteTokens's comment for
  // the full per-provider field mapping these get multiplied against.
  pricePerMCacheReadTokens: real("price_per_m_cache_read_tokens"),
  pricePerMCacheWriteTokens: real("price_per_m_cache_write_tokens"),
  // At most one row is default at a time (enforced in core/evaluate/models.ts, not here) - sorted
  // first by listPortabilityModels, so it's what judge-model dropdowns preselect. Same isDefault
  // convention as evaluationSettings above.
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Only set for provider "custom" - null for openai/anthropic rows, which use Platform Settings'
  // shared provider keys instead. apiKey is plaintext, same posture as every other secret this
  // engine stores locally (see appSettings' own comment).
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// One row per evaluation run (evaluationId = evaluationRuns.id), replaced wholesale on
// re-analyze - see core/evaluate/analysis.ts. Deliberately not the hosted SaaS's job-queue
// pipeline (no job queue exists in this engine, see routes/evaluations.ts's comment on why that
// was left for a future pass): up to MAX_JUDGES judges independently re-rate every sampled item in
// parallel, synchronously within the one HTTP request, no confidence-weighted fusion/tie-break.
export const evaluationAnalyses = sqliteTable("evaluation_analyses", {
  evaluationId: text("evaluation_id").primaryKey(),
  status: text("status").notNull(),
  // Primary/writer judge (judgeModels[0]) - kept for rows written before judgeModels existed.
  judgeModel: text("judge_model").notNull(),
  // All judges used for this analysis (1-3) - see core/evaluate/analysis.ts's MAX_JUDGES. Nullable:
  // rows written before multi-judge support only have judgeModel.
  judgeModels: text("judge_models", { mode: "json" }),
  // AnalysisSchema-shaped (src/types/evaluate.ts on the frontend) minus instructionChanges, which
  // is always [] - self-host has no native agent config to apply a change to. Null on failure.
  analysis: text("analysis", { mode: "json" }),
  // { numberOfRuns, averageRating, minRating, maxRating, ratingVariance } - pure arithmetic over
  // evaluation_run_results.rating, computed at analysis time, not re-derived per read.
  statistics: text("statistics", { mode: "json" }),
  // The worst-N sample rows actually shown to the judge(s), each with every judge's own rating -
  // for the panel's judgeEvidence display.
  judgeEvidence: text("judge_evidence", { mode: "json" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  projectId: text("project_id"),
});

// Singleton row (id is always "default") - self-host has no per-user/per-workspace settings
// concept, so one row for the whole instance is enough. Plaintext, same security posture as the
// .env file these keys used to live in exclusively (self-host is single-user/local-disk either
// way) - see Platform Settings' own design note for why this isn't treated as a gap.
//
// Deliberately instance-wide, not project-scoped, same reasoning as portabilityModels above: these
// are the running process's own OpenAI/Anthropic credentials used to actually call out for judging
// across every project on this instance, not per-project billing.
export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  openaiApiKey: text("openai_api_key"),
  anthropicApiKey: text("anthropic_api_key"),
  geminiApiKey: text("gemini_api_key"),
  // Session-signing secret for AGENTX_AUTH=enabled mode, generated on first enabled boot when
  // AGENTX_AUTH_SECRET isn't set - persisted so sessions survive restarts (instance-wide, like
  // the rest of this table).
  authSecret: text("auth_secret"),
  // One-time metric-pack backfill marker (core/evaluate/metricPack.ts): set after pre-existing
  // projects get the built-in RAG/safety configs, so a user deleting one stays deleted.
  metricPackSeededAt: integer("metric_pack_seeded_at", { mode: "timestamp_ms" }),
  // Highest metric-pack version this instance has been seeded with (see core/evaluate/
  // metricPack.ts) - lets later releases add NEW pack configs without resurrecting ones the
  // operator deleted from an earlier version.
  metricPackVersion: integer("metric_pack_version"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// --- Auth (AGENTX_AUTH=enabled mode; core/auth/betterAuth.ts) ---------------------------------
// better-auth's tables (core + organization plugin), hand-written to the library's documented
// shapes rather than CLI-generated, since this codebase's migrations are the bootstrap DDL in
// storage/db.ts, not drizzle-kit. Model names are prefixed auth_* (via better-auth modelName
// config) so "user" never collides with a Postgres reserved word and the auth surface is
// instantly recognizable in the DB. No project_id columns: identity is instance-wide, it's what
// GRANTS access to projects (via auth_organization -> projects.organization_id).
export const authUsers = sqliteTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSessions = sqliteTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull(),
  // Organization plugin: the org this session is acting as (null = default resolution).
  activeOrganizationId: text("active_organization_id"),
});

export const authAccounts = sqliteTable("auth_account", {
  id: text("id").primaryKey(),
  // better-auth >= 1.7 scopes account identity by issuer ("local:credential" for the
  // email/password accounts this engine creates) and REQUIRES the field - without it every
  // sign-up fails. Nullable in the column definition only so an install that predates it can be
  // backfilled on boot rather than refusing to start; better-auth always writes a value.
  issuer: text("issuer"),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const authVerifications = sqliteTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const authOrganizations = sqliteTable("auth_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  metadata: text("metadata"),
});

export const authMembers = sqliteTable("auth_member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const authInvitations = sqliteTable("auth_invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  // Part of better-auth's own invitation model; missing here, which would have failed the first
  // time anyone actually invited a teammate.
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  inviterId: text("inviter_id").notNull(),
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
