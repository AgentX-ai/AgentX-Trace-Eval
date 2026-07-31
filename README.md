# AgentX-SelfHosted

A portable, self-hostable build of AgentX's Governance layer: Evaluate, Monitor, and Trace for
AI agents, as a single local install. No account, no multi-tenant billing, bring your own LLM
API keys.

```
brew install AgentX-ai/tap/agentx   # or: curl -sSL https://get.agentx.so | bash
agentx-server --dev
```

`--dev` starts the engine (API server) on a local SQLite database, opens the dashboard in your
browser, and prints a local API key for the SDK. **This install path needs a published release,
which doesn't exist yet**, see "Running from source" below for what actually works today.

## Running from source

Prerequisites: [Go](https://go.dev/), Node.js + [Yarn](https://yarnpkg.com/), and
[Bun](https://bun.sh/) (only needed for the compiled single-binary path below, not for day-to-day
dev). The dashboard is the real [AgentX-web-front](https://github.com/AgentX-ai/AgentX-web-front)
app built in self-host mode; that repo is private, so unless you have access to it, you'll use the
prebuilt dashboard release instead of a sibling checkout — see "Dashboard release" below, neither
is required just to build and run the engine/CLI on their own.

```bash
git clone <this repo> && cd AgentX-SelfHosted
yarn install   # workspace install: engine/ + packages/judge-core together
```

**Fastest loop while developing**: runs the engine directly via `tsx`, no compile step, restarts
on file changes. `web/` isn't committed to this repo (see "What's in this repo" below), so build
the dashboard into it once before your first run. If you have `AgentX-web-front` checked out as a
sibling directory (AgentX's own team only, that repo is private, see "Dashboard release"):

```bash
(cd ../AgentX-web-front && yarn install && yarn build:selfhost) && rm -rf web && cp -r ../AgentX-web-front/dist web
```

Otherwise, grab the prebuilt bundle instead (works for anyone, no private-repo access needed):

```bash
mkdir -p web && curl -fsSL https://github.com/AgentX-ai/AgentX-SelfHosted/releases/latest/download/agentx-web.tar.gz | tar -xz -C web
```

Then either way:

```bash
cd engine && yarn dev --dev
```

Iterating on the engine's API doesn't need a rebuild of `web/`; iterating on the dashboard itself
means re-running whichever step above got you `web/` in the first place (no hot-reload wired up
between the two repos yet, see "Status").

**Full distribution**: compiles the engine to a real Bun-compiled binary and builds the Go CLI,
laid out exactly the way a `brew install`/`curl | bash` install would (see `build.sh`). Builds the
dashboard from `../AgentX-web-front` if that sibling checkout exists, otherwise downloads the
prebuilt `agentx-web.tar.gz` release asset automatically (see "Dashboard release"):

```bash
./build.sh
./dist/agentx-server --dev
```

Either way, once it's up you'll see:

```
AgentX self-host engine listening on http://localhost:4700
Local API key: agtx_local_...
```

`--dev` also opens the dashboard at `http://localhost:4700` in your browser. Set
`OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in the environment before starting it if you want
Evaluate's judge scoring or Monitor's semantic pattern detection to actually work (everything
else, Trace ingest, built-in/custom pattern matching on phrase or regex, works with no keys at
all). By default it uses a local SQLite file under `~/.agentx`; set `AGENTX_DB_URL=postgres://...`
to point it at your own Postgres instead.

To confirm everything actually works end-to-end without writing your own script:

```bash
OPENAI_API_KEY=sk-... ./scripts/smoke-test.sh
```

## What's in this repo

- `cli/`: Go CLI (`agentx-server`), installer glue + process supervisor. Launches the bundled
  engine binary, opens the browser, handles shutdown.
- `engine/`: TypeScript governance engine + HTTP API (Evaluate, Monitor, Trace). Compiles to a
  single native executable via Bun (`bun build --compile`) so end users never need Node/Bun
  installed. Storage is SQLite by default; set `AGENTX_DB_URL=postgres://...` to use your own
  Postgres instead.
- `packages/judge-core/`: the LLM-as-judge prompt/scoring logic, published as its own package
  (`@agentx/judge-core`) so `engine/` and AgentX's hosted SaaS backend share one implementation
  instead of maintaining separate copies.
- `web/`: the dashboard, not tracked in this repo. Populated either by building the real
  [AgentX-web-front](https://github.com/AgentX-ai/AgentX-web-front) app in self-host mode
  (`VITE_SELF_HOSTED=true`, see its `.env.selfhost`/`build:selfhost`) from a sibling checkout, or
  by downloading that same build prebuilt — see "Dashboard release". Same governance UI
  (Trace/Evaluate/Monitor) as the hosted SaaS's Governance page, single-sourced instead of a
  separate rebuild: self-host mode swaps out login/workspace-switching for a synthetic
  always-logged-in local user/workspace and points `restClient` at this engine's local API key
  instead of session cookies (see `src/lib/selfHostMode.ts`, `AuthProvider`/`WorkspaceProvider`,
  `initAxios.ts` there).
- `homebrew-tap/`: the Homebrew formula.
- `install.sh`: the `curl | bash` installer.
- `build.sh`: builds a local `dist/` laid out the same way an install would (`agentx`,
  `agentx-server`, `agentx-engine`, `web/`), for testing the full distribution without a release.

## SDK compatibility

The existing [AgentX Python SDK](https://github.com/AgentX-ai/AgentX-Python) already supports
pointing at any base URL. Point it at your local instance and it works unmodified:

```bash
export AGENTX_API_BASE_URL=http://localhost:4700/api/v1
export AGENTX_API_KEY=<printed by agentx-server on first run>
```

## Dashboard release

`AgentX-web-front` (the app that builds into `web/`) is AgentX's private, closed-source SaaS
frontend — Governance is one page out of ~30 routes in it, most of which don't apply to
self-host at all. Rather than open-sourcing that whole app or forking its Governance page into a
second implementation to maintain, only its **build output** is public: a private workflow in
that repo (`.github/workflows/publish-selfhost-web.yml`) builds it in self-host mode and uploads
the result as `agentx-web.tar.gz`, a platform-independent asset, onto this repo's own GitHub
releases. `install.sh`, `build.sh`, and the Homebrew formula all fetch it from there. Nobody
installing or building this repo — including outside contributors with no access to
`AgentX-web-front` — ever needs that private repo; only AgentX's own release process does. A
sibling `../AgentX-web-front` checkout (see "Running from source") is a from-source alternative
for people who do have access, not a requirement.

To cut a new dashboard build: in `AgentX-web-front`'s GitHub Actions tab, run "Publish self-host
web bundle" (`workflow_dispatch`), optionally pointing it at a specific `AgentX-SelfHosted`
release tag (defaults to whatever's currently latest here). One-time setup that workflow needs,
done once in `AgentX-web-front`'s repo settings: a fine-grained PAT scoped to
`AgentX-ai/AgentX-SelfHosted` with release/contents write access, saved as a secret named
`SELFHOST_RELEASE_TOKEN`. That workflow also needs `.env.selfhost` committed in
`AgentX-web-front` (it holds no secrets, just public build-time config like
`VITE_BASE_API_URL`), the same way `.env.placeholders` already is for the Docker build.

## Status

Trace, Evaluate, and Monitor are all wired end-to-end and verified against the real Python SDK
(judge scoring, built-in/custom pattern detection, idempotency, dedup), against both SQLite and a
real Postgres instance (`scripts/smoke-test.sh` run against a Dockerized Postgres, data checked
directly with `psql`, not just through the API). The CLI, Bun-compiled engine binary, and the
real AgentX-web-front dashboard (self-host build mode) all work together from a clean install
layout (`build.sh` builds both and lays them out the same way a release would), verified with the
compiled `agentx-engine` binary actually serving the built SPA plus real ingested trace data
through its API.

Dashboard scope for now is Governance's shell plus the Observe tab (Trace ingest + Monitor
signals/patterns) only, verified via curl against the running engine rather than a real browser
(none available in this environment). Not yet wired up: EvaluateTab (dataset/run management UI)
and PatternsTab/AgentsTab (pattern CRUD, per-agent settings) still call routes that don't exist on
this engine yet; the self-host build still ships web-front's full ~30-route bundle rather than a
build trimmed to just Governance; there's no hot-reload loop between an `AgentX-web-front` dev
server and this engine yet (see "Running from source"). Also not yet done: the install script,
Homebrew formula, and `build.sh`'s download fallback are structurally correct and match each
other's expected asset names/layout (verified: `build.sh`'s fallback path was exercised directly
against the real, currently-release-less repo and degrades to an API-only build as designed,
rather than crashing), but none of them have been exercised against a real GitHub release with
real `agentx-web.tar.gz`/`agentx_<os>_<arch>.tar.gz` assets attached (none published yet, and the
`publish-selfhost-web.yml` workflow that would produce the former hasn't been run, since it needs
a one-time `SELFHOST_RELEASE_TOKEN` secret set up in `AgentX-web-front`'s repo settings first, see
"Dashboard release"); Guardrail isn't started (see the plan, it
doesn't exist yet even on the hosted SaaS); Evaluate's async whole-run analysis
(`analyze_run`/`get_report`) is deliberately out of scope for now.

## License

Apache-2.0 (see `LICENSE`).
