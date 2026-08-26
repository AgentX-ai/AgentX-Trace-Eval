# Contributing

Issues and PRs are welcome. For anything beyond a small fix, please open an issue first so the
approach can be agreed before the work happens.

The engine's own conventions, which are the substance of a review here, live in
[engine/CONTRIBUTING.md](engine/CONTRIBUTING.md): wire casing, the `src/contract/wire.ts` response
contract, body validation, per-dialect queries, migrations, sampling. Read that before touching
`engine/`. This file covers the repo as a whole.

## Getting set up

```bash
yarn install                              # one workspace install: engine/ + packages/judge-core/
yarn workspace @agentx/judge-core build   # engine imports it through its exports map, so build first
yarn workspace @agentx/engine dev         # tsx watch loop on http://localhost:4700
```

[README's "Building from source"](README.md#building-from-source) covers the dashboard bundle, the
full distribution build, and the end-to-end smoke test.

## What CI will run against your PR

Run these before pushing. They are the same commands the workflow runs, so a local pass is a real
prediction rather than a hopeful one.

| Command | What it protects |
| --- | --- |
| `yarn typecheck` | strict TypeScript across both workspaces |
| `yarn workspace @agentx/engine lint` | async discipline the compiler cannot see, see `engine/eslint.config.mjs` |
| `yarn workspace @agentx/engine test` | the integration-first suite, on SQLite |
| `yarn workspace @agentx/engine test:coverage` | the same suite behind the coverage floors |
| `cd cli && gofmt -l . && go vet ./... && go test -race ./...` | the Go CLI |
| `shellcheck install.sh build.sh scripts/*.sh` | the scripts users pipe into bash |

CI additionally runs the engine suite a second time against a real Postgres service, and smoke
tests the `bun build --compile` binary that releases actually ship. To reproduce the Postgres run
locally, point `AGENTX_TEST_DB_URL` at a superuser connection string; the suites create and drop
their own throwaway databases, and skip entirely when the variable is unset.

## Tests

Prefer extending an existing `engine/src/test/*.integration.test.ts` over mocking internals. Those
suites boot the real engine as a subprocess (`src/test/server.ts`) and speak HTTP to it, because
the failures worth catching are runtime ones: a rejection that kills the process, a migration that
only runs against a fresh database, a query that is fine on SQLite and wrong on Postgres. None of
those reproduce against a hand-assembled express app.

Booting an engine costs seconds, so `engine/vitest.config.ts` sets a 60s default timeout. A case
that boots more than once should still state its own budget explicitly.

## Ratchets

Two checks measure a number and refuse to let it get worse, rather than demanding the codebase
already be perfect:

- **Coverage**, in `engine/package.json`'s `test:coverage` and described in
  `.github/workflows/test.yml`. Raise the floors when coverage rises. Never lower them to make a
  PR pass.
- **Route body validation**, in `engine/src/test/routeBodyValidation.test.ts`. It holds a frozen
  list of mutating routes that still hand-roll their body checks. A new route not using
  `validateBody(schema)` fails the build, and converting one fails it too until you delete the
  entry. The list may shrink and never grow.

If a ratchet blocks you, the fix is the code, not the threshold.

## Style

Match the file you are editing. The one convention worth stating outright, because it is
unusual: comments here explain what the code cannot say for itself, which is the constraint, the
bug a guard exists for, the contract being preserved, or the alternative that was tried and
failed. A comment restating the line below it is noise. Also, no em-dashes in any output.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under Apache-2.0, matching
[LICENSE](LICENSE).
