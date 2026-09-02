import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
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

// One-time backfill (guarded by app_settings.framework_casefolded_at): ingest folds `framework`
// to lowercase since the Platforms chart landed, and the chart/filters fold their queries the
// same way - but rows stored BEFORE that keep their original casing ("LangChain"), so old
// traffic would silently neither match the framework filter nor group with new traffic. Rewrite
// once, on every backend this install uses, then never scan again.
export async function backfillFrameworkCasefold(db: Db): Promise<void> {
  try {
    const settings =
      db.kind === "sqlite"
        ? db.db.select().from(db.schema.appSettings).limit(1).all()[0]
        : (await db.db.select().from(db.schema.appSettings).limit(1))[0];
    if ((settings as { frameworkCasefoldedAt?: Date | null } | undefined)?.frameworkCasefoldedAt) {
      return;
    }

    // Branches narrow drizzle's dialect union - .update() (and the table ref itself) is not
    // usable on the bare Db.
    if (db.kind === "sqlite") {
      const t = db.schema.traces;
      const folded = sql`lower(trim(${t.framework}))`;
      await db.db.update(t).set({ framework: folded }).where(and(isNotNull(t.framework), ne(t.framework, folded)));
    } else {
      const t = db.schema.traces;
      const folded = sql`lower(trim(${t.framework}))`;
      await db.db.update(t).set({ framework: folded }).where(and(isNotNull(t.framework), ne(t.framework, folded)));
    }

    // Enterprise tier: the spans live in ClickHouse. A mutation completes asynchronously
    // server-side, which is fine - reads meanwhile see a mix of cased/folded rows for a few
    // seconds, exactly what the pre-backfill state already was.
    if (chClient) {
      await chClient.command({
        query:
          "ALTER TABLE agentx_spans UPDATE agentx_framework = lowerUTF8(trimBoth(agentx_framework)) " +
          "WHERE agentx_framework IS NOT NULL AND agentx_framework != lowerUTF8(trimBoth(agentx_framework))",
      });
    }

    const now = new Date();
    if (settings) {
      const where = eq(db.schema.appSettings.id, (settings as { id: string }).id);
      if (db.kind === "sqlite") {
        await db.db.update(db.schema.appSettings).set({ frameworkCasefoldedAt: now }).where(where);
      } else {
        await db.db.update(db.schema.appSettings).set({ frameworkCasefoldedAt: now }).where(where);
      }
    } else {
      // No settings row yet (fresh install pre-first-save): the marker still has to persist or
      // every boot rescans. Insert the singleton the same way markMetricPackBackfillDone does.
      const row = { id: `app-${now.getTime()}`, frameworkCasefoldedAt: now, updatedAt: now };
      if (db.kind === "sqlite") {
        await db.db.insert(db.schema.appSettings).values(row);
      } else {
        await db.db.insert(db.schema.appSettings).values(row);
      }
    }
    logger.info("Framework casefold backfill complete (pre-existing trace labels folded to lowercase).");
  } catch (err) {
    // Non-fatal: the next boot retries (marker only written on success), and unfolded legacy
    // rows degrade to the exact pre-backfill behavior, never worse.
    logger.error({ err: err instanceof Error ? err.message : err }, "Framework casefold backfill failed:");
  }
}
