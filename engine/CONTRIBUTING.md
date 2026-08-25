# Engine engineering conventions

The checks CI enforces and the conventions it cannot.

## Enforced by CI

- `yarn typecheck` - strict TypeScript, both tsconfigs.
- `yarn lint` - deliberately narrow ESLint set (see `eslint.config.mjs`): async discipline the
  compiler can't check. Fire-and-forget calls must say `void`; a forgotten `await` fails CI.
- `yarn test` - the integration-first suite. Tests boot the real engine (`src/test/server.ts`)
  and speak HTTP; prefer extending an existing `*.integration.test.ts` over mocking internals.
  CI runs the suite twice: SQLite and a real Postgres service.

## Conventions the reviewers enforce

- **Wire casing**: camelCase only on new surfaces. snake_case ingest keys are legacy aliases,
  never the primary name.
- **No placebo knobs**: a control that stores state nothing reads is a bug, not a feature flag.
  If a setting stops gating behavior, mark it legacy in the schema comment and stop rendering it.
- **Body validation**: new/changed routes validate with `validateBody(schema)`
  (`src/routes/validateBody.ts`) - shape/range in the schema, cross-data checks in the handler.
  Never the silent `typeof`-skip pattern it replaced. Unknown keys strip; mistyped fields 400.
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
