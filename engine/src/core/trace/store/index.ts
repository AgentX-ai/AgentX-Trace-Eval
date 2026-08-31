import type { Db } from "../../../storage/db.js";
import { SqlTraceStore } from "./sqlTraceStore.js";
import type { TraceStore } from "./traceStore.js";
import {
  ClickHouseTraceStore,
  bootstrapClickHouse,
  createClickHouseClientFromUrl,
} from "./clickhouseTraceStore.js";
import type { ClickHouseClient } from "@clickhouse/client";
import { logger } from "../../../log.js";

export type { RootsPageQuery, SpanWindowFilter, TraceRow, TraceStore } from "./traceStore.js";
export { SqlTraceStore } from "./sqlTraceStore.js";
export { ClickHouseTraceStore } from "./clickhouseTraceStore.js";

// The tier switch (ADR-0001/0003): AGENTX_TELEMETRY_URL points spans at ClickHouse while the
// relational database stays the control plane. Unset (the default), spans live in the same
// SQLite/Postgres database they always have - the tier is a deployment choice, never a fork.
const TELEMETRY_URL = process.env.AGENTX_TELEMETRY_URL;
// NaN-safe: a typo'd value falls back to 90 instead of producing "TTL ... INTERVAL NaN DAY".
const ttlRaw = Number(process.env.AGENTX_TELEMETRY_TTL_DAYS ?? 90);
const TELEMETRY_TTL_DAYS = Number.isFinite(ttlRaw) ? Math.max(1, Math.floor(ttlRaw)) : 90;

let chClient: ClickHouseClient | null = null;
let chReady: Promise<void> | null = null;

/** Boots the ClickHouse schema once at startup when the enterprise tier is configured. */
export async function initTelemetryStore(): Promise<void> {
  if (!TELEMETRY_URL) return;
  chClient = createClickHouseClientFromUrl(TELEMETRY_URL);
  chReady = bootstrapClickHouse(chClient, TELEMETRY_TTL_DAYS);
  await chReady;
  logger.info(`Telemetry store: ClickHouse (${new URL(TELEMETRY_URL).host}, TTL ${TELEMETRY_TTL_DAYS}d)`);
}

export async function closeTelemetryStore(): Promise<void> {
  await chClient?.close();
  chClient = null;
}

// One store per Db handle. Db handles are created per request (project scoping), so the cache
// is a WeakMap keyed on the handle: no lifecycle management, no cross-project leakage - each
// scoped handle gets a store carrying exactly its own scope.
const stores = new WeakMap<Db, TraceStore>();

export function traceStoreFor(db: Db): TraceStore {
  let store = stores.get(db);
  if (!store) {
    store = chClient ? new ClickHouseTraceStore(chClient, db.projectId) : new SqlTraceStore(db);
    stores.set(db, store);
  }
  return store;
}
