<!-- Delete any section that does not apply. A one-line PR does not need all of this. -->

## What this changes, and why

<!-- The behaviour before and after. If it fixes a bug, what the bug actually was. -->

## How it was verified

<!-- Which suite, which command, run against what. "Tests pass" is not verification; naming the
     case that would have failed before is. Say so plainly if something is unverified. -->

## Checklist

- [ ] `yarn typecheck` and `yarn workspace @agentx/engine lint` pass
- [ ] `yarn workspace @agentx/engine test` passes
- [ ] Changed a response shape covered by `src/contract/wire.ts`? The contract is updated in this
      same commit
- [ ] New or changed mutating route? It validates with `validateBody(schema)`, and its entry is
      deleted from `routeBodyValidation.test.ts` if it had one
- [ ] Schema change? Additive DDL in `columnMigrations` (sqlite) and the `IF NOT EXISTS` block
      (pg), with existing ids left byte-identical
- [ ] New setting? It gates real behaviour. A control that stores state nothing reads is a bug
