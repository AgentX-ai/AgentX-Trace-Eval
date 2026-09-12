import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { isMultiTenant } from "../../auth/mode.js";
import { currentTenancy } from "../../auth/requestContext.js";
import { maskSecret } from "../shared/maskSecret.js";

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
    // Fail closed: a request with no tenancy (an orgless pre-claim project key) must not read
    // or overwrite the INSTANCE-WIDE key row - that row belongs to the operator, and in the
    // cloud posture no tenant request should ever resolve to it. A dedicated sentinel row id
    // simply never matches or creates the "default" row.
    return "org:none";
  }
  return SETTINGS_ROW_ID;
}


// One-time adoption for installs whose app_settings grew "pretender" rows: before the readers
// were keyed on the "default" id, boot-time writers (auth secret, casefold + metric-pack
// markers) inserted rows under random ids, and LIMIT-1 heap order decided which one each boot
// read. Merge every non-org pretender's instance flags onto "default" (creating it from the
// first pretender when absent) and delete the pretenders, so keyed readers see the history
// instead of rotating the session secret and re-running whole-table backfills one last time.
export async function consolidateAppSettingsSingleton(db: Db): Promise<void> {
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.appSettings).all()
      : await db.db.select().from(db.schema.appSettings)
  ) as Array<Record<string, unknown> & { id: string }>;
  const pretenders = rows.filter(r => r.id !== "default" && !r.id.startsWith("org:"));
  // A legacy shared "org:none" sentinel row (written before orgless writes were refused) is
  // unowned cross-tenant state - never merged anywhere, only removed.
  const orgNone = rows.find(r => r.id === "org:none");
  if (orgNone) {
    if (db.kind === "sqlite") {
      db.db.delete(db.schema.appSettings).where(eq(db.schema.appSettings.id, "org:none")).run();
    } else {
      await db.db.delete(db.schema.appSettings).where(eq(db.schema.appSettings.id, "org:none"));
    }
  }
  if (pretenders.length === 0) return;
  const existingDefault = rows.find(r => r.id === "default");
  const FLAGS = [
    "authSecret",
    "frameworkCasefoldedAt",
    "metricPackSeededAt",
    "metricPackVersion",
    "openaiApiKey",
    "anthropicApiKey",
    "geminiApiKey",
    // Every key/selection column must be here: consolidation DELETES the pretender rows, so a
    // column missing from this list is silently destroyed (openrouter keys and the platform
    // model were lost exactly this way before these two lines existed).
    "openrouterApiKey",
    "platformModel",
  ] as const;
  const merged: Record<string, unknown> = { ...(existingDefault ?? { id: "default", updatedAt: new Date() }) };
  for (const pretender of pretenders) {
    for (const flag of FLAGS) {
      if (merged[flag] == null && pretender[flag] != null) merged[flag] = pretender[flag];
    }
  }
  if (db.kind === "sqlite") {
    if (existingDefault) {
      await db.db.update(db.schema.appSettings).set(merged as never).where(eq(db.schema.appSettings.id, "default"));
    } else {
      await db.db.insert(db.schema.appSettings).values({ ...merged, id: "default" } as never);
    }
    for (const pretender of pretenders) {
      await db.db.delete(db.schema.appSettings).where(eq(db.schema.appSettings.id, pretender.id));
    }
  } else {
    if (existingDefault) {
      await db.db.update(db.schema.appSettings).set(merged as never).where(eq(db.schema.appSettings.id, "default"));
    } else {
      await db.db.insert(db.schema.appSettings).values({ ...merged, id: "default" } as never);
    }
    for (const pretender of pretenders) {
      await db.db.delete(db.schema.appSettings).where(eq(db.schema.appSettings.id, pretender.id));
    }
  }
}

export type AppSettings = {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  geminiApiKey: string | null;
  openrouterApiKey: string | null;
  // Default model for platform operations; null = the engine's built-in default.
  platformModel: string | null;
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
    openrouterApiKey: row?.openrouterApiKey ?? null,
    platformModel: row?.platformModel ?? null,
  };
}

// Empty string is treated the same as clearing the key (not stored as "", which a later
// `if (key)` truthiness check would still treat as falsy-but-present - nicer to just store null).
// Thrown when a multi-tenant request with no organization tries to WRITE provider keys: the
// read path fails closed (the "org:none" sentinel matches no real row), but a write used to
// CREATE that sentinel row - one shared key row that every orgless tenant then read and
// billed against, leaking the first writer's key to the rest. Routes map this to a 409.
export class OrglessSettingsWriteError extends Error {
  constructor() {
    super("Claim this project into an organization before configuring LLM keys.");
  }
}

export async function updateAppSettings(
  db: Db,
  patch: {
    openaiApiKey?: string | null;
    anthropicApiKey?: string | null;
    geminiApiKey?: string | null;
    openrouterApiKey?: string | null;
    platformModel?: string | null;
  }
): Promise<AppSettings> {
  if (isMultiTenant() && !currentTenancy().organizationId) {
    throw new OrglessSettingsWriteError();
  }
  const existing = await getRow(db);
  // The GET returns keys as maskSecret(key); the settings form round-trips the whole object,
  // so an untouched field arrives as that exact masked string. Storing it would replace the
  // real key with its 11-character display form - every judge call then 401s at the provider
  // while "configured" still reads true. An echo of the CURRENT key's mask means "unchanged".
  const keepIfMaskedEcho = (incoming: string | null | undefined, stored: string | null | undefined) =>
    incoming && stored && incoming === maskSecret(stored) ? stored : incoming || null;
  const next: AppSettings = {
    openaiApiKey: "openaiApiKey" in patch ? keepIfMaskedEcho(patch.openaiApiKey, existing?.openaiApiKey) : (existing?.openaiApiKey ?? null),
    anthropicApiKey: "anthropicApiKey" in patch ? keepIfMaskedEcho(patch.anthropicApiKey, existing?.anthropicApiKey) : (existing?.anthropicApiKey ?? null),
    geminiApiKey: "geminiApiKey" in patch ? keepIfMaskedEcho(patch.geminiApiKey, existing?.geminiApiKey) : (existing?.geminiApiKey ?? null),
    openrouterApiKey: "openrouterApiKey" in patch ? keepIfMaskedEcho(patch.openrouterApiKey, existing?.openrouterApiKey) : (existing?.openrouterApiKey ?? null),
    platformModel: "platformModel" in patch ? patch.platformModel || null : (existing?.platformModel ?? null),
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
