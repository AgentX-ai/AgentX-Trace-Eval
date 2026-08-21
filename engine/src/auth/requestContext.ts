import { AsyncLocalStorage } from "node:async_hooks";

// Per-request tenancy context, carried via AsyncLocalStorage so deep call sites that never see
// the Express request (judge key resolution in core/evaluate/judge.ts, app settings reads) can
// still resolve WHICH org's settings apply. Set in two places:
//   - requireApiKey() for every data-plane request (the key resolves to a project row, which
//     carries the org), surviving the request's whole async continuation - including the
//     fire-and-forget monitor/online-evaluator passes that outlive the response.
//   - the background sweeps (session, improvement), which iterate projects outside any request
//     and wrap each project's work in runWithTenancy() explicitly.
// Empty context is valid everywhere: single-tenant modes resolve instance-wide settings.

export type TenancyContext = { projectId?: string; organizationId?: string | null };

const storage = new AsyncLocalStorage<TenancyContext>();

export function runWithTenancy<T>(context: TenancyContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentTenancy(): TenancyContext {
  return storage.getStore() ?? {};
}
