# Changelog / Development Log

This is a running, narrative record of how each feature in this repo was actually built and
verified - not a `Keep a Changelog`-style release diff. It predates any tagged releases and reads
chronologically, oldest first. Kept for provenance (what was checked, how, and any real bugs
caught along the way) without cluttering the [README](README.md), which only needs to describe
the project as it stands today.

For a quick summary of current capabilities and known gaps, see the README's
[Project status](README.md#project-status) section instead.

---

Trace, Evaluate, and Monitor are all wired end-to-end and verified against the real Python SDK
(judge scoring, built-in/custom pattern detection, idempotency, dedup), against both SQLite and a
real Postgres instance (`scripts/smoke-test.sh` run against a Dockerized Postgres, data checked
directly with `psql`, not just through the API). The CLI, Bun-compiled engine binary, and the
real AgentX-web-front dashboard (self-host build mode) all work together from a clean install
layout (`build.sh` builds both and lays them out the same way a release would), verified with the
compiled `agentx-engine` binary actually serving the built SPA plus real ingested trace data
through its API.

Trace also has a real OTLP/HTTP receiver (`/api/v1/otel/v1/traces`, see "OpenTelemetry" above),
verified against both wire formats: hand-built protobuf payloads (via `protobufjs` against the
vendored official `.proto` schema, not a guessed encoding) simulating an OpenLLMetry-instrumented
OpenAI call and a legacy `gen_ai.prompt`/`completion` shape, and a JSON payload using the current
`gen_ai.provider.name`/`gen_ai.input.messages`/`output.messages` convention - both correctly
produced mapped `input`/`output`/`model`/tokens/`framework` and triggered Monitor's built-in
error-detection pattern on a `STATUS_CODE_ERROR` span, all checked against the compiled
`agentx-engine` binary too (not just `tsx dev`), confirming `protobufjs` survives `bun build
--compile`. A real bug was caught this way before it shipped: attribute values were initially read
via protobufjs's `toObject({oneofs:true})` virtual discriminator field, which doesn't exist on a
genuine OTLP/JSON body from a real exporter - fixed to check field presence directly instead, which
works for both wire formats.

Dashboard scope covers Governance's shell, the Observe tab (Trace ingest + Monitor
signals/patterns), pattern CRUD (create/update/delete under `/agent-monitoring/patterns`, plus
LLM-assisted regex generation from a plain-language description), AgentsTab (agent list derived
from ingested trace names since self-host has no separate agent registry, per-agent monitoring
profile CRUD, approval policy, and a real health-rate computation backed by a "healthy-response"
tally `runMonitorCheck` now records for traces that match nothing, same as the hosted product),
and per-signal triage (status updates, human feedback with LLM-drafted suggestions) - all
verified via curl against a running engine (including the schema migration path, tested against a
pre-existing SQLite database predating these columns), except the two LLM-assist endpoints'
success path specifically, which needs a real `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` not available
in this environment; their failure path (missing key, signal not found) is verified. All of this
via curl rather than a real browser (also none available here). `/agent-monitoring/estimate` is a
flat stub (self-host has no billing/credits concept) confirmed sufficient for the one dialog that
calls it unconditionally. create-evaluator-from-signal and suggest-expected-results (the
production-to-dataset action behind DraftEvaluatorDialog) are wired up: a signal's evidence
becomes a new test case in a per-agent "Monitor findings: `<agentId>`" dataset (created on first
use, appended to after that), reusing `core/evaluate/datasets.ts`'s `createDataset`/`updateDataset`
 -  verified end to end including through the real dialog (fill human feedback, fill/generate the
expected answer, "Add to dataset", confirmed the new question actually lands in the target
dataset). Pattern `sampleRate`/`scopeMode`/`agentIds` and profile-level
`enabled`/`sampleRate`/`failureDetectionEnabled`/`infoDetectionEnabled` (all persisted since
before, silently ignored before now) are enforced in `core/monitor/routing.ts`/`detect.ts`  - 
verified with statistical sampling tests and agent-scope isolation tests, plus a regression check
that the unconfigured default (sampleRate 1, scopeMode "all") still matches every time, unchanged
from before. One real bug caught late (while building the online-evaluators frontend and checking
what value the real dashboard actually sends): the initial scoping check compared against
`scopeMode === "specific"`, but `AgentX-web-front`'s `PatternApplyToAgentsDialog.tsx`/
`monitoringUnitSettingsUtils.ts` actually write `"selected"` - the first version of this check
would have silently no-op'd agent-scoping for every real dashboard user (only the curl tests,
which used the same wrong string, "passed"). Fixed and re-verified against the real string, same
agent-isolation test as before but now actually exercising the real convention.
`monitor_profiles.channels` entries of the form `webhook:<url>` fire a fire-and-forget,
Slack-compatible JSON POST on every failure-polarity signal (not on the healthy tally) - verified
against a real local HTTP listener, including confirming a healthy trace triggers no delivery.
OverviewTab's KPIs strip/trend chart/top-failing breakdown are backed by a new `monitor_events`
table (one row per detection check, not just matches, pruned per-agent on write against
`profile.retentionDays`) feeding new `/agent-monitoring/kpis`/`/trend`/`/top-failing` routes  - 
verified with seeded traces against hand-computed expected counts (health rate, p95 latency,
tool-failure rate, top-failing agents/patterns/tools). Online evaluators (`monitor_online_evaluators`,
`core/monitor/onlineEvaluators.ts`) are wired up on the backend: a judge config with its own inline
criteria (not tied to a dataset/EvaluationSettings row) scored continuously against sampled live
traffic, distinct from Monitor's pattern-matching above, and
reusing the exact same judge-scoring primitive (`core/evaluate/judge.ts`'s `scoreAgainstCriteria`,
extracted out of `runs.ts`'s offline `scoreOneResult` so both call sites share one implementation).
CRUD at `/agent-monitoring/online-evaluators`, ratings-over-time at
`/agent-monitoring/online-evaluators/:id/ratings`; results land in the same `monitor_events` log,
explicitly excluded from the KPI/trend/top-failing health-rate math above (verified: inserting a
synthetic rated event row left `/kpis`/`/top-failing` output unchanged, and showed up correctly in
`/ratings`). A real dashboard UI now exists too (`AgentX-web-front`, a 4th "Online Evaluators"
sub-view under Evaluate's Runs/Datasets/Evaluator `SegmentedControl`, gated behind `IS_SELF_HOSTED`
since the backend it calls only exists on this engine) - CRUD table, create/edit dialog, and a
ratings-over-time chart (`LazyLineChart`, the first consumer of that primitive in Governance),
verified end to end through the real browser: create, edit, pause, view an empty ratings chart,
delete, each producing the real toast and table update. The Governance header's native
"New evaluation" button (built around picking a native AgentX Agent/Team, which self-host has no
registry for) is now hidden there too, same `IS_SELF_HOSTED` gate. Building the frontend also
caught a real bug in the already-shipped pattern-scoping backend: the `scopeMode` check compared
against `"specific"`, but `AgentX-web-front`'s actual pattern-scoping UI writes `"selected"` - the
original check would have silently no-op'd agent-scoping for every real dashboard user, only
passing because the earlier curl-only verification used the same wrong string. Fixed in
`core/monitor/routing.ts` and re-verified against the real value. Building the online evaluators
backend also surfaced and fixed a separate real pre-existing bug: neither
ingest path (`routes/ingest.ts`, `routes/otlp.ts`) wrapped Monitor's judge calls in a try/catch,
and there's no global Express error handler - a custom pattern's "semantic" detector throwing (e.g.
no `OPENAI_API_KEY` configured) left the request hanging with no response instead of failing
gracefully; same fix also isolates each pattern/online-evaluator's judge call individually, so one
failing check no longer silently skips every check after it for that trace.

Custom monitor patterns gained a fourth condition detector: `external` (`core/monitor/conditions.ts`).
The first three (`phrase`/`regex`/`semantic`) all run logic AgentX itself owns; `external` POSTs
the trace to a URL the user controls and awaits a `{matches: boolean, reason?: string}` verdict  - 
the user's own validation logic, entirely outside AgentX, the same "call out, don't reimplement"
shape as this repo's other integration points. Distinct from `monitor_profiles.channels`'
`"webhook:<url>"` notification targets (`core/monitor/webhooks.ts`): that one is fire-and-forget
and never consumes a response; this one is awaited synchronously and its response *is* the
detection result, so it needed a bounded timeout (fixed 8s via `AbortSignal.timeout`) and a defined
request/response contract, which the notification webhooks never needed. A genuine failure
(network error, timeout, non-2xx, malformed JSON) is deliberately **not** swallowed inside the
detector the way a syntactically-invalid regex is - it propagates the same way a `semantic`
condition's judge-call failure already did, up to `detectCustomPatterns`'s existing per-pattern
try/catch: skip *this pattern* for *this trace*, log clearly, never block ingest or abort the
sweep. Building this surfaced a real, small pre-existing gap while touching the exact same code
path: `semantic`'s LLM judge already returned a `reason` alongside its verdict, but
`evaluateDetector` silently discarded it - fixed alongside `external` (which needed the same
"reason" concept for the feedback the user explicitly asked for), so both detector kinds now
thread their reason through `evaluatePatternConditions` into the resulting signal's `summary`.
Also fixed in the same pass: a stale comment on `PatternRow.sampleRate` claiming scoping/sampling
"aren't read" by `detectCustomPatterns` - false since routing.ts's `matchesAgentScope`/
`passesSampleRate` extraction, the comment just never got updated. Self-host only in the dashboard
(`AgentMonitoringPatternConditionDetectors.EXTERNAL`, gated out of the hosted platform's detector
picker via `SELECTABLE_DETECTORS` in `monitoringPatternConstants.ts`, since the hosted backend has
no route for it) - verified against a real running engine and a throwaway local HTTP listener
covering all four outcomes (match with reason surfaced in the signal summary, explicit no-match,
a 500 response, and a hung connection actually timing out at ~8s), confirmed coexisting correctly
with a same-agent online evaluator on the same ingested traces (matching this session's other
Monitor-plus-Evaluate coexistence check), and confirmed the exact request payload sent matches the
documented schema byte-for-byte, not just structurally. The client-side "test this rule" preview
(`PatternRuleTester.tsx`) can't fake a real HTTP call the way `semantic`'s word-overlap heuristic
loosely approximates a judge, so an `external` condition renders a distinct "can't preview" state
there instead of guessing.

Model portability (`core/evaluate/portability.ts`, `core/evaluate/models.ts`) estimates how a
different model would handle an already-captured trace's input - cost, latency, and a quality
rating alongside what the agent actually returned. Explicitly scoped as an **input-only replay**,
not a full agent re-run: self-host doesn't own the agent, so there's no guaranteed system
prompt/tools/history the way native autotune's `RobotConfig` would have them, only whatever the
trace itself captured. Checked against the real `AgentX-Python` tracer before writing this, not
assumed: the raw Anthropic client patch captures the full `messages` array (multi-turn, though not
Anthropic's separate `system` kwarg), the manual `tracer.trace(input=..., metadata=...)` API is
fully free-form, and the higher-level framework integrations flatten to plain text unless the
caller also passes richer `metadata`. `reconstructMessages` makes a best-effort, multi-shape
attempt at recovering a real conversation from whatever a trace's `input`/`metadata` actually
contains - same defensive "try every known shape" posture `routes/otlp.ts`'s OTel attribute
parsing already uses - falling back to single-turn-text replay when nothing structured is
recognized. Deliberately does not reproduce tool-calling even when tool definitions are found in
metadata (translating an arbitrary captured schema into each provider's own tool format is real,
separate work); found tool definitions are surfaced to the user for transparency instead, not sent
to candidate models. A new plain-completion primitive (`callModelCompletion` in
`core/evaluate/judge.ts`, alongside the existing JSON-schema-constrained `callJudgeJson`) calls
each candidate model with the reconstructed context; every model's output - including the
originally-captured one, re-scored for a fair comparison - is judged with one new no-ground-truth
rubric (`scorePortabilityResponse`) so ratings are directly comparable. Cost is computed from real
measured token usage against a small static price table (`PORTABILITY_MODELS`), explicitly
commented as approximate/point-in-time, not a live pricing feed. Explicit, per-trace,
user-triggered only (never automatic - this is a real multi-model, multi-judge-call action), and
nothing is persisted, same "compute and return" posture as the Prompt Registry's `/propose`. One
model failing (bad key, rate limit, unrecognized id) is isolated per-candidate, same pattern as
`detectCustomPatterns`/`runOnlineEvaluators`, and the trace's own baseline row still renders (cost,
latency, captured output) even when scoring itself fails for lack of a judge key. Verified against
a real running engine: a structured-input trace (message array + `metadata.systemPrompt`)
correctly reconstructed system + full history; a plain-string trace correctly fell back to
single-turn; cost math for the baseline row matched hand computation exactly
(`(120/1e6)×0.15 + (15/1e6)×0.6 = 2.7e-05`, confirmed byte-for-byte against the actual response);
a bogus model id and two real ones with no API key configured all failed cleanly and
independently, with every other row (including the baseline) still rendering correctly. Frontend
(`TracePortabilityDialog.tsx`, opened from a new self-host-only button on the shared
`TraceDialog.tsx`) is `tsc`/`eslint` clean and ships correctly in a `yarn build:selfhost` production
build; not verified with a live browser this session (no automation tool available, same disclosed
gap as every other frontend change today).

The candidate model list + pricing that feature reads from moved from a hardcoded array to a
dashboard-editable table (`portability_models`, both dialects + bootstrap DDL, first migration
this specific table has needed) - a user reported wanting this "in UI as well" rather than a code
change to add a model or fix a stale price. `core/evaluate/models.ts` changed from a static array
+ synchronous lookups to real DB-backed CRUD (`listPortabilityModels`/`getPortabilityModel`/
`createPortabilityModel`/`updatePortabilityModel`/`deletePortabilityModel`); `estimateCostUSD`
stayed a pure function, unaffected. A **one-time seed** (`storage/db.ts`'s
`seedPortabilityModelsIfEmpty`, called once per `initDb()`) inserts the same 7 defaults the static
array used to hold, but only when the table is genuinely empty - implemented with drizzle's own
cross-dialect query builder rather than a hand-rolled conditional multi-row `INSERT` across two
SQL dialects (considered and rejected: correctly scoping a single `NOT EXISTS` check across 7 rows
in raw SQL, with dialect-specific "now in epoch ms" timestamp functions, was real unnecessary
fragility next to just doing a `select().limit(1)` check in TypeScript). Deleting a seeded default
is permanent - it does not reappear on the next restart, confirmed by testing the exact scenario:
create, update, and delete against a real running engine, then re-list. New CRUD routes
(`POST/PUT/DELETE /agent-monitoring/portability/models[/:id]`) mirror Online Evaluators' exact
shape. Frontend: a "Manage models" affordance inside `TracePortabilityDialog.tsx` opens a new
`PortabilityModelsDialog.tsx` (add/edit/delete, inline form) rather than a new top-level nav
destination - this is small supporting config for a trace-detail feature, not a first-class
surface the way Prompts/Online Evaluators are. Verified end to end against a real running engine:
confirmed the 7 defaults seed correctly on a true first boot, full CRUD round-trip (create, 409 on
a duplicate id, update, delete, 404 on an unknown id), and - the part that actually matters - a
real portability check run *after* editing a model's price picks up the new price correctly
(hand-computed `(1000/1e6)×0.5 + (500/1e6)×2.0 = 0.0015`, confirmed byte-for-byte against the
actual response). Frontend `tsc`/`eslint` clean, ships correctly in a `yarn build:selfhost`
production build; no live browser this session, same disclosed gap as above.

The autotune/"Improve" proposal system (candidate branch creation, evaluation, merging)
is explicitly **out of scope**, not deferred: it's fundamentally tied to AgentX's native agent
config-branching system, which self-host doesn't have - the web-front self-host build hides that
tab entirely (`governanceUi.tsx`) rather than shipping a permanently-broken one, and the Governance
header's native "New evaluation" button (also built around picking a native Agent/Team) is hidden
the same way. What autotune's comparison half *does* have a self-host analog for: run the same
external agent twice against a dataset via the SDK, tag each run's `evaluationSubject` with a
version label (`subject={"metadata": {"version": "..."}}`, no SDK changes needed - self-host
extracts `evaluationSubject.version ?? evaluationSubject.metadata.version` at `initRun` time into
a new queryable `evaluation_runs.version` column, the table's first-ever migration), and
`core/evaluate/runs.ts`'s `getVersionComparison` groups results by version and reports
`candidateAvg >= baselineAvg` for the two most recent versions - the same verdict native
autotune's `/validate` computes, just comparing two already-run averages instead of two
branch-scoped evaluations, since there's no config here for AgentX to branch, merge, or apply in
the first place. Exposed at `GET /evaluate/datasets/:id/run-comparison` and a real "Compare
versions" dialog on the Datasets table (self-host-gated) - verified end to end: seeded two
versioned runs with deterministic ratings via direct DB inserts (bypassing the judge, which needs
a real API key not available here) for a passing case, a failing case, and a single-version
"nothing to compare yet" case, all three matched hand-computed expectations; the dialog itself
confirmed against the real running dashboard. A prompt registry now exists too (`core/evaluate/prompts.ts`, `prompts`/`prompt_versions`
tables), the piece version-comparison above didn't have: since this engine doesn't own the caller's
agent code, the fix is to become the prompt's source of truth instead, so the agent's own code
pulls a version at runtime, then treat "optimization" as propose, human-approve, publish a new
version to that registry, never a direct edit to the caller's deployed code.
`client.evaluations.prompts.get(name_or_id)` (new `PromptClient` in `AgentX-Python`, SDK-facing
`POST/GET /prompts`, `GET /prompts/:identifier?version=N` in `routes/evaluations.ts`, accepting either
the prompt's name or its id, name tried first then id as a fallback, see `getPromptRowByNameOrId` in
`core/evaluate/prompts.ts`, deliberately read-mostly, no SDK-side publish) pulls a version's text
for the caller's own agent to use as its
system prompt, and `POST /prompts/:id/propose` (dashboard-only) reuses the *existing* judge
primitive (`core/evaluate/judge.ts`'s `callJudgeJson`) to pull the worst-rated eval results tagged
`evaluationSubject.metadata.promptName === <name>` and ask a judge for a full rewrite plus
reasoning - returned for review, never written until a human explicitly calls
`POST /prompts/:id/versions` (source `"manual"` for a hand-edit, `"proposed"` to accept a
suggestion). Deliberately does not duplicate the "which version won" comparison: tag a run's
existing `metadata.version` as `<promptName>@v<N>` and the already-built version-comparison dialog
above shows it with zero changes there. Verified on the engine side via curl (create, pull default
vs an explicit historical `?version=`, list, manual publish bumping the version, dataset-scoped and
unscoped `/propose` correctly finding/excluding seeded low-rated results, delete cascading to
`prompts`/`prompt_versions` and 404ing the SDK pull afterward) and via a real `AgentX-Python`
`EvaluationsClient` round-trip against the running engine (`create` → `get` → `list`, not just the
HTTP layer). No `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is available in this environment, so
`/propose`'s actual judge call was verified up to (and including) its clean "needs an API key" setup
error rather than a real generated rewrite - same disclosed limitation as `/agent-monitoring`'s
LLM-assist endpoints above. The dashboard UI (`EvaluateTab`'s 5th self-host-only sub-view,
`PromptsTab`/`PromptsTable`/`PromptEditorDialog`/`PromptHistoryDialog`/`PromptProposalDialog`) is
verified via a self-host production build (`yarn build:selfhost`) succeeding, `tsc`/`eslint` clean,
and the built bundle - served through the real compiled dashboard path - confirmed to actually
contain the new dialogs' copy in the correct lazy-loaded chunk; unlike the online-evaluators UI
above, this session had no real browser automation available, so the dialogs' actual click-through
behavior (open/submit/close, real toasts) is **not** verified end to end yet, only statically.

There's now a second, judge-key-free way to drive the same propose-improvement loop: a Claude Code
skill (`skills/improve-prompt/SKILL.md`) that reads real evidence and lets Claude's own reasoning
stand in for a separate judge API call
(no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` needed on the engine at all), show the user a rewrite, only
publish on explicit approval. Required extracting the "gather this prompt's worst-rated examples"
half of `proposePromptImprovement` into its own `getWorstRatedExamples` (`core/evaluate/prompts.ts`)
so it has no judge call in it, exposed as a new `GET /prompts/:id/examples` route
(`routes/evaluateDashboard.ts`) that both `/propose` and the skill now call - one implementation,
two callers. The skill discovers its own connection info (reads `apiKey` straight out of
`$AGENTX_HOME/config.json`, same file `src/auth/apiKey.ts` writes on first run; base URL defaults
to `AGENTX_API_BASE_URL`/`http://localhost:4700/api/v1`, same convention the SDK itself uses) and
publishes through the exact same `POST /prompts/:id/versions` the dashboard's own "Publish as new
version" button calls - a rewrite only ever reaches storage through that one human-approved write
path, regardless of which surface produced it. Verified: `GET /prompts/:id/examples` cross-checked
against `/propose`'s internal data for the same seeded low-rated results (unscoped, scoped to the
matching dataset, scoped to an unrelated dataset, and an unknown prompt id, all matching
expectations), and every curl command written into the skill file was run against the real running
engine and confirmed to match its actual request/response shape exactly - not trusted from memory.
Not verified: an actual live Claude Code session running the skill end to end, which needs a
separate session to drive (same disclosed gap as the dashboard UI's click-through above).

A follow-up quality pass on this skill (explicitly requested, since it's the primary judge-key-free
path to "autotune" self-host has) caught two real correctness bugs before either shipped further:
(1) the original draft wrote the publish step's request body as an inline `curl -d '{"text":
"..."}'` shell string with the rewritten prompt substituted directly in - since prompt text is
free-form natural language, any apostrophe or embedded quote (`"don't"`, `"you're"`, a judge-style
`"say \"I don't know\""`) breaks that string outright; reproduced the exact failure (a raw
body-parser `SyntaxError` HTML page, not even a clean JSON error) against the real engine, then
fixed it to have the skill write the JSON body to a file via Claude's Write tool and send it with
`curl --data-binary @file` instead, which round-trips arbitrary text (quotes, apostrophes,
newlines, all tested together) with zero shell-escaping involved. (2) The original draft also
implied `$API_KEY`/`$BASE_URL`/`$PROMPT_ID` were shell variables set once and reused across later
steps - but Claude Code's Bash tool does not share shell state between separate calls (only the
working directory persists), so those "variables" would have silently been empty by the time a
later step actually ran. Rewrote every step to show explicit `<PLACEHOLDER>` values instead, with
an explicit instruction to substitute the literal value read earlier rather than rely on export
surviving. Re-verified the full corrected flow against a running engine end to end (list → fetch
examples → publish with the exact adversarial text above), confirming the version actually bumped
and the text round-tripped byte-for-byte.

A later pass rebuilt "Suggest improvement"/`GET /prompts/:id/examples`'s evidence-gathering
(`getWorstRatedExamples`, `proposePromptImprovement` in `core/evaluate/prompts.ts`) after two real
gaps were found by inspection: it only ever looked at deliberate, on-demand Evaluate runs - Online
Evaluator ratings on real production traffic never fed in at all - and its only filter was "which
dataset," never "which prompt version," so a v3 prompt's rewrite could get polluted by worst-rated
examples from a v1 run whose issues v2/v3 may have already fixed. Now: eval-run examples default to
the current published version only (`run.version === "<name>@v<currentVersion>"`, the same tag
`metadata.version` convention the version-comparison feature already used), auto-widening to every
version if that's fewer than 3 examples so a brand-new version isn't left with nothing to learn
from; Online Evaluator examples are pulled from `monitor_events` in a caller-chosen time window
(default 7d) and joined back to `traces` via the existing `getTraceRow` (no schema migration  - 
`monitor_events` has no input/output text of its own, and `traces` already does) to find rows whose
trace was tagged `metadata.promptName === <name>`, same tagging convention as eval runs, confirmed
the Python SDK's `client.tracer.trace(name, metadata={...})` already supports with zero SDK
changes. Both example sets share one 0-10 rating scale already (both go through
`core/evaluate/judge.ts`'s `scoreAgainstCriteria`), merge, sort worst-first, and cap at 20; the
response now reports `scope: { versionScoped, window }` and `sourceBreakdown: { evalRun,
onlineEvaluator }` so a caller can see what was actually used instead of it changing silently. The
dashboard's `PromptProposalDialog` dropped its "Dataset" dropdown (the wrong axis, and confusing as
the only control) for a time-window picker scoping just the Online Evaluator half, plus a line
showing the real breakdown and whether it fell back to all versions. Verified live end to end
against the running engine, not just typechecked: version-scoping correctly auto-widened on real
pre-existing data (four examples all tagged `@v1` while the prompt had already moved to `v2`);
ingesting a real trace tagged with the prompt's name and a deliberately bad response scored it 0/10
through a live Online Evaluator and it showed up merged and sorted first; the follow-on `/propose`
call's judge reasoning explicitly cited fixing that exact worst example, confirming the merge
changes the actual rewrite, not just the count. One real bug surfaced during this verification pass
(unrelated to the feature logic itself): `tsx watch`'s restart hit `EADDRINUSE` mid-edit and crashed
outright rather than retrying, silently leaving a stale process serving old code on the same port  - 
caught because the new Online Evaluator examples weren't appearing, traced to the crash, not a code
defect.

EvaluateTab's "Runs" and "Datasets" sub-views are wired up
against a new `/api/v1/evaluate` router (`routes/evaluateDashboard.ts`) reusing the same
`core/evaluate` modules the SDK-facing router already used - dataset CRUD (list/get/create/update,
a dataset+evaluationSettings twin sharing one id, same pattern the hosted SaaS's
`upsertDatasetTwin` uses) and a flat run list/detail with real per-question results, verified with
a real headless browser against a real SQLite-backed engine, including submitting the real
create/edit dialogs and opening a run's detail view - not just curl. EvaluateTab's third sub-view,
"Evaluator" (a standalone grading config with no dataset attached), was out of scope at the time
this paragraph was first written - a later pass built it for real (see below). Dataset/config
version history was also out of scope at the time (the version-history and batch-version-count
endpoints those dialogs call unconditionally on open were stubbed to return empty rather than left
to error) - a later pass built that for real too (see below). What's still
explicitly out of scope, not deferred: anything tied to AgentX's native agent-building/
config-branching system (agentConfigVersion, robotConfigBranch, evaluationSettingsConfigVersion,
datasetConfigVersion, agent/team-scoped run endpoints - self-host has no agent/team registry or
config-branching at all).
The self-host build still ships eval-front's full ~30-route bundle rather than a build trimmed to
just Governance (that pruning is tracked as its own follow-up in that repo); there's no hot-reload
loop between an `AgentX-eval-front` dev server and this engine yet (see "Running from source"). Also not yet done: the install script,
Homebrew formula, and `build.sh`'s download fallback are structurally correct and match each
other's expected asset names/layout (verified: `build.sh`'s fallback path was exercised directly
against the real, currently-release-less repo and degrades to an API-only build as designed,
rather than crashing), but none of them have been exercised against a real GitHub release with
real `agentx-web.tar.gz`/`agentx_<os>_<arch>.tar.gz` assets attached (none published yet, and the
`publish-selfhost-web.yml` workflow that would produce the former hasn't been run, since it needs
a one-time `SELFHOST_RELEASE_TOKEN` secret set up in `AgentX-eval-front`'s repo settings first, see
"Dashboard release"); Guardrail isn't started (see the plan, it
doesn't exist yet even on the hosted SaaS); Evaluate's async whole-run analysis
(`analyze_run`/`get_report`) is deliberately out of scope for now.

An explicit request to re-audit every self-host feature specifically for the "external agent, not
an AgentX-registered one" premise (`AgentX-web-front`'s Governance UI reused for self-host, not
this repo) surfaced five real bugs, all pre-existing (not introduced by any change described
above) and all now fixed:

1. **`AgentsTab.tsx`** (both desktop and mobile row rendering): every agent's name linked to
   `ROUTES.editAgent(unit._id)`, the native agent editor - but self-host's `unit._id` is always
   just a trace name (`core/monitor/agents.ts`'s `listAgentsWire` always sets `agentType:
   "external"`, confirmed by reading it fresh), not a real agent id. Every agent in the most basic
   Monitor list was a dead link. Fixed: an `editHref()` helper only links when `agentType !==
   "external"`, otherwise renders plain text.
2. **`SignalRow.tsx`**: the same class of bug for each signal's agent name - `MonitoringAgentRef`
   carries no per-item "external" flag to check, so this gates on `IS_SELF_HOSTED` outright instead
   (self-host never has a native agent to link to, full stop).
3. **`MonitoringUnitSettingsFields.tsx`**: the "Approval policy" section showed all 8
   `AGENT_MONITORING_APPROVAL_ACTIONS` toggles unconditionally, but self-host's engine never reads
   `approvalPolicy` for any decision at all (`core/monitor/profiles.ts` only stores/round-trips
   it) - every toggle was a silent no-op, and 6 of the 8 actions (candidate branch creation/merge,
   production promotion, ...) are native-autotune-only concepts self-host doesn't have regardless.
   Hidden entirely for self-host, same treatment as "Improve"/"New evaluation" elsewhere.
4. **`EvaluationsTab.tsx`**: the "No evaluations found" empty state's "Create Your First
   Evaluation" button was a second, unguarded way to open the same native-agent-picker
   `CreateEvaluationDialog` the header's copy of this button is already correctly hidden for - and
   since it's the empty state, it's exactly what a brand-new self-host user's first visit to Runs
   would show. Fixed: self-host sees SDK guidance (`client.evaluations.run(...)`) instead.
5. **`EvaluateTab.tsx`** (the most significant): the "Evaluator" sub-view (standalone grading
   configs with no dataset attached) has been documented everywhere - this README, the mintlify
   docs, `routes/evaluateDashboard.ts`'s own header comment - as explicitly out of scope for
   self-host, not deferred. It was never actually excluded from `VIEW_OPTIONS`: fully visible and
   clickable in self-host this entire time. Worse than a dead end - its create flow would have
   silently created an unwanted dataset+settings twin every time (self-host's only creation path,
   `POST /evaluationSettings/create`, always creates both together; there's no config-only path),
   directly violating the "standalone config" concept the tab claims to offer. Fixed *at the time*:
   added to a `HOSTED_ONLY_VIEWS` filter, the mirror image of the existing `SELF_HOST_ONLY_VIEWS`
   one - hidden rather than built, since building a real config-only creation path wasn't in scope
   for that pass. **Superseded by a later pass** (see the "make self-host support it" work further
   down): a real `POST /evaluationSettings/create-standalone` route now exists
   (`core/evaluate/evaluationSettings.ts`), `HOSTED_ONLY_VIEWS` no longer excludes it, and the tab
   is fully functional for self-host - this item is kept for the historical record of the bug, not
   as a description of current behavior.

All five re-verified: `tsc`/`eslint` clean, a full `yarn build:selfhost` production build succeeds.
Not re-verified with a live browser (none available this session, same disclosed gap as the
Prompt Registry UI above) - these are confirmed-correct by re-reading the actual conditional logic
and cross-checking it against the real backend behavior described above, not by clicking through
the running app.

A later pass actually built the "Evaluator" sub-view (bug 5 above only ever hid it) - the user
asked directly why it had disappeared, which is what surfaced that it had been out of scope this
whole time rather than genuinely broken. `core/evaluate/evaluationSettings.ts` gained `isDefault`/
`status` columns (migration, both dialects) and a real `POST /evaluationSettings/create-standalone`
route (`routes/evaluateDashboard.ts`) that creates a bare `evaluation_settings` row with no dataset
twin - the underlying table already supported this shape for the SDK's `EvaluationSettingsBuilder`,
only the dashboard-facing creation path was missing. `GET /evaluationSettings` now actually honors
`kind=config|dataset|all` instead of always returning everything (or, for `kind=config`, a
hardcoded empty list). The single-default invariant (at most one config marked `isDefault` at a
time) is enforced server-side on both create and update. `PUT /evaluationSettings/:id` now branches
between the pre-existing dataset-twin full-replace path (unchanged) and a new sparse-merge path
(`patchEvaluationSettings`) for standalone configs - needed because the dashboard's "Make default"
action sends a partial payload (`{isDefault: true}` alone), which the old full-replace logic would
have nulled every other field out to satisfy. `HOSTED_ONLY_VIEWS` no longer excludes `"config"`.
Verified live against the real local `~/.agentx/agentx.db` (not just curl against throwaway data):
created a real config, confirmed `kind=config`/`kind=dataset` filters actually differ, created a
second config with `isDefault: true` and confirmed the first one's default was cleared, sent a
bare `{isDefault: true}` PUT and confirmed every other field survived untouched, and confirmed the
pre-existing dataset-twin PUT path is completely unaffected by the branch.

A later pass reworked "Suggest improvement" again, this time to stop hiding the evidence behind the
judge call. `GET /prompts/:id/examples`'s `WorstRatedExample`/`getWorstRatedExamples`
(`core/evaluate/prompts.ts`) gained a stable `id` (the underlying `evaluation_run_results.id` or
`monitor_events.id`) and `createdAt`, so the dashboard's evidence list can load and render
immediately when the dialog opens (a real data read, no judge call) instead of only appearing
after "Generate suggestion" ran. `POST /prompts/:id/propose` now accepts an optional `exampleIds`
list, filtering `gathered.examples` down to a human-picked subset (checkboxes in the new evidence
panel, source-filterable All/Production/Eval runs) before building the judge prompt, so a rewrite
can be scoped to specific examples instead of always using everything gathered. The judge call's
JSON schema grew a structured `changes: {tag: "added"|"tightened"|"removed", text}[]` array
alongside the existing freeform `reasoning`, and the response now echoes the actual `judgeModel`
used instead of the dashboard hardcoding a label. A new `getFailureThemes`/`GET
/prompts/:id/themes` runs a second, purely informational judge pass clustering the same evidence
into 3-6 named recurring failure modes (`clusterFailureThemes`) for the evidence panel's "Failure
themes" bar chart, never affects the actual rewrite, which still reads the individual examples'
justifications directly. On the frontend, `InstructionDiffViewer.tsx` (previously read-only, shared
with the hosted-parity instruction-diff dialog) gained an `editable` mode: added (+) lines render
as an inline-editable textarea instead of static text, with the diff's row/hunk structure computed
once per generation (keyed off the frozen judge output, never the live-edited text) so a keystroke
never reshuffles rows or steals focus: only regenerating produces a new diff. Removed and
unchanged lines stay read-only. Verified live end to end against the running engine: fetched real
examples with `id`/`createdAt` populated, called `/propose` with a 2-of-4 `exampleIds` subset and
confirmed the response's `examples`/`exampleCount`/`sourceBreakdown` reflected exactly that subset
(not the full gathered set), confirmed `/themes` returns real named clusters (not fixture data) for
seeded low-rated examples, and confirmed `changes`/`judgeModel` round-trip correctly. One process
bug, not a code bug: a mid-session correction to a SQLite migration line (removing an accidental
`NOT NULL`) was skipped as a "duplicate column" no-op because `tsx watch` had already applied the
first, wrong version to the local dev database before the fix landed, caught via `PRAGMA
table_info`, fixed by rebuilding the affected table directly (SQLite has no `ALTER COLUMN DROP NOT
NULL`), a reminder that this migration pattern is only idempotent against a *stable* migration list,
not one still being edited live against a running watched process.

The same pass closed a real UX gap the user flagged directly: pattern matches always show up in
Signals for triage, but Online Evaluator scores never did: the only way to see one was opening
that evaluator's own ratings dialog. `monitor_online_evaluators` gained `alertThreshold` (nullable,
default 5) and `severity` (default `"medium"`) columns (both dialects, migrated the same
`ADD COLUMN`-per-line way every other post-ship column here has been). `runOnlineEvaluators`
(`core/monitor/onlineEvaluators.ts`) now calls the same `upsertSignal` pattern-matching already
uses whenever a score falls below `alertThreshold`, reusing the score event's own `patternKey`
(`online-eval:<evaluatorId>`) as the dedup key, so a recurring low score accumulates
`occurrenceCount` on one signal instead of spawning a new row per trace, exactly like a pattern
match. `alertThreshold: null` opts an evaluator out entirely (scores without ever raising a
signal). Dashboard: the evaluator editor gained a threshold slider and a 4-level severity picker
(no "Info" tier: a low score is always a failure, unlike a pattern's optional "proper" polarity);
the Signals list resolves an evaluator-sourced signal's display name from the evaluator itself
(not a generic "Triggered pattern" fallback) and tags it "LLM judge"; "View triggered pattern" on
one of these now opens that evaluator's ratings dialog (`OnlineEvaluatorsTab`'s new
`evaluatorIdToView`/`onEvaluatorViewed` props, the same mechanism `PatternsTab`'s
`patternToView`/`onPatternViewed` already used) instead of landing on an empty Patterns view.
`AgentX-Python`'s `MonitorOnlineEvaluatorBuilder`/`MonitorOnlineEvaluatorClient.update` gained
matching `alert_threshold`/`severity` parameters. Verified live end to end, including through the
real SDK, not just curl: raised the threshold on a real evaluator, ingested a genuinely bad trace,
confirmed a signal appeared with the evaluator's name and correct summary/severity; ingested the
same bad trace again and confirmed `occurrenceCount` incremented instead of duplicating; and
round-tripped `alert_threshold=None` (disable) through `client.monitor.online_evaluators.update`
and back to a real number, confirming the opt-out path works through the SDK, not just the REST
shape.

A user report ("dataset versioning is broken") led to rebuilding this from the ground up rather
than patching around it. Investigation found two separate things: a real routing bug (`GET
/evaluate/datasets/batch/versions` had no dedicated route, so Express matched it against
`/datasets/:id/versions` instead, treating "batch" as a dataset id and returning `[]` instead of
the `{versionCounts}` shape the frontend's `useGetDatasetBatchVersionCounts` expects - fixed by
adding the missing route, mirroring the `evaluationSettings` side's already-correct ordering), and
the deeper issue: there was no real version-history feature behind the stubs at all, by original
design (see the now-corrected claim above). Rebuilt for real: two new tables (`dataset_versions`/
`evaluation_settings_versions`, both dialects), `core/evaluate/versions.ts` recording a new
version on every create (seeded immediately, `changeSummary: "Created"`, so a fresh dataset's
history is never empty) and every edit that actually changes a tracked field (a plain synchronous
field-diff, e.g. `"Updated acceptance criteria, judge model"` - deliberately not an LLM call the
way the hosted SaaS's async summary generation is; self-host doesn't need that cost/latency for a
computed diff, and it's available on the very first fetch instead of the frontend's
poll-until-present logic actually having to wait). A no-op save doesn't create a version. Applies
uniformly to both a dataset's twin config and a standalone Evaluator config - missing from the
dashboard entirely before this, `useGetEvaluationSettingsBatchVersionCounts` existed and was fully
wired but literally unused in any component; wired into `EvaluationConfigsTab.tsx`'s row list to
match `EvaluationSettingsTab.tsx`'s existing badge. `codeScorers` (see below) is captured in the
snapshot too, so restoring an old version doesn't silently drop custom scorers. Verified live
against the running engine: creation seeds v0/"Created" immediately, real edits produce accurate
diffs newest-first, a no-op save adds nothing, delete removes exactly the targeted version and is
idempotent (`{deleted: false}` on a second attempt), and the same flow works identically for a
standalone Evaluator config.

Judge scoring and 4 fixed similarity metrics (vector/Jaccard/BLEU/ROUGE) don't cover every
scoring need: exact format checks, word-count thresholds, and non-linear scoring logic are all
easier to express as a few lines of code than to coax out of a judge prompt or a similarity
metric. Added as a 5th scorer kind, alongside the existing ones, not replacing them: `codeScorers` (array of `{id, name,
code, enabled}`) on both `datasets` and `evaluation_settings` (two-dialect migration, same pattern
`similarityConfig` set), `core/evaluate/codeScorer.ts`'s `runCodeScorer` executes a scorer's
`code` as a function body via Node's built-in `vm` module - `node:vm`, not a subprocess, since the
engine ships as a single Bun-compiled binary specifically so end users never need Node/Bun/Python
installed, and shelling out to an interpreter would break that. Sandboxed context with no
`require`/`fetch`/`process`/filesystem access and a 3-second timeout (`vm.Script`'s `timeout`
option only bounds synchronous execution, which is why the scorer contract is synchronous-only  - 
an async scorer awaiting a hung `fetch()` would sail past a timeout anyway, so the sandbox simply
removes the ability to go async in the first place). A lighter security bar than a hardened
isolate, appropriate for self-host's single-tenant, operator-trusted model - the same trust
assumption `core/monitor/conditions.ts`'s `callExternalValidator()` already makes for
user-supplied logic elsewhere in this engine. Each scorer's own failure (throw, timeout, bad
return shape) isolates to `{score: null, error}` for that one scorer, never blocking the judge
rating or the dataset's other scorers. Dashboard: a Monaco-editor-backed "Code Scorers" section on
both the Datasets and Evaluator config dialogs (same `@monaco-editor/react` pattern already used
for tool code elsewhere in the app), and dynamic per-scorer result columns in the run-comparison
view. Verified live: a throwing scorer and a `while(true){}` infinite-looping one both resolved to
`{score: null, error}` within the 3-second timeout (confirmed the wall-clock time, ~3003ms)
without affecting the item's judge rating or its other scores; confirmed `node:vm` behaves
identically inside the actual Bun-compiled `agentx-engine` binary, not just under `tsx` dev - the
one real platform-compatibility risk this design had.

A scratchpad for testing a prompt/model against real dataset test cases before committing
to a full eval run, without needing an SDK-driven agent at all - self-host calls the model
directly. `core/evaluate/playground.ts`'s `runPlayground` reuses the existing
`callModelCompletion`/`scoreAgainstCriteria`/`estimateCostUSD` primitives wholesale (the same ones
Model Portability already established) - no new provider-calling code. One new endpoint, `POST
/evaluate/playground/run`, deliberately kept single-cell (one model, one question, one prompt, no
batching): the dashboard's Playground tab is a real questions-×-models grid, but the grid
orchestration lives entirely in the frontend, firing one call per cell to
this same stateless endpoint, so the backend never needed any batch/queue logic of its own.
Nothing is persisted, same "compute and return" posture as Model Portability's own comparisons.
Two follow-up passes closed real gaps: code scorers (above) are now threaded through Playground's
request/response alongside judge scoring, always
running independent of whether the question has an expected answer (a scorer like "output is
non-empty" doesn't need one); and the grid gained a client-side concurrency cap
(`CONCURRENCY_LIMIT = 4`, a bounded worker pool replacing the original "fire every cell
simultaneously" design) since an unthrottled large grid risks tripping real provider rate limits.
Cells now show a "Waiting…"
queued state and fill in as earlier ones finish rather than all appearing to hang at once; a
`runGeneration` guard means clicking "Run grid" again mid-flight can't let a stale, abandoned
run's late results land on the new one. Lives as its own top-level Governance tab (not nested
under Improve, per direct user feedback), filtered out of the tab list entirely for hosted rather
than branching content per-mode the way Improve does - there's no hosted backend for it at all.
Verified live: multi-turn messages with few-shot examples, both OpenAI and Anthropic models
routed correctly through the same endpoint, automatic judge scoring only when `expected` is
present, code scorers running with and without an expected answer, a clean `{error}` response (not
a 500) for an invalid model id, and confirmed zero rows land in any table for any of it.

Playground's Results view was a table only, no way to compare latency, judge score, and cost
across models and cases without eyeballing every cell. Landed as a single
grouped bar chart (`PlaygroundCaseBreakdownChart.tsx`) with a Latency/Score/Cost toggle, one group
per case, one bar per model within each group, colored consistently with `colorForModelIndex`
(extracted to a shared `modelColors.ts` so a model reads as the same color here and in
`OverviewCostChart`, instead of two independent palettes). The aggregate "which model should I
use" comparison lives in the same chart rather than a separate one: a pinned "Average" group,
computed across every case in the run, sits first on the x axis ahead of the individual cases,
so switching the metric toggle updates both the average and the per-case detail together. Went
through two earlier shapes before landing here, both reverted on direct feedback: three separate
always-on bar charts (one per metric, per-model average only, no per-case detail) turned out
redundant with the grouped chart once it existed, since both were "per-model, per-metric"
comparisons at different granularities; a cases-by-models heatmap (value-coded cell color, no new
dependency, considered as a way to read many cases/models at once without horizontal scrolling)
was tried in its place and rejected in favor of keeping bar charts specifically. Pure aggregation
functions (`computeCaseSeries`/`computeModelAverages` in `playgroundChartData.ts`) are unit-testable
independent of rendering; null-safe throughout, since latency/score/cost are each independently
nullable per cell (an errored cell, or a query-mode case with no `expected` never getting a
rating). No new charting library: reuses the existing `LazyBarChart`/`useChartOptions` chart.js
wrappers `OverviewCostChart` already established.

Custom pattern conditions had an `external` detector - POST the trace to a URL you control,
use its `{matches, reason}` response as the verdict - buried as one row-type choice inside a
Pattern's AND/OR/NOR condition builder alongside phrase/regex/semantic, with no SDK path that
ever created one. Promoted to a first-class sibling of Patterns/Online Evaluators/Topics called
**Custom Evaluators**: its own `custom_evaluators` table, its own CRUD module
(`core/monitor/customEvaluators.ts`, modeled directly on `onlineEvaluators.ts` - name, url,
sampleRate, scopeMode/agentIds, enabled, severity, plus an `invertMatch` boolean replacing the
old per-condition `negate` flag), and its own ingest-time runner (`runCustomEvaluators`, registered
at both `routes/ingest.ts` and `routes/otlp.ts` fire-and-forget sites, isolated per-evaluator
try/catch so one dead endpoint never skips the rest). A `matches: true` (or `false`, if inverted)
verdict raises a Signal (`patternKey: custom-eval:<id>`, deduped like any other); every check  - 
hit or not - is also recorded to `monitor_events` via a new `customEvaluatorId`/`matched` column
pair, excluded from KPI/health-rate classification math the same way `onlineEvaluatorId` rows
already are. The response contract gained one addition over the old `external` detector's:
an optional `score: number`, recorded and shown on the resulting signal's summary but never part
of the hit/no-hit decision itself (`matches` alone still decides that) - a deliberate scope
choice over a full Online-Evaluator-style numeric threshold, since the point was staying simple
to onboard. Onboarding was the other explicit goal: the create/edit dialog documents the exact
request/response JSON contract in place (not just a one-line hint the old Pattern-condition row
had) and adds a **Dry run** button - a new transient `POST /custom-evaluators/dry-run` route that
POSTs a synthetic sample payload to the URL and returns the live response (or error) for display,
nothing persisted, same "never throw, always renderable" posture `testCustomModelConnection`
already established for Model Portability's "Load model" check. `external` was fully deleted from
`core/monitor/conditions.ts` (not deprecated - confirmed nothing used it), so `PatternCondition`
is back down to three detector kinds. Frontend-gated entirely behind `IS_SELF_HOSTED` at
`governanceTabViews.ts`'s single `MONITOR_VIEWS` source, since - unlike Online Evaluators, which
`AgentX-web-api` ported - there's no hosted-platform backend for this at all. Verified live end to
end against a local test HTTP server: dry run returned the live response inline, a real ingested
trace produced a Signal with the evaluator's name, severity, and `(score: N)` folded into its
summary, the per-evaluator events endpoint returned the same check with its score, and neither
polluted the KPI totals.

Cost estimation only ever priced `inputTokens`/`outputTokens` at one flat rate each, silently
overestimating any traffic using prompt caching (a cache read is the entire point of caching and
costs a fraction of a regular input token). The Python SDK's Anthropic integration was summing
`cache_creation_input_tokens`/`cache_read_input_tokens` straight into `input_tokens`, destroying
the split before it ever left the client; OpenAI/LiteLLM/Google GenAI integrations didn't read
their own cache fields at all. Fixed at every layer without changing `inputTokens`'s existing
meaning (still the full total - cache portions are a subset, not an addition): the SDK now reports
`cache_read_tokens`/`cache_write_tokens` as their own fields end-to-end (`_traced_call.py` →
`tracer.py`'s span/child-span/`_send` plumbing), each provider integration extracts them from its
own usage shape (`cache_creation_input_tokens`/`cache_read_input_tokens` for Anthropic,
`prompt_tokens_details.cached_tokens` for OpenAI/LiteLLM, `cached_content_token_count` for
Google), `traces` and `portability_models` both gained nullable columns for the counts/rates, and
`estimateCostUSD` (`core/evaluate/models.ts`) now subtracts the cache portion from regular input
before applying each rate - falling back to the model's normal input rate whenever a cache rate
isn't configured, so an unconfigured model prices byte-identical to before this shipped. The trace
detail view gained a "Cached tokens" stat tile (`N read · M write`) and Platform Settings' model
pricing panel gained optional `$/M cache-read`/`$/M cache-write` fields. Verified against a real
Anthropic call (a >2048-token repeated system prompt to clear the provider's cache-eligibility
floor): the first call reported an 8018-token cache write, the second an 8018-token cache read,
both landed in the traces row correctly, and a configured-vs-unconfigured cost comparison on the
same token counts ($0.001665 vs. the unconfigured fallback of $0.00018, matching the pre-existing
flat-rate formula exactly) confirmed both the discount and the regression guard.

Monitor's project-level sample rate (Platform Settings > Monitoring Defaults) turned out to be a
silent no-op for most traffic. `runMonitorCheck`'s gate read `if (profile &&
!passesSampleRate(defaults.sampleRate))`, so it only applied to agents that happened to have a
`monitor_profiles` row - and nothing writes one on ingest, only an explicit profile PUT or
`core/seed.ts`. Left over from when the always-on monitor-checks change removed the
`ctx.requireEnabledProfile` gate above it: harmless while "no profile" still meant "skip", but it
inverted the setting's meaning once every ingested trace was checked. On a default install,
turning coverage down to 10% (or 0%) changed nothing. Measured before the fix at `sampleRate: 0.5`
over 300 failing traces each: agent without a profile row 300/300 monitored, agent with one
145/300, agent-less traces 300/300. Fixed by dropping the `profile &&` prefix from the sampling
gate only - the `profile && !profile.enabled` check above it stays, since an explicitly disabled
profile is still the per-agent opt-out.

Two related things left alone deliberately. `pruneRetentionData` is still called under
`if (profile)`, so the project's `retentionDays` also only prunes for profiled agents - same root
cause, but unblocking it starts *deleting* traces/events for agents that were never pruned before,
which is a data-loss decision to make on its own. And the SDK-facing `POST
/api/v1/monitor/patterns` still doesn't forward `sampleRate`/`scopeMode`/`agentIds`, with no
pattern PUT/PATCH/DELETE on that router at all, so per-pattern sampling remains dashboard-only;
no route validates `sampleRate` into `[0, 1]` either, where a stored `-1` silently means "monitor
nothing" and a `50` (a UI sending percent) silently means "monitor everything".

This is also the engine's first test suite: `routing.test.ts` (unit tests for
`passesSampleRate`/`matchesAgentScope`, including out-of-range and NaN semantics and a guard for
the `"selected"` vs `"specific"` scope-string bug recorded above) and `detect.test.ts`
(`runMonitorCheck` against a real temporary SQLite database - project-rate sampling with a profile
row, without one, and with no agentId; rates 0 and 1; the disabled-profile opt-out; per-pattern
sampling; and the deliberate `pattern_ids` bypass). `Math.random` is stubbed with a seeded PRNG so
the statistical assertions are deterministic rather than flaky, and all four project-rate tests
were confirmed to fail against the old gate (200/200 and 20/20 monitored where ~100 and 0 were
expected) before the fix went in. `engine`'s `test` script drops `--passWithNoTests`, and `build`
moves to a new `tsconfig.build.json` excluding `*.test.ts` so `dist/` stays shipping code while
`yarn typecheck` and editors still cover the tests.

That first suite then grew into a full one, written to find defects rather than to pin down
current behaviour: 35 more vitest files for the engine (424 cases - unit tests for the pure
helpers, plus integration suites that boot the real engine as a subprocess and drive it over HTTP
the way an SDK would), similarity-metric tests for judge-core, and 20 Go tests for the CLI
launcher. Seventeen real defects came out of writing them, each fixed alongside the test that
caught it - the last few only once the suite was running in CI, and the last two only once the
compiled release binary was exercised rather than the source tree. `tsconfig.build.json`'s exclude grew to cover `src/test/` as well as `*.test.ts`, because the
integration harness lives there under names that are not `*.test.ts` and would otherwise have
compiled into `dist/`.

Four surfaced in the first pass. A malformed timestamp took the whole engine down rather than
failing one request: every route handler is `async (req, res) => ...` on Express 4, which does not
catch a rejected handler promise, so `started_at_unix_nano: "yesterday"` on a plain POST reached
`BigInt()`, became an unhandled rejection, and exited Node for every project on the box, skipping
the SIGTERM path entirely (reproduced end to end - the next request gets ECONNREFUSED). Fixed at
the source in `core/shared/unixNano.ts` and closed off behind it: routers are built through
`routes/asyncRouter.ts` so a rejected handler becomes `next(err)`, and `index.ts` turns that into a
500 while passing body-parser's own 4xx through. A monitor pattern's regex could freeze the process
indefinitely - operator-supplied, but matched against agent output, and `(a+)+$` against ~40
characters already outruns any timeout with no way to interrupt a JS regex on a single-threaded
process; `core/monitor/regexSafety.ts` now rejects nested unbounded quantifiers at save time, and
`evaluateDetector` skips one already stored. A missing judge API key threw away scores that never
needed one, because the judge call shared a `Promise.all` with the similarity metrics and code
scorers, so one rejection dropped all of them. And `codeScorer.ts` claimed a sandbox it does not
have: `node:vm` is not a security boundary, and a scorer reaches the real `process` through any
object's prototype chain (checked, not assumed) - the trust model is a deliberate choice, but the
comment stated the opposite.

The most productive pattern by far was read-then-write races that SQLite structurally cannot show.
`better-sqlite3` is synchronous, so a SELECT followed by an INSERT never interleaves; on Postgres
every query yields, and five of these turned up once the suites ran against a real server. Trace
ingest checked for an existing `span_id` and then inserted, so concurrent exports of the same span
created duplicate traces. Agent auto-registration did the same on name, so one agent's traces
split across two rows - fixed with a deterministic id, `sha256(projectId, name)`, rather than a
lock. The prompt and tool-schema registries both read the current version and then wrote
`version + 1`, so simultaneous publishes collided on the unique index or silently reused a number;
both now retry against a `lt(currentVersion, nextVersion)` guard so a version only ever moves
forward. Monitor signals lost detections outright: a concurrent first-sighting dropped one row and
left the other's `occurrence_count` at 1, now an `onConflictDoNothing` plus a `count + 1` in SQL
rather than in JS. All five are covered by tests that skip without `AGENTX_TEST_DB_URL`, and all
five were confirmed to fail against the old code on Postgres and to pass on SQLite either way,
which is exactly why they had survived.

The rest: `AGENTX_AUTH=enabled` was broken outright against better-auth 1.7, which expects an
`issuer` column on `auth_account` and `created_at` on `auth_invitations` that the DDL never
created - added to both dialects with a backfill for existing installs, and a schema-parity test
that reads `getAuthTables` from better-auth itself so the next version bump fails loudly instead of
at runtime. An OTLP export sent with the wrong content type was answered 200 and dropped on the
floor; it is a 415 now. Outbound webhooks had no timeout at all, so a hung endpoint pinned a
monitor check until the OS gave up - `AbortSignal.timeout` at 8s. And `install.sh` deleted the
installed dashboard before downloading its replacement, so a failed or interrupted download left
the machine with no dashboard at all; it unpacks to a temporary directory and swaps in only after
the download succeeds.

One thing left honest rather than fixed. `appendResults` looks like the same race as the five
above - a unique index on `(run_id, idempotency_key)` with a judge call sitting between the check
and the insert - but it would not reproduce, because the code scorers block the event loop and
therefore serialize; showing it needs a genuinely slow async judge, so it is unchanged and
untested rather than quietly declared safe.

The last three came from CI, and only CI could have found the first of them. `.github/workflows/test.yml`
runs both TypeScript workspaces, the Go CLI, and the engine a second time against a Postgres
service container, so the dialect suites execute instead of skipping. It had never once run, which
looked like a permissions or registration problem and was neither: a `pull_request` workflow runs
from the PR's merge ref, GitHub cannot build that ref while the PR conflicts, and #1 had landed on
main about ninety minutes before this branch added the workflow file, so it had never been
schedulable at all. Merging main back down was what started it, and it went straight into six
failing suites, four of them dying before their engine finished booting, all SIGABRT:

    node::RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr
    Statement::~Statement() [better_sqlite3.node]

better-sqlite3 11 finalizes a prepared statement after its Node environment is gone, which Node 24
asserts on where earlier versions no-oped. It is GC-timing dependent, so only some processes died -
which is what made it read as flakiness rather than a version problem. Nothing local could have
caught it, because this box runs Node 22, where all 442 pass. Fixed by moving to better-sqlite3 12,
whose prebuilds cover Node 24.

Worth being precise about the blast radius, having first written it down too broadly: this reaches
anything running the engine *under Node* - `yarn dev` through tsx, `yarn start` against `dist/`,
and CI. It does not reach the released binary. `release.yml` ships `bun build --compile` output
only, and `storage/db.ts` sends Bun down its `bun:sqlite` branch, which never loads better-sqlite3
at all; the Node 24 in that workflow only runs tsup to build judge-core's `dist/`.

That same run caught the registry race fix above being incomplete. Its retry loop recomputed the
next version from `currentVersion` - a column the winner updates *after* its insert - so a loser
re-read the number it had just lost with, collided again, and burned all eight attempts in a few
microseconds; exhausting the loop then threw a bare Error, which the handler turned into the
"Internal server error" the loop existed to prevent. The next version now comes from `MAX(version)`
in the versions table, which the winner's own insert advances, so five racers converge in five
attempts, and a genuinely exhausted budget answers 409 rather than blaming the server.

The test harness had been quietly orphaning every engine it started, too. `startEngine` spawns
`node tsx/cli.mjs src/index.ts`, but tsx runs the engine in a grandchild, so `stop()`'s SIGKILL
removed only the wrapper and left the engine reparented to init, still holding its port and its
SQLite handle. 133 of them had piled up on a four-core box before the load average made it
obvious - and on a four-core CI runner that is not a slow leak, it is the machine: engines from
finished suites competing with the ones still booting, which is the shape of the ECONNRESET and
boot-timeout failures in that same run. The child now gets its own process group and every kill
path signals the group.

CodeQL, running over the merged tree, then caught one more that is easy to read as a lint nit and
is not. `console.error`'s first argument is a format string, so

    console.error(`Unhandled error in ${req.method} ${req.originalUrl}:`, err)

against a request for `/api/%s` prints `Unhandled error in GET /api/real error:` - the URL consumes
the error argument and the failure disappears from the line whose whole job is to report it, at the
choosing of whoever shaped the request path. `runs.ts` had the same shape around a caller-supplied
`idempotencyKey`. Both now pass the user data as `%s` arguments instead of interpolating it in.

The last alert from that batch, `js/regex-injection` on `validateUserRegex`, is fixed properly
rather than dismissed. Operator-supplied patterns are compiled and matched by RE2 (`re2js`, a pure
JS port - a native `re2` addon would have hit the same Bun problem `storage/db.ts` already works
around), which has no backtracking, so match time is linear whatever the pattern's shape. The
numbers on this box: the built-in engine needs 5.5s for `(a+)+$` against 26 characters, doubling
per character, while RE2 answers the same pattern against 46 in 2ms.

Doing only the flagged line would have cleared the alert and fixed nothing, because the flagged
line is the *validation* compile - construction is cheap, and the damage happens at match time in
`conditions.ts`, which CodeQL never flagged because the pattern reaches it through the database and
that breaks its dataflow. The same unflagged shape turned up a third time in
`proposalValidation.ts`, where a tool definition's JSON Schema `pattern` - also operator-supplied,
also arriving via the database - was compiled with the built-in engine and matched against
arguments. All three now go through one `compileUserRegex`.

`hasNestedQuantifier` stays in front of the compile even though RE2 makes nesting harmless: it is
the documented save-time behaviour, and telling an author their `(a+)+` is probably a mistake is
worth more than the blowup it used to prevent. The trade for RE2 is Perl-only syntax - lookaround
and backreferences are refused. Nothing shipped uses either (the one lookahead in the tree is an
Express route, which is a constant and stays on the built-in engine), and a pattern needing them is
now refused at save time with RE2's own message instead of being stored and silently never firing.

With those in, CI is green on Node 24: 442 passed on SQLite, and 442 passed again against the
Postgres service container with nothing skipped.

Two more came out of running the artifact this actually ships - `bun build --compile` - rather than
the source tree, which no test had done. `agentx-engine --dev` on a machine without a web/
directory extracted the prebuilt dashboard into `/web`: 29MB written to the filesystem root, as
root, silently. `web.ts`'s own `findWebIndexHtml` documents precisely why - under a compiled binary
`import.meta.url` resolves inside Bun's virtual `/$bunfs/root/...`, which is why that function uses
`process.execPath` - but `downloadWebBundle` still derived its target from `import.meta.url`, and
`sourceDir/../../web` collapses to `/web` once sourceDir is a virtual path. As any other user it
fails with EACCES and falls back to API-only, so the convenience had never once worked from the
binary. It now resolves a real checkout by its `package.json` and otherwise writes beside the
binary, which is the installed layout `findWebIndexHtml` looks in first - so the bundle now lands
where the next boot finds it, verified end to end (dashboard served, client-routed `/governance`
200). `tar` also gains `--no-same-owner`, having been restoring the archive's own uid/gid when run
as root.

And `matchTrajectory` scored a tool name differently depending on which side carried stray
whitespace: `expected` was trimmed and filtered, `actual` was not, so `[" search"]` vs `["search"]`
matched while `["search"]` vs `[" search"]` did not. `actual` comes from the trace's own
`tool_calls`, so the padding can just as easily sit there, and the outcome is a quietly flipped
eval verdict rather than anything that looks like a failure. Both sides now normalize identically.

The wider point behind both: the shipped binary takes `storage/db.ts`'s `bun:sqlite` branch, while
every suite here runs under tsx and therefore exercises better-sqlite3. The driver the release
actually uses had no coverage at all. `.github/workflows/test.yml` gains a `compiled binary` job
that runs `bun build --compile` and `scripts/smoke-binary.sh` against the result - boot, a write
and a read back over bun:sqlite, a malformed timestamp, a clean SIGTERM, and an assertion that dev
mode does not write to `/`. Checked both ways: it passes on the fixed binary and fails on the
pre-fix one with `dev mode wrote the dashboard bundle to the filesystem root`.

---

Projects could be created and switched between but never removed - the API had `GET` and `POST
/api/v1/projects` and nothing else, so a mistyped project was permanent. `DELETE
/api/v1/projects/:id` closes that gap.

The interesting part is the cascade. A project's rows live across 29 tables and are only ever
reachable by project id, so deleting just the `projects` row leaves storage that nothing can read
and nothing will ever collect. Rather than hand-listing those tables (a list that silently rots the
next time one is added), `deleteProject` derives them from the schema itself - every table with a
`projectId` column - so a new table cascades without anyone remembering this function exists.

Two deletions are refused outright: the default project, whose key is what the startup log prints
and the SDK docs reference, and the last remaining project, which would leave no key that resolves
at all. The second is defensive rather than routine - the default guard normally fires first - but
it is reachable on an instance whose `is_default` flag was never set, which is a state
`getDefaultProject` already contemplates by returning null.

Verified in `projects.integration.test.ts` against the real engine and its real SQLite file, not
just the API surface: a project is created, a trace ingested into it, then deleted, and the test
asserts directly against the database that `traces`, `evaluation_settings`,
`monitor_online_evaluators` and `agents` all dropped to zero rows for that id - plus that the
deleted project's API key stops authenticating, that the default project is refused with a 400,
that an unknown id 404s, and that an unauthenticated delete is rejected without removing anything.
The cascade assertion was checked both ways: with the table loop disabled it fails with `traces
kept rows for a deleted project: expected 1 to be +0`.

---

Topics knew what production was asked about and Evaluate knew what the datasets tested, and the
two had never been introduced. Nobody could answer "does our suite look anything like our
traffic?", so dataset quality was a feeling. **Insights** is the join: `GET
/api/v1/insights/coverage` groups the window's `monitor_classifications` by intent, assigns every
dataset case to the topic it belongs to, and reports traffic-weighted coverage, topic breadth, and
risk-weighted coverage. The gap between the first and third is the finding worth having - it says
you test what is common rather than what is dangerous.

The measurement is the part that needed care. Counting cases per topic would have been the obvious
implementation and it would have been worthless, because the whole point of knowing where the gaps
are is to then generate cases, and any count-based number is inflated by generating near-copies of
one you already have. Coverage is instead a facility-location value: the average, over the topic's
real traces, of the best similarity any assigned case reaches to that trace. A duplicate adds
nothing because the maximum is already satisfied, so the anti-gaming property falls out of the
formula rather than needing a rule. `targetCases` (scaled by traffic and observed risk, `sqrt` on
traffic so a topic carrying 40% of requests does not demand 40% of the test budget) survives as
guidance for what to write next, and becomes the measure only in the degraded path, where there is
no geometry to measure depth with.

That distinction was not theoretical. The first implementation took `min(countRatio, depth)`,
which reads plausibly and quietly reintroduces exactly the flaw the metric exists to prevent: the
duplicate-inflation test - six near-identical cases against a two-case baseline - failed with
`expected 0.857 to be less than or equal to 0.287`. The count term was doing the talking. Removing
it is what makes the anti-gaming claim true rather than merely stated.

The **probe** is the inverse lookup, and the cheap half: `POST /insights/probe` embeds one query
and compares it against the cached case embeddings, with no LLM in the verdict path.
`POST /insights/probe/batch` does the same for a pasted list - a launch spec, a support macro
export - which is the only answer here to the cold-start problem, since the topic map only knows
traffic that has already happened. Its bands are not new constants: `SIMILARITY_BANDS` is exported
from `core/evaluate/curation.ts`, which already carries the measured calibration for
`text-embedding-3-small`, so the probe's "covered" verdict is *defined* as "`addCaseToDataset`
would reject this query as a duplicate" and the two features cannot drift apart.

The probe answers two questions rather than one, deliberately. "Is it tested?" is useless without
"does anyone ask it?", because a query with no coverage AND no traffic is not a hole in the suite,
and reporting it as one would send a team writing tests for traffic that does not exist. That case
gets its own verdict (`untested-and-unasked`) and its own wording. Similarly, the nearest case's
`expectedResults` always comes back beside the score: query-to-query similarity measures topical
resemblance, not that the case asserts the same behaviour, and claiming "covered" on phrasing
alone is the one way this loses a user's trust in a single interaction.

Everything degrades rather than failing. Without an embeddings key, coverage and the probe fall
back to Jaccard over content words - a genuinely weaker signal on a different scale, so it carries
its own thresholds and every response says `degraded: true` with a reason. `insight_case_embeddings`
caches one embedding per distinct case query, keyed by a content hash rather than the case's
position, so editing a case re-embeds it while reordering costs nothing; a cached NULL is a
remembered failure, which is what stops a missing key from re-attempting a doomed call on every
request. The table carries `project_id`, so `deleteProject`'s schema-derived cascade picks it up
without anyone touching that function.

Nothing here writes a dataset. A gap is reported; cases still land through the existing
preview → human review → append path, which is what keeps a coverage number from being inflated by
rows nobody looked at.

Verified in `insights.integration.test.ts` by driving the core directly against a real database
with embeddings *injected* rather than computed - unit vectors at chosen angles, whose cosines are
exactly `cos(Δangle)`, so every band-boundary assertion is arithmetic instead of a guess about
what an embedding model will return today. It covers a covered topic and a missing one, unique
sessions counted through the join to `traces` rather than raw request volume, risk weighted toward
observed issues over sentiment, the risk-weighted number falling below the traffic-weighted one
when a failing topic is untested, duplicate cases not moving coverage, the honesty delta between
case presence and real depth, off-map cases, and all four probe verdicts including the lexical
fallback (exercised, not mocked away - the mocked embedder returns null for unregistered text,
exactly as a missing key does). `contract.integration.test.ts` drives the three new endpoints live
against the real engine, including the empty state, which is the common first view of this screen
since Topics is opt-in and sampled.
