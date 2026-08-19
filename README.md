# AgentX Trace & Eval

[![Release](https://img.shields.io/github/v/release/AgentX-ai/AgentX-trace-eval)](https://github.com/AgentX-ai/AgentX-trace-eval/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A portable, self-hostable build of AgentX's Governance layer - **Trace**, **Evaluate**, and
**Monitor** for AI agents - as a single local install. No account, no multi-tenant billing, bring
your own LLM API keys.

```bash
curl -sSL https://raw.githubusercontent.com/AgentX-ai/AgentX-trace-eval/main/install.sh | bash
agentx-server --dev
```

`--dev` starts the engine (API server) on a local SQLite database, opens the dashboard in your
browser, and prints a local API key for the SDK. Prefer a container? See [Docker](#docker).

## Contents

- [Features](#features)
- [Docker](#docker)
- [Configuration](#configuration)
- [SDK & OpenTelemetry](#sdk--opentelemetry)
- [What's in this repo](#whats-in-this-repo)
- [Building from source](#building-from-source)
- [Dashboard release process](#dashboard-release-process)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Trace** - ingest agent runs from the [AgentX Python SDK](https://github.com/AgentX-ai/AgentX-Python)
  or any OpenTelemetry-compatible exporter (see [SDK & OpenTelemetry](#sdk--opentelemetry)).
  Traces sharing a `session_id` are also browsable as **Sessions**: one row per conversation, with
  turn counts and a conversation-level coherence score.
- **Evaluate** - datasets and eval runs with judge scoring, 4 built-in similarity metrics
  (vector/Jaccard/BLEU/ROUGE), and sandboxed custom code scorers; version-scoped **Prompt** and
  **Tool Schema** registries for propose → human-approve → publish iteration, both fed by real
  evidence (worst-rated eval results and production failures); **Model Portability** to replay a
  captured trace's input against alternative models for a quick cost/latency/quality comparison;
  and a **Playground** grid for testing a prompt/model against dataset cases without a full run -
  tools included (from the Tool Schema registry or ad hoc; with no endpoint configured, calls are
  simulated so tool choice and argument formation are still testable). Tools failing in traffic
  that nobody registered yet are surfaced for one-click registration, drafted from the trace's
  own metadata or the observed calls.
- **Monitor** - pattern-based detection (phrase/regex/semantic) with per-agent scope and sampling,
  continuous **Online Evaluators** scoring live traffic against judge criteria (per trace, or per
  **session**: whole conversations judged automatically once they go idle), **Custom Evaluators**
  that delegate the verdict to a webhook you control, and **Topics** clustering of what your
  agents are actually being asked. Signals triage, KPI/trend dashboards, and outbound webhook
  notifications on failures.
- **Close the loop** - turn production into tests and fixes into proofs. Any trace or session
  becomes a golden dataset case in two clicks (multi-turn conversations included, with
  deduplication and provenance); prompt/tool-schema proposals are **validated** against those
  cases before a human publishes (candidate vs current, measured); real-world **outcomes**
  (`client.outcomes.report(...)`) and **end-user feedback** (`client.feedback.report(...)`, a
  downvote raises a signal directly) feed Overview's **Judge Calibration** card, which measures
  how often the automated verdicts agreed with reality; and a **Model Comparison** card
  aggregates quality/cost/latency per model from real traffic.
- **Judge tuning** - the judges get judged: each online evaluator's verdicts are measured
  against recorded reality (human re-scores, outcomes, user votes), and its own grading criteria
  can be rewritten from the disagreements - validated by exact re-judging (fixes the cases it got
  wrong, preserves a control set it got right) before a human publishes.
- **Improvement Inbox** - the loop runs itself: a background sweep notices when a prompt or
  tool schema accumulates fresh failure evidence, generates the improvement proposal AND runs its
  baseline-vs-candidate validation automatically, then queues it under Improve -> Suggestions
  with the measured verdict attached. Humans keep the only pen: review, then publish or dismiss.
- **CI gate** - fail a build on eval regression: `report.gate(fail_under=7, no_regression=True)`
  after any SDK eval run returns an exit code, and every recorded gate lands in the dashboard's
  **CI Gates** tab (history plus a "would the latest run pass?" preview). See the docs for the
  copy-paste GitHub Actions workflow.
- **Bring your own keys** - OpenAI, Anthropic, and Gemini are all supported for judge scoring and
  model calls; nothing works without your own key, and nothing is billed through AgentX.
- **Single binary** - the engine compiles to a native executable (via Bun) and the CLI to a native
  Go binary; end users never need Node, Bun, or Go installed.

## Docker

```bash
docker build -t agentx-selfhost .
docker run -d -p 4700:4700 -v agentx-data:/data agentx-selfhost
```

`/data` is where the default SQLite database and config live (`AGENTX_HOME`, see
[Configuration](#configuration)) - mount a named volume so state survives a container recreate, or
point `AGENTX_DB_URL` at your own Postgres instead and skip the volume entirely. Pass provider
keys with `-e OPENAI_API_KEY=... -e ANTHROPIC_API_KEY=... -e GEMINI_API_KEY=...`, or set them
later from the dashboard's Platform Settings. The image includes a `/health` `HEALTHCHECK`.

The build downloads the latest dashboard release (see
[Dashboard release process](#dashboard-release-process)) and re-checks it on every rebuild - the
download layer is an `ADD` from the release URL, which the builder revalidates against the remote
file, so a newly published dashboard bundle is picked up automatically with no `--no-cache`
needed. Pin a specific dashboard build instead with
`--build-arg AGENTX_WEB_URL=https://github.com/AgentX-ai/AgentX-trace-eval/releases/download/v0.2.0/agentx-web.tar.gz`.

## Configuration

Set these in the environment before starting `agentx-server`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | - | Powers judge scoring / model calls for OpenAI models. Can also be set live from the dashboard's Platform Settings (takes precedence over the env var). |
| `ANTHROPIC_API_KEY` | - | Same, for Anthropic models. |
| `GEMINI_API_KEY` | - | Same, for Gemini models. |
| `AGENTX_DB_URL` | (local SQLite) | Set to a `postgres://...` URL to use Postgres instead of the default SQLite file. |
| `AGENTX_HOME` | `~/.agentx` | Where the local SQLite database and config live. |
| `PORT` | `4700` | Port the engine listens on. |
| `AGENTX_OTEL_MONITOR` | `true` | Set to `false` to stop running Monitor against OTel-ingested spans. |
| `AGENTX_MONITOR_CHILD_SPANS` | `false` | Set to `true` to also run Monitor against child spans of a traced call, not just top-level ones. |
| `AGENTX_IMPROVEMENT_SWEEP` | `true` | Set to `false` to disable the background sweep that auto-generates and validates improvement proposals when failure evidence crosses a threshold (the Improvement Inbox). `POST /evaluate/improve/inbox/sweep/run` still triggers one manually. |
| `AGENTX_SESSION_SWEEP` | `true` | Set to `false` to disable the background sweep that judges idle multi-turn sessions (session-scoped Online Evaluators). `POST /agent-monitoring/session-sweep/run` still triggers one manually. |
| `AGENTX_AUTH` | `disabled` | Set to `enabled` to require dashboard sign-in (see "Dashboard authentication" below). The default keeps the zero-setup local posture. |
| `AGENTX_AUTH_SECRET` | (auto-generated) | Session-signing secret for `AGENTX_AUTH=enabled`. Generated and persisted on first enabled boot if unset; set explicitly when running multiple replicas. |
| `AGENTX_PUBLIC_URL` | - | The externally reachable base URL when running behind a proxy/domain with auth enabled (used for auth callbacks/cookies). |
| `AGENTX_TRUSTED_ORIGINS` | - | Comma-separated extra origins allowed to make authenticated browser requests (e.g. a dev dashboard on another port). |

Trace ingest and pattern matching on phrase/regex both work with no keys configured at all - only
judge scoring and semantic pattern detection need a provider key.

### Dashboard authentication

By default there is no login: the engine trusts anything that can reach its port (one machine,
one operator), and the dashboard bootstraps its API key automatically. That stays the default.

`AGENTX_AUTH=enabled` turns on dashboard sign-in for shared deployments (a team server, or
hosting the dashboard on the internet):

- The first visit shows an owner-setup screen. The first account created becomes the owner of a
  default organization and takes over every existing project on the instance. Later signups join
  that organization as members.
- Signing in is what grants the dashboard its project list (and each project's API key); the
  unauthenticated bootstrap endpoint is disabled in this mode.
- SDK ingest is unchanged in both modes: it authenticates with project API keys, never sessions.
  Enabling or disabling auth never breaks a deployed integration.
- Identity is standard [better-auth](https://better-auth.com) (email/password out of the box),
  stored in the same database as everything else - works on both SQLite and Postgres.

## SDK & OpenTelemetry

**AgentX Python SDK** - already supports pointing at any base URL, so it works unmodified against
a self-host instance:

```bash
export AGENTX_API_BASE_URL=http://localhost:4700/api/v1
export AGENTX_API_KEY=<printed by agentx-server on first run>
```

**OpenTelemetry** - Trace also accepts real OTLP/HTTP traces directly, no AgentX SDK required:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4700/api/v1/otel
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<printed by agentx-server on first run>"
```

Both OTLP/HTTP wire formats are supported (protobuf and `application/json`, via
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`). One incoming span becomes one AgentX trace row.
Attributes are mapped using the GenAI semantic conventions (`gen_ai.*`, both the older and newer
field names), OpenLLMetry's legacy indexed attributes, and OpenInference's `input.value`/
`output.value`/`llm.model_name` - see `engine/src/otel/mapping.ts` for the exact priority order.
Monitor and Online Evaluators run against every OTel-ingested span by default; set
`AGENTX_OTEL_MONITOR=false` to disable that.

OTel traffic is a first-class citizen of the full loop, via three attribute conventions:

| Span attribute | Effect |
| --- | --- |
| `session.id`, `gen_ai.conversation.id`, or `agentx.session_id` | Groups traces into a conversation on the Sessions surface - session coherence scoring and session-scoped Online Evaluators apply, exactly like SDK traffic. Without one, spans still group by OTel trace id. |
| `agentx.prompt_name` (+ optional `agentx.version`) | Tags the trace for the Improve loop - prompt-registry evidence gathering and version comparison work as if the SDK's `metadata={"promptName": ...}` had been passed. |
| `gen_ai.tool.name` on a child span | The tool call is folded up into its root interaction's `tool_calls` (with `success`/`error` from the span's status), lighting up the Tool quality column, the built-in Tool failure check, and Tool Schema evidence. In-batch only: a parent exported in an earlier OTLP batch isn't updated retroactively. |

Known gap: gRPC transport isn't supported (HTTP only).

## What's in this repo

| Path | What it is |
| --- | --- |
| `cli/` | Go CLI (`agentx`/`agentx-server`) - installer glue and process supervisor. Launches the bundled engine binary, opens the browser, handles shutdown. |
| `engine/` | TypeScript governance engine + HTTP API (Trace, Evaluate, Monitor). Compiles to a single native executable via Bun (`bun build --compile`) so end users never need Node/Bun installed. |
| `packages/judge-core/` | The LLM-as-judge prompt/scoring logic, published as `@agentx/judge-core` so `engine/` and AgentX's hosted SaaS backend share one implementation. |
| `web/` | The dashboard - **not tracked in this repo**. Populated by building [AgentX-eval-front](https://github.com/AgentX-ai/AgentX-eval-front) in self-host mode, or by downloading its prebuilt release asset (see [Dashboard release process](#dashboard-release-process)). |
| `skills/` | Claude Code skills for self-host users to copy into their own `.claude/skills/` - e.g. `improve-prompt/`, which drives the Prompt Registry's propose loop using Claude's own reasoning instead of a server-side judge call. |
| `install.sh` | The `curl \| bash` installer - downloads the platform binary from GitHub Releases. |
| `build.sh` | Builds a local `dist/` laid out the same way a real install would, for testing the full distribution without cutting a release. |
| `Dockerfile` | Multi-stage build producing a container image - see [Docker](#docker). |
| `scripts/` | `smoke-test.sh` / `smoke_test.py` - end-to-end verification against a real running engine and the real Python SDK. |

## Building from source

Prerequisites: [Go](https://go.dev/), Node.js + [Yarn](https://yarnpkg.com/), and
[Bun](https://bun.sh/) (only needed for the compiled single-binary path, not day-to-day dev).

```bash
git clone git@github.com:AgentX-ai/AgentX-trace-eval.git && cd AgentX-trace-eval
yarn install   # workspace install: engine/ + packages/judge-core together
```

### Fastest dev loop

Runs the engine directly via `tsx`, no compile step, restarts on file changes:

```bash
cd engine && yarn dev --dev
```

That's the whole loop on a fresh clone: `yarn dev` first builds the `@agentx/judge-core`
workspace package automatically (a ~1s `tsup` step - the engine imports its `dist/`, which a
fresh clone doesn't have yet), `.env` is optional (judge features need provider keys,
tracing/ingest work without any), and if `web/` is missing (it isn't committed, see
[What's in this repo](#whats-in-this-repo)) dev mode downloads the prebuilt dashboard bundle
from this repo's releases on first boot. Offline, or to refresh it manually:

```bash
mkdir -p web && curl -fsSL https://github.com/AgentX-ai/AgentX-Trace-Eval/releases/latest/download/agentx-web.tar.gz | tar -xz -C web
```

The dashboard's source (`AgentX-eval-front`) is a private repo; if you're on the AgentX team and
have it checked out as a sibling directory, build it from source instead:

```bash
(cd ../AgentX-eval-front && yarn install && yarn build:selfhost) && rm -rf web && cp -r ../AgentX-eval-front/dist web
```

Iterating on the engine's API doesn't need a `web/` rebuild; iterating on the dashboard itself
means re-running whichever step above got you `web/` in the first place - there's no hot-reload
loop wired up between the two repos yet.

### Tests

Unit and integration tests (vitest for the engine and judge-core, `go test` for the CLI). They run
against a temporary SQLite database - no API keys or network needed:

```bash
yarn test        # judge-core + engine + the Go CLI
yarn typecheck   # both TypeScript packages, tests included
```

Or one workspace at a time:

```bash
yarn workspace @agentx/engine test
yarn workspace @agentx/judge-core test
```

The engine's integration suites boot the real engine as a subprocess. The ones that exercise
Postgres skip unless you point them at a server:

```bash
docker run -d --name agentx-pg-test -e POSTGRES_PASSWORD=agentx -e POSTGRES_DB=agentx -p 55432:5432 postgres:16-alpine
AGENTX_TEST_DB_URL=postgres://postgres:agentx@localhost:55432/agentx yarn workspace @agentx/engine test
```

That is worth running before anything touching `storage/db.ts` or an ingest path: Postgres is
where concurrent writes actually interleave, so a race that SQLite hides shows up there.

Both suites run under `tsx`, which `storage/db.ts` serves with `better-sqlite3`. The released
binary takes its `bun:sqlite` branch instead, so nothing above says anything about it - smoke-test
that separately before touching either branch, `web.ts`, or the shutdown path:

```bash
bun build engine/src/index.ts --compile --outfile /tmp/agentx-engine
./scripts/smoke-binary.sh /tmp/agentx-engine
```

### Full distribution build

Compiles the engine to a Bun-compiled binary and builds the Go CLI, laid out exactly the way the
`curl | bash` install would:

```bash
./build.sh
./dist/agentx-server --dev
```

Once it's up:

```
AgentX self-host engine listening on http://localhost:4700
Local API key: agtx_local_...
```

`--dev` opens the dashboard in your browser automatically.

### End-to-end smoke test

Confirms everything actually works, including a real Python SDK round-trip:

```bash
OPENAI_API_KEY=sk-... ./scripts/smoke-test.sh
```

Runs against SQLite by default; pass `AGENTX_DB_URL=postgres://...` (e.g. a throwaway Dockerized
Postgres) to verify against Postgres instead - see the script's own header for the exact command.

## Dashboard release process

`AgentX-eval-front` (the app that builds into `web/`) is AgentX's private frontend dedicated to
this Governance dashboard. Rather than open-sourcing it, only its **build output** is public: a
workflow in that repo builds it in self-host mode and uploads the result as `agentx-web.tar.gz`
onto this repo's own GitHub releases. `install.sh`, `build.sh`, and the `Dockerfile` all fetch it
from there - nobody installing or building this repo, including outside contributors, ever needs
access to that private repo.

Maintainers cutting a new dashboard build: in `AgentX-eval-front`'s Actions tab, run "Publish
self-host web bundle" (optionally targeting a specific release tag here; defaults to whatever's
currently latest). One-time setup: a fine-grained PAT scoped to this repo with release/contents
write access, saved as `AgentX-eval-front`'s `SELFHOST_RELEASE_TOKEN` secret.

## Project status

Trace, Evaluate, and Monitor are wired end-to-end and verified against the real Python SDK, both
SQLite and Postgres, and the compiled single-binary distribution - including a real OTLP/HTTP
receiver verified against both protobuf and JSON payloads. The dashboard covers Governance's full
self-host surface: Trace ingest (traces and sessions, with end-user feedback chips), Monitor
(patterns, trace- and session-scoped online evaluators, custom evaluators, topics, signals
triage, KPIs), Evaluate (runs, datasets curated straight from production traffic, standalone
evaluator configs, version history, per-case run comparison, Model Portability, and Playground),
Improve (the Prompt and Tool Schema registries with validated proposals and unregistered-tool
surfacing), CI Gates (recorded gate history plus a latest-run preview), and Overview (KPIs,
trends, topic map, Model Comparison, and Judge Calibration against reported outcomes and
end-user feedback).

**Known gaps:**

- The self-host build ships the full frontend bundle rather than one trimmed to just Governance  - 
  tracked as a follow-up in `AgentX-eval-front`.
- No hot-reload loop between an `AgentX-eval-front` dev server and this engine yet.
- Autotune's candidate-branch creation/evaluation/merging is out of scope, not deferred: it's
  fundamentally tied to AgentX's native agent config-branching system, which self-host doesn't
  have. The version-comparison and Prompt Registry features are the self-host analogs.
- Guardrail hasn't been started.
- Evaluate's async whole-run analysis (`analyze_run`/`get_report`) is out of scope for now.

See [CHANGELOG.md](CHANGELOG.md) for the detailed, narrative build/verification history behind
every feature above.

## Contributing

Issues and PRs are welcome. There's no separate `CONTRIBUTING.md` yet - for anything beyond a
small fix, please open an issue first to discuss the approach. Run `yarn install` at the repo root
(a workspace install covering `engine/` and `packages/judge-core/` together), and see
[Building from source](#building-from-source) for the dev loop and smoke test.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
