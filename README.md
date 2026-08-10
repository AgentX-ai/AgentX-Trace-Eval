# AgentX Trace & Eval

[![Release](https://img.shields.io/github/v/release/AgentX-ai/AgentX-trace-eval)](https://github.com/AgentX-ai/AgentX-trace-eval/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A portable, self-hostable build of AgentX's Governance layer — **Trace**, **Evaluate**, and
**Monitor** for AI agents — as a single local install. No account, no multi-tenant billing, bring
your own LLM API keys.

```bash
brew install AgentX-ai/tap/agentx   # or: curl -sSL https://get.agentx.so | bash
agentx-server --dev
```

`--dev` starts the engine (API server) on a local SQLite database, opens the dashboard in your
browser, and prints a local API key for the SDK.

## Contents

- [Features](#features)
- [Configuration](#configuration)
- [SDK & OpenTelemetry](#sdk--opentelemetry)
- [What's in this repo](#whats-in-this-repo)
- [Building from source](#building-from-source)
- [Dashboard release process](#dashboard-release-process)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Trace** — ingest agent runs from the [AgentX Python SDK](https://github.com/AgentX-ai/AgentX-Python)
  or any OpenTelemetry-compatible exporter (see [SDK & OpenTelemetry](#sdk--opentelemetry)).
- **Evaluate** — datasets and eval runs with judge scoring, 4 built-in similarity metrics
  (vector/Jaccard/BLEU/ROUGE), and sandboxed custom code scorers; a version-scoped **Prompt
  Registry** for propose → human-approve → publish prompt iteration; **Model Portability** to
  replay a captured trace's input against alternative models for a quick cost/latency/quality
  comparison; and a **Playground** grid for testing a prompt/model against dataset cases without a
  full run.
- **Monitor** — pattern-based detection (phrase/regex/semantic) with per-agent scope and sampling,
  continuous **Online Evaluators** scoring live traffic against inline judge criteria, and
  **Custom Evaluators** that delegate the verdict to a webhook you control. Signals triage,
  KPI/trend dashboards, and outbound webhook notifications on failures.
- **Bring your own keys** — OpenAI, Anthropic, and Gemini are all supported for judge scoring and
  model calls; nothing works without your own key, and nothing is billed through AgentX.
- **Single binary** — the engine compiles to a native executable (via Bun) and the CLI to a native
  Go binary; end users never need Node, Bun, or Go installed.

## Configuration

Set these in the environment before starting `agentx-server`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Powers judge scoring / model calls for OpenAI models. Can also be set live from the dashboard's Platform Settings (takes precedence over the env var). |
| `ANTHROPIC_API_KEY` | — | Same, for Anthropic models. |
| `GEMINI_API_KEY` | — | Same, for Gemini models. |
| `AGENTX_DB_URL` | (local SQLite) | Set to a `postgres://...` URL to use Postgres instead of the default SQLite file. |
| `AGENTX_HOME` | `~/.agentx` | Where the local SQLite database and config live. |
| `PORT` | `4700` | Port the engine listens on. |
| `AGENTX_OTEL_MONITOR` | `true` | Set to `false` to stop running Monitor against OTel-ingested spans. |
| `AGENTX_MONITOR_CHILD_SPANS` | `false` | Set to `true` to also run Monitor against child spans of a traced call, not just top-level ones. |

Trace ingest and pattern matching on phrase/regex both work with no keys configured at all — only
judge scoring and semantic pattern detection need a provider key.

## SDK & OpenTelemetry

**AgentX Python SDK** — already supports pointing at any base URL, so it works unmodified against
a self-host instance:

```bash
export AGENTX_API_BASE_URL=http://localhost:4700/api/v1
export AGENTX_API_KEY=<printed by agentx-server on first run>
```

**OpenTelemetry** — Trace also accepts real OTLP/HTTP traces directly, no AgentX SDK required:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4700/api/v1/otel
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<printed by agentx-server on first run>"
```

Both OTLP/HTTP wire formats are supported (protobuf and `application/json`, via
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`). One incoming span becomes one AgentX trace row.
Attributes are mapped using the GenAI semantic conventions (`gen_ai.*`, both the older and newer
field names), OpenLLMetry's legacy indexed attributes, and OpenInference's `input.value`/
`output.value`/`llm.model_name` — see `engine/src/otel/mapping.ts` for the exact priority order.
Monitor and Online Evaluators run against every OTel-ingested span by default; set
`AGENTX_OTEL_MONITOR=false` to disable that. Known gaps: gRPC transport isn't supported (HTTP
only), and reconstructing a parent LLM span's `tool_calls` from separate child tool-call spans
isn't attempted (no stable convention for that yet upstream).

## What's in this repo

| Path | What it is |
| --- | --- |
| `cli/` | Go CLI (`agentx`/`agentx-server`) — installer glue and process supervisor. Launches the bundled engine binary, opens the browser, handles shutdown. |
| `engine/` | TypeScript governance engine + HTTP API (Trace, Evaluate, Monitor). Compiles to a single native executable via Bun (`bun build --compile`) so end users never need Node/Bun installed. |
| `packages/judge-core/` | The LLM-as-judge prompt/scoring logic, published as `@agentx/judge-core` so `engine/` and AgentX's hosted SaaS backend share one implementation. |
| `web/` | The dashboard — **not tracked in this repo**. Populated by building [AgentX-eval-front](https://github.com/AgentX-ai/AgentX-eval-front) in self-host mode, or by downloading its prebuilt release asset (see [Dashboard release process](#dashboard-release-process)). |
| `skills/` | Claude Code skills for self-host users to copy into their own `.claude/skills/` — e.g. `improve-prompt/`, which drives the Prompt Registry's propose loop using Claude's own reasoning instead of a server-side judge call. |
| `homebrew-tap/` | The Homebrew formula (`AgentX-ai/tap/agentx`). |
| `install.sh` | The `curl \| bash` installer — downloads the platform binary from GitHub Releases. |
| `build.sh` | Builds a local `dist/` laid out the same way a real install would, for testing the full distribution without cutting a release. |
| `scripts/` | `smoke-test.sh` / `smoke_test.py` — end-to-end verification against a real running engine and the real Python SDK. |

## Building from source

Prerequisites: [Go](https://go.dev/), Node.js + [Yarn](https://yarnpkg.com/), and
[Bun](https://bun.sh/) (only needed for the compiled single-binary path, not day-to-day dev).

```bash
git clone git@github.com:AgentX-ai/AgentX-trace-eval.git && cd AgentX-trace-eval
yarn install   # workspace install: engine/ + packages/judge-core together
```

### Fastest dev loop

Runs the engine directly via `tsx`, no compile step, restarts on file changes. `web/` isn't
committed (see [What's in this repo](#whats-in-this-repo)), so populate it once before your first
run — grab the prebuilt dashboard bundle (works for anyone, no private-repo access needed):

```bash
mkdir -p web && curl -fsSL https://github.com/AgentX-ai/AgentX-trace-eval/releases/latest/download/agentx-web.tar.gz | tar -xz -C web
cd engine && yarn dev --dev
```

The dashboard's source (`AgentX-eval-front`) is a private repo; if you're on the AgentX team and
have it checked out as a sibling directory, build it from source instead:

```bash
(cd ../AgentX-eval-front && yarn install && yarn build:selfhost) && rm -rf web && cp -r ../AgentX-eval-front/dist web
```

Iterating on the engine's API doesn't need a `web/` rebuild; iterating on the dashboard itself
means re-running whichever step above got you `web/` in the first place — there's no hot-reload
loop wired up between the two repos yet.

### Full distribution build

Compiles the engine to a Bun-compiled binary and builds the Go CLI, laid out exactly the way a
`brew install`/`curl | bash` install would:

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
Postgres) to verify against Postgres instead — see the script's own header for the exact command.

## Dashboard release process

`AgentX-eval-front` (the app that builds into `web/`) is AgentX's private frontend dedicated to
this Governance dashboard. Rather than open-sourcing it, only its **build output** is public: a
workflow in that repo builds it in self-host mode and uploads the result as `agentx-web.tar.gz`
onto this repo's own GitHub releases. `install.sh`, `build.sh`, and the Homebrew formula all fetch
it from there — nobody installing or building this repo, including outside contributors, ever
needs access to that private repo.

Maintainers cutting a new dashboard build: in `AgentX-eval-front`'s Actions tab, run "Publish
self-host web bundle" (optionally targeting a specific release tag here; defaults to whatever's
currently latest). One-time setup: a fine-grained PAT scoped to this repo with release/contents
write access, saved as `AgentX-eval-front`'s `SELFHOST_RELEASE_TOKEN` secret.

## Project status

Trace, Evaluate, and Monitor are wired end-to-end and verified against the real Python SDK, both
SQLite and Postgres, and the compiled single-binary distribution — including a real OTLP/HTTP
receiver verified against both protobuf and JSON payloads. The dashboard covers Governance's full
self-host surface: Trace ingest, Monitor (patterns, online evaluators, custom evaluators, signals
triage, KPIs), and Evaluate (runs, datasets, standalone evaluator configs, version history, the
Prompt Registry, Model Portability, and Playground).

**Known gaps:**

- The self-host build ships the full frontend bundle rather than one trimmed to just Governance —
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

Issues and PRs are welcome. There's no separate `CONTRIBUTING.md` yet — for anything beyond a
small fix, please open an issue first to discuss the approach. Run `yarn install` at the repo root
(a workspace install covering `engine/` and `packages/judge-core/` together), and see
[Building from source](#building-from-source) for the dev loop and smoke test.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
