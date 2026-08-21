import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { isMultiTenant } from "../../auth/mode.js";
import { currentTenancy } from "../../auth/requestContext.js";

// LLM provider keys. Single-tenant modes use one instance-wide row ("default"). Multi-tenant
// (AGENTX_MULTI_TENANT=true, the cloud posture) resolves a per-organization row instead -
// id "org:<orgId>", the org coming from the request's tenancy context (auth/requestContext.ts)
// - so every tenant brings its own keys and one tenant's judge spend can never ride another's.
// The "default" row also carries instance-wide bookkeeping (auth secret, metric-pack markers)
// via its own accessors; only the key get/update below is org-resolved.
const SETTINGS_ROW_ID = "default";

function settingsRowId(): string {
  if (isMultiTenant()) {
    const { organizationId } = currentTenancy();
    if (organizationId) return `org:${organizationId}`;
  }
  return SETTINGS_ROW_ID;
}

export type AppSettings = {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  geminiApiKey: string | null;
};

type AppSettingsRow = AppSettings & { id: string; updatedAt: Date };

async function getRow(db: Db): Promise<AppSettingsRow | undefined> {
  const cond = eq(db.schema.appSettings.id, settingsRowId());
  return db.kind === "sqlite"
    ? (db.db.select().from(db.schema.appSettings).where(cond).all()[0] as AppSettingsRow | undefined)
    : ((await db.db.select().from(db.schema.appSettings).where(cond))[0] as AppSettingsRow | undefined);
}

export async function getAppSettings(db: Db): Promise<AppSettings> {
  const row = await getRow(db);
  return {
    openaiApiKey: row?.openaiApiKey ?? null,
    anthropicApiKey: row?.anthropicApiKey ?? null,
    geminiApiKey: row?.geminiApiKey ?? null,
  };
}

// Empty string is treated the same as clearing the key (not stored as "", which a later
// `if (key)` truthiness check would still treat as falsy-but-present - nicer to just store null).
export async function updateAppSettings(
  db: Db,
  patch: { openaiApiKey?: string | null; anthropicApiKey?: string | null; geminiApiKey?: string | null }
): Promise<AppSettings> {
  const existing = await getRow(db);
  const next: AppSettings = {
    openaiApiKey: "openaiApiKey" in patch ? patch.openaiApiKey || null : (existing?.openaiApiKey ?? null),
    anthropicApiKey: "anthropicApiKey" in patch ? patch.anthropicApiKey || null : (existing?.anthropicApiKey ?? null),
    geminiApiKey: "geminiApiKey" in patch ? patch.geminiApiKey || null : (existing?.geminiApiKey ?? null),
  };
  const row = { id: settingsRowId(), ...next, updatedAt: new Date() };

  if (existing) {
    const cond = eq(db.schema.appSettings.id, settingsRowId());
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.appSettings).set(row).where(cond);
    } else {
      await db.db.update(db.schema.appSettings).set(row).where(cond);
    }
  } else {
    if (db.kind === "sqlite") {
      await db.db.insert(db.schema.appSettings).values(row);
    } else {
      await db.db.insert(db.schema.appSettings).values(row);
    }
  }
  return next;
}
