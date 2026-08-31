# AgentX — full feature summary

A single source of truth for what the AgentX governance framework does today, across the two
public repos:

- **AgentX-Trace-Eval** — the self-hostable engine: Trace, Evaluate, Monitor, Improve, Insights.
  One binary, your own database, your own LLM keys.
- **AgentX-Eval-Skill** — the coding-agent plugin (`/instrument`, `/run-eval`, `/eval-fix`) that
  wires an agent up to the engine and turns what it measures into a code fix.

The through-line: **production traffic becomes tests, tests become measured proposals, and a human
publishes.** Nothing else in this space closes that whole loop in something you can run locally.

---

## 1. Install & posture

- `curl … | bash && agentx-server --dev` — engine + dashboard + SQLite + a printed API key. No
  account, no signup, no billing.
- Docker image with a `/health` HEALTHCHECK; `docker run -p 4700:4700 -v agentx-data:/data`.
- Kubernetes manifests included (`k8s/`).
- **Single binary**: engine compiles native via Bun, CLI is native Go. End users never install
  Node, Bun, or Go.
- SQLite by default; point `AGENTX_DB_URL` at Postgres for a team deployment. Both are tested in
  CI, including a compiled-binary smoke job that exercises the `bun:sqlite` driver the release
  actually ships.
- **Bring your own keys** — OpenAI, Anthropic, Gemini. Nothing is billed through AgentX, and
  trace ingest + phrase/regex detection work with *no* provider key at all.
- Auth is off by default (one machine, one operator). `AGENTX_AUTH=enabled` turns on
  better-auth sign-in, an owner org, and multi-user projects — and never breaks a deployed SDK
  integration, because ingest always authenticates with project API keys, not sessions.
- Apache-2.0.

## 2. Trace

- Ingest from the **AgentX Python SDK** or **any OpenTelemetry exporter** — real OTLP/HTTP,
  protobuf *and* JSON wire formats.
- Attribute mapping covers GenAI semantic conventions (old and new names), OpenLLMetry's legacy
  indexed attributes, and OpenInference — so existing instrumentation just works.
- **Sessions**: traces sharing a `session_id` become one conversation row, with turn counts and a
  conversation-level coherence score. OTel users get this too via `session.id` /
  `gen_ai.conversation.id`.
- Tool calls on child spans (`gen_ai.tool.name`) fold up into the root interaction, lighting up
  tool-quality columns and tool-failure detection.
- OTel traffic is first-class in the *whole* loop, not just the trace list: `agentx.prompt_name`
  tags a span for the Improve loop exactly as the SDK's metadata would.
- Trajectory matching (expected vs actual tool sequence), span-kind classification, and
  production-vs-eval traffic separation.

## 3. Evaluate

- Datasets + eval runs with **LLM-as-judge** scoring (shared `@agentx/judge-core` package, the
  same implementation the hosted product uses).
- **4 built-in similarity metrics** — vector, Jaccard, BLEU, ROUGE.
- **Code scorers**: user-authored JavaScript *or* Python run sandboxed per trace, with access to
  the trace's spans. Braintrust-style handler contract.
- **External scorers**: delegate the verdict to a webhook you own.
- **Built-in metric pack**: ready-made RAG + safety evaluators seeded per project, expressed as
  native evaluator configs (criteria + judge prompt) rather than a closed metric API — so you can
  edit, tune, and calibrate them.
- **Pairwise / head-to-head judging** — "which of these two answers is better", next to absolute
  scoring, because absolute scores bunch in the 7–8 band and drift between judge versions.
- **Playground**: a prompt × model × dataset-case grid, with tools — real MCP servers, your own
  HTTP endpoints, or simulated calls when no endpoint is configured, so tool choice and argument
  formation stay testable.
- **Conversation simulation**: a simulated user (persona + goal + its own model) talks to the
  prompt/model/tools under test for N turns, so multi-turn behaviour is testable without humans.
- **Model Portability**: replay a captured trace's input against alternative models for a
  cost/latency/quality comparison.
- **Agent connectors**: point the engine at your deployed agent's endpoint and let it drive a
  full dataset run end to end from the dashboard — no manual run-and-push.
- **Synthetic golden cases**: paste a policy doc, API docs, FAQ or spec and get dataset cases
  whose expected results are grounded in it. The cold-start answer for teams with no traffic yet.
  Generated cases are handed back for human review; nothing lands unreviewed.
- **MCP client** built in (Streamable HTTP + SSE, OAuth) for tools under test.
- Version history, per-case run comparison, standalone evaluator configs.

## 4. Monitor

- **Pattern detection** — phrase, regex, semantic (LLM), and `external` (POST the trace to your
  own endpoint, its `{matches, reason}` answer *is* the verdict). Per-agent scope and sampling.
- **Regex safety**: user-supplied patterns compile through RE2, so a catastrophic-backtracking
  pattern cannot stall the engine (the built-in engine needs 5.5s for `(a+)+$` on 26 chars,
  doubling per char; RE2 answers 46 chars in 2ms).
- **Online Evaluators** — continuous judge scoring of live traffic against your criteria, per
  trace *or* per session (whole conversations judged automatically once they go idle).
- **Custom Evaluators** — same, but the verdict comes from a webhook you control.
- **Automation rules** — filter + sample + action, evaluated once per ingested trace: route into
  the human review queue, into a dataset, or out to a webhook. Rules route; scorers score; the
  boundary is deliberate.
- **Human review queue** for traffic that raised *no* signal — because the failure a signal-only
  queue can never see is the judge quietly scoring bad answers as good.
- **Topics**: clustering of what your agents are actually being asked, with synonym merging so
  "Refund request" and "Request a refund" don't show up as two half-covered topics.
- **Signals triage** — status, human feedback, LLM-drafted suggestions.
- **Overview**: KPIs, trends, "Needs attention" digest (per-signal 14-day sparkline,
  week-over-week delta, an LLM line naming what the top signals have in common), total LLM cost
  stacked by model, Model Comparison (quality/cost/latency per model from real traffic), and
  Judge Calibration.
- Outbound webhook notifications (Slack-compatible) on failure signals.

## 5. Close the loop

This is the part that is hard to copy.

- **Production → tests**: any trace or session becomes a golden dataset case in two clicks,
  multi-turn conversations included, with deduplication and provenance.
- **Prompt Registry** and **Tool Schema Registry**, version-scoped: propose → human-approve →
  publish, with proposals fed by *real evidence* (worst-rated eval results + production failures).
- **Proposals are validated before a human sees them** — candidate vs current, measured against
  the golden cases.
- Tools failing in traffic that nobody registered yet are surfaced for one-click registration,
  drafted from the trace's own metadata.
- **Outcomes** (`client.outcomes.report(...)`) and **end-user feedback**
  (`client.feedback.report(...)`; a downvote raises a signal directly) feed **Judge Calibration**:
  how often did the automated verdicts agree with reality?
- **Judge tuning** — the judges get judged. Each online evaluator's verdicts are measured against
  recorded reality (human re-scores, outcomes, user votes), and its grading criteria can be
  rewritten from the disagreements — then validated by exact re-judging (fixes what it got wrong,
  preserves a control set it got right) before a human publishes.
- **Improvement Inbox** — the loop runs itself. A background sweep notices when a prompt or tool
  schema has accumulated fresh failure evidence, generates the proposal, runs its
  baseline-vs-candidate validation, and queues it with the measured verdict attached. Humans keep
  the only pen: review, publish, or dismiss.

## 6. Insights — "does your dataset look anything like your traffic?"

- Joins what production is actually asked (Monitor's classified topics) against the cases in your
  datasets, and reports three numbers: **traffic-weighted coverage**, **topic breadth**, and
  **risk-weighted coverage**. The gap between the first and third is the finding worth having:
  *you test what is common, not what is dangerous.*
- Coverage is a **facility-location value** over the topic's real traces, not a case count — so
  near-duplicate cases add nothing and the number cannot be gamed by generating copies. (The
  first implementation used a count term and failed its own anti-gaming test; removing it is what
  makes the claim true rather than merely stated.)
- **Probe**: ask whether the datasets cover one specific query — or paste a whole list (a launch
  spec, a support-macro export) as a pre-launch gate. "Covered" is *defined* as "the dataset would
  reject this query as a duplicate", reusing the exact threshold curation dedupes on, so the two
  can never drift apart.
- Distinguishes a real gap from **a question nobody asks**, rather than inventing work.
- Degrades to labelled lexical matching with no embeddings key. Never writes a dataset.

## 7. CI & enterprise

- **CI gate**: `report.gate(fail_under=7, no_regression=True)` returns an exit code; every gate
  lands in the dashboard's **CI Gates** tab with history and a "would the latest run pass?"
  preview. Copy-paste GitHub Actions workflow in the docs.
- **Bulk export**: every project-scoped table streamed as NDJSON, keyset-paginated, incremental
  with `?since=` — data *plus* the scorer/judge config that produced it, because that's what makes
  a backup usable.
- **Append-only audit log**: record and list, no update, no delete, no route that reaches either.
  Immutability enforced by the absence of code.
- **Project lifecycle**: create, switch, delete — with a cascade derived from the schema itself
  (every table carrying `projectId`), so a new table cascades without anyone remembering the
  delete function exists. The default project and the last project are refused.

## 8. AgentX for coding agents (the plugin)

One plugin, three slash commands, one loop — installable into Claude Code, Cursor, Codex, or any
agent that reads the Agent Skills standard (`npx skills add`).

```
/instrument ──► traced runs ──► /run-eval ──► score + analysis ──► /eval-fix ──► v1 vs v2
```

- **`/instrument`** — asks at most three questions, then surveys the repo with `ast` (never
  importing your code), writes a gitignored `.env.agentx` at 0600, puts **one** span where the run
  begins plus one line of framework auto-instrumentation, and proves it by sending a trace and
  fetching it back by id. Covers LangChain/LangGraph, CrewAI, OpenAI Agents SDK, raw OpenAI and
  Anthropic, Google ADK, Google GenAI, LiteLLM, LlamaIndex, AutoGen.
  It exists because tracing fails in three specific silent ways: wrong places (decorating every
  function flattens a trajectory into Python frames), silent non-delivery (fire-and-forget by
  design, so an unset base URL sends a self-hoster's traces to the wrong place forever), and
  taking the app down (`from_env()` raises at import time on a missing key).
- **`/run-eval`** — picks or creates the dataset and grading config (templates, JSON, CSV, a
  document, or cases curated from live traces), writes a *committed* harness, runs it, links every
  result to its trace, and hands back the score and the `/eval-fix` command.
- **`/eval-fix <id>`** — treats an eval report's **evidence as reliable and its recommendations as
  hypotheses**, checks each against the real source, applies what survives on a branch in a
  worktree, and re-runs on the same dataset. Every rejection cites a `file:line`.
  Why: an agent scored 1.86/10 with every answer cut off mid-word, and the top recommendation was
  "enforce a completion check". The real cause was `out["text"][:400]` in the harness — one line,
  in a file the report never mentions. Deleting the slice took it to 10.00.
- Also ships `improve-prompt` for driving the Prompt Registry's propose loop with the coding
  agent's own reasoning instead of a server-side judge call.

**Measured results**: validated on nine agents with deliberately planted defects (in code, YAML,
data files, and the harness itself), then on three LangChain agents at 3.60 / 5.50 / 4.80 →
10.00 / 9.60 / 9.80 on the same datasets. Most recently a LangChain/LangGraph support agent on a
self-host engine: **6.25 → 9.53** average, minimum **1 → 7**, rating variance **5.78 → 0.98**,
with criteria, judge and model frozen. Of seven recommendations: three applied, two applied with
changed scope, one rejected as already implemented, one rejected as harmful. The single change
that moved the score most — retrieval width — came from reading the code and appeared in no
recommendation at all.

---

## Angles worth a tweet

1. **The whole loop, self-hosted.** Trace → evaluate → monitor → propose → validate → publish, in
   one binary on your laptop. No account, no vendor holding your traces.
2. **Insights.** "Does your test suite look anything like your traffic?" Three numbers, and the
   gap between two of them tells you that you test what is common, not what is dangerous.
3. **Anti-gaming by construction.** Coverage is a facility-location value, not a case count — you
   cannot inflate it by generating near-duplicates. The formula does the work, not a policy.
4. **The judges get judged.** Online evaluators are scored against recorded reality, and their own
   criteria get rewritten from the disagreements — then re-validated before a human publishes.
5. **The Improvement Inbox runs itself.** A sweep finds the failure evidence, writes the proposal,
   runs baseline-vs-candidate, and queues it with the verdict attached. Humans keep the only pen.
6. **OTel-native.** Any OpenTelemetry exporter, protobuf or JSON, and it's first-class in the
   whole loop — sessions, prompt registry, tool schemas — not just a trace list.
7. **`/eval-fix`.** An eval report is written by a judge that never saw your code. 1.86 → 10.00,
   and the fix was one `[:400]` slice the report never mentioned.
8. **Real numbers.** 6.25 → 9.53, variance 5.78 → 0.98, judge and model frozen.
