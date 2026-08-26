# Engine engineering conventions

The checks CI enforces and the conventions it cannot.

## Enforced by CI

- `yarn typecheck` - strict TypeScript, both tsconfigs.
- `yarn lint` - deliberately narrow ESLint set (see `eslint.config.mjs`): async discipline the
  compiler can't check. Fire-and-forget calls must say `void`; a forgotten `await` fails CI.
- `yarn test` - the integration-first suite. Tests boot the real engine (`src/test/server.ts`)
  and speak HTTP; prefer extending an existing `*.integration.test.ts` over mocking internals.
  CI runs the suite twice: SQLite and a real Postgres service. Booting an engine costs seconds, so
  `vitest.config.ts` sets the default timeout to 60s rather than vitest's 5s; a case that boots
  more than once still states its own budget.

## Conventions the reviewers enforce

- **Wire casing**: camelCase only on new surfaces. snake_case ingest keys are legacy aliases,
  never the primary name.
- **No placebo knobs**: a control that stores state nothing reads is a bug, not a feature flag.
  If a setting stops gating behavior, mark it legacy in the schema comment and stop rendering it.
- **Wire contract**: dashboard-facing response shapes live in `src/contract/wire.ts` (strict
  zod schemas, published at `GET /api/v1/openapi.json`, enforced against live responses by
  `contract.integration.test.ts`). Changing a covered response means updating the contract in
  the same commit; putting a new endpoint under contract is one registry row.
- **Body validation**: new/changed routes validate with `validateBody(schema)`
  (`src/routes/validateBody.ts`) - shape/range in the schema, cross-data checks in the handler.
  Never the silent `typeof`-skip pattern it replaced. Unknown keys strip; mistyped fields 400.
  Enforced, not just reviewed: `src/test/routeBodyValidation.test.ts` freezes the list of routes
  that still hand-roll their checks. A new mutating route without `validateBody` fails the build;
  converting one fails it too until you delete its entry. The list shrinks, never grows.
- **Per-dialect queries**: drizzle's union typing requires separate sqlite/pg select branches;
  duplicate the query per dialect rather than fighting the types with casts.
- **Migrations**: additive DDL in the `columnMigrations` list (sqlite) / `IF NOT EXISTS` block
  (pg). One-shot backfills key on a pre-DDL column-existence check so they run exactly once, at
  the upgrade that introduces the column - see `topics_sample_rate` for the template.
- **Ids never change**: migrations may clone and repoint rows, but existing ids (evaluator ids,
  pattern keys) are referenced by history tables and must stay byte-identical.
- **Sampling**: rates live on the scorers that spend LLM money, validated 0..1
  (`core/shared/sampleRate.ts`). There is no global monitoring sample rate.
- **Comments**: say what the code can't - the constraint, the bug a guard exists for, the wire
  contract being preserved. No em-dashes in any output.
