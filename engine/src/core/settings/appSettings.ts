import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Singleton row (LLM provider keys today) — one instance-wide config, not per-user/per-workspace,
// matching self-host's single-tenant model everywhere else. Plaintext (see schema.sqlite.ts's
// appSettings comment for why that's not a gap here).
const SETTINGS_ROW_ID = "default";

export type AppSettings = {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
};

type AppSettingsRow = AppSettings & { id: string; updatedAt: Date };

async function getRow(db: Db): Promise<AppSettingsRow | undefined> {
  const cond = eq(db.schema.appSettings.id, SETTINGS_ROW_ID);
  return db.kind === "sqlite"
    ? (db.db.select().from(db.schema.appSettings).where(cond).all()[0] as AppSettingsRow | undefined)
    : ((await db.db.select().from(db.schema.appSettings).where(cond))[0] as AppSettingsRow | undefined);
}

export async function getAppSettings(db: Db): Promise<AppSettings> {
  const row = await getRow(db);
  return { openaiApiKey: row?.openaiApiKey ?? null, anthropicApiKey: row?.anthropicApiKey ?? null };
}

// Empty string is treated the same as clearing the key (not stored as "", which a later
// `if (key)` truthiness check would still treat as falsy-but-present — nicer to just store null).
export async function updateAppSettings(
  db: Db,
  patch: { openaiApiKey?: string | null; anthropicApiKey?: string | null }
): Promise<AppSettings> {
  const existing = await getRow(db);
  const next: AppSettings = {
    openaiApiKey: "openaiApiKey" in patch ? patch.openaiApiKey || null : (existing?.openaiApiKey ?? null),
    anthropicApiKey: "anthropicApiKey" in patch ? patch.anthropicApiKey || null : (existing?.anthropicApiKey ?? null),
  };
  const row = { id: SETTINGS_ROW_ID, ...next, updatedAt: new Date() };

  if (existing) {
    const cond = eq(db.schema.appSettings.id, SETTINGS_ROW_ID);
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
