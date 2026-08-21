import { and, eq, ne } from "drizzle-orm";
import OpenAI from "openai";
import type { Db } from "../../storage/db.js";
import { isMultiTenant } from "../../auth/mode.js";
import { currentTenancy } from "../../auth/requestContext.js";

// Multi-tenant visibility: the global seeded catalog (organizationId null) is shared read-only
// defaults; each org additionally sees and manages its own rows. Single-tenant modes see and
// manage everything (org is null everywhere).
function tenantOrgId(): string | null {
  if (!isMultiTenant()) return null;
  return currentTenancy().organizationId ?? null;
}
import { maskSecret } from "../shared/maskSecret.js";

// Model Portability's candidate models + $/M-token pricing - dashboard-editable
// (portability_models table, seeded once on first boot with a small curated default set, see
// storage/db.ts's seedPortabilityModelsIfEmpty), not a hardcoded list anymore. No live pricing API
// exists or should be added (an external dependency self-host has no reason to take on just to
// show a cost estimate) - prices are whatever the user has configured here, approximate/
// point-in-time by nature, verify against the provider's current pricing page before using a
// resulting estimate for a real budget decision.
//
// provider "custom" is any bring-your-own OpenAI-compatible endpoint (vLLM, Ollama, LM Studio,
// ...) - baseUrl/apiKeyMasked are only ever set for those rows; openai/anthropic rows use Platform
// Settings' shared provider keys instead and leave both null. apiKeyMasked is exactly that - never
// the raw stored key (see toWire below); core/evaluate/judge.ts's resolveModelRouting is the only
// internal caller that ever reads the real value, via getPortabilityModelRaw.
export type PortabilityModel = {
  id: string;
  provider: "openai" | "anthropic" | "gemini" | "custom";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  // Nullable: null means "not configured" - estimateCostUSD below falls back to
  // pricePerMInputTokens for that token type, so an unconfigured model prices identically to
  // before this feature existed.
  pricePerMCacheReadTokens: number | null;
  pricePerMCacheWriteTokens: number | null;
  isDefault: boolean;
  baseUrl: string | null;
  apiKeyMasked: string | null;
};

export type PortabilityModelRow = {
  id: string;
  organizationId?: string | null;
  provider: "openai" | "anthropic" | "gemini" | "custom";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  pricePerMCacheReadTokens: number | null;
  pricePerMCacheWriteTokens: number | null;
  isDefault: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toWire(row: PortabilityModelRow): PortabilityModel {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    pricePerMInputTokens: row.pricePerMInputTokens,
    pricePerMOutputTokens: row.pricePerMOutputTokens,
    pricePerMCacheReadTokens: row.pricePerMCacheReadTokens,
    pricePerMCacheWriteTokens: row.pricePerMCacheWriteTokens,
    isDefault: row.isDefault,
    baseUrl: row.baseUrl,
    apiKeyMasked: row.apiKey ? maskSecret(row.apiKey) : null,
  };
}

// Default row first (judge-model dropdowns preselect index 0 - see CreateEvaluationSettingsConfigDialog.tsx's
// selfHostDefaultJudgeModel and AgentEvaluationAnalysisPanel.tsx's pickDiverseJudgeModel), alphabetical after that.
export async function listPortabilityModels(db: Db): Promise<PortabilityModel[]> {
  let rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.portabilityModels).all()
      : await db.db.select().from(db.schema.portabilityModels)
  ) as PortabilityModelRow[];
  if (isMultiTenant()) {
    const org = tenantOrgId();
    rows = rows.filter(r => r.organizationId == null || r.organizationId === org);
  }
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
  return rows.map(toWire);
}

export async function getPortabilityModel(db: Db, id: string): Promise<PortabilityModel | null> {
  const row = await getPortabilityModelRaw(db, id);
  return row ? toWire(row) : null;
}

// Internal only - the raw row, including the real (unmasked) apiKey. Never exposed on the wire;
// the only legitimate caller is judge.ts's resolveModelRouting, which needs the actual key to
// construct a client for a custom-provider model.
export async function getPortabilityModelRaw(db: Db, id: string): Promise<PortabilityModelRow | null> {
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id)).all()[0] as
          | PortabilityModelRow
          | undefined)
      : ((await db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id)))[0] as
          | PortabilityModelRow
          | undefined);
  return row ?? null;
}

export type SavePortabilityModelInput = {
  id: string;
  provider: "openai" | "anthropic" | "gemini" | "custom";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  pricePerMCacheReadTokens?: number | null;
  pricePerMCacheWriteTokens?: number | null;
  isDefault?: boolean;
  baseUrl?: string | null;
  apiKey?: string | null;
};

// At most one model is "default" at a time (judge-model dropdowns preselect it) - clear any
// existing default before a create/update sets a new one. Same pattern as
// evaluationSettings.ts's clearDefaultEvaluationSettings.
async function clearDefaultPortabilityModel(db: Db, exceptId?: string): Promise<void> {
  let cond = exceptId
    ? and(eq(db.schema.portabilityModels.isDefault, true), ne(db.schema.portabilityModels.id, exceptId))
    : eq(db.schema.portabilityModels.isDefault, true);
  // Multi-tenant: a tenant's default only competes with its own rows, never the global seed's.
  if (isMultiTenant()) {
    const org = tenantOrgId();
    cond = org ? and(cond, eq(db.schema.portabilityModels.organizationId, org)) : cond;
  }
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.portabilityModels).set({ isDefault: false }).where(cond);
  } else {
    await db.db.update(db.schema.portabilityModels).set({ isDefault: false }).where(cond);
  }
}

export async function createPortabilityModel(db: Db, input: SavePortabilityModelInput): Promise<PortabilityModel> {
  const now = new Date();
  const row: PortabilityModelRow = {
    id: input.id,
    organizationId: tenantOrgId(),
    provider: input.provider,
    label: input.label,
    pricePerMInputTokens: input.pricePerMInputTokens,
    pricePerMOutputTokens: input.pricePerMOutputTokens,
    pricePerMCacheReadTokens: input.pricePerMCacheReadTokens ?? null,
    pricePerMCacheWriteTokens: input.pricePerMCacheWriteTokens ?? null,
    isDefault: input.isDefault ?? false,
    baseUrl: input.baseUrl || null,
    apiKey: input.apiKey || null,
    createdAt: now,
    updatedAt: now,
  };
  if (row.isDefault) {
    await clearDefaultPortabilityModel(db);
  }
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.portabilityModels).values(row);
  } else {
    await db.db.insert(db.schema.portabilityModels).values(row);
  }
  return toWire(row);
}

export type UpdatePortabilityModelInput = {
  provider: "openai" | "anthropic" | "gemini" | "custom";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
  pricePerMCacheReadTokens?: number | null;
  pricePerMCacheWriteTokens?: number | null;
  isDefault?: boolean;
  baseUrl?: string | null;
  // Omitted (property absent from the object entirely) => keep the existing stored key, so
  // re-saving a custom model's price doesn't silently wipe its key. Explicitly provided (including
  // "" / null) => overwrite. The route only includes this key when the user actually typed a new
  // value - see routes/agentMonitoringDashboard.ts's PUT handler.
  apiKey?: string | null;
};

// Full replace of the mutable fields, same convention as core/monitor/patterns.ts's
// updatePattern - the dashboard's edit form always submits the complete row, not a sparse patch -
// except apiKey, which is merge-on-omit (see UpdatePortabilityModelInput's comment).
export async function updatePortabilityModel(
  db: Db,
  id: string,
  input: UpdatePortabilityModelInput
): Promise<PortabilityModel | null> {
  const existingRow = await getPortabilityModelRaw(db, id);
  if (!existingRow) {
    return null;
  }
  // Multi-tenant: global seeded rows are read-only defaults; a tenant edits only its own.
  if (isMultiTenant() && existingRow.organizationId !== tenantOrgId()) {
    return null;
  }
  const isDefault = input.isDefault ?? existingRow.isDefault;
  if (isDefault) {
    await clearDefaultPortabilityModel(db, id);
  }
  const apiKey = "apiKey" in input ? input.apiKey || null : existingRow.apiKey;
  const row: PortabilityModelRow = {
    id,
    organizationId: existingRow.organizationId ?? null,
    provider: input.provider,
    label: input.label,
    pricePerMInputTokens: input.pricePerMInputTokens,
    pricePerMOutputTokens: input.pricePerMOutputTokens,
    pricePerMCacheReadTokens: input.pricePerMCacheReadTokens ?? null,
    pricePerMCacheWriteTokens: input.pricePerMCacheWriteTokens ?? null,
    isDefault,
    baseUrl: input.baseUrl || null,
    apiKey,
    createdAt: existingRow.createdAt,
    updatedAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.portabilityModels).set(row).where(eq(db.schema.portabilityModels.id, id));
  } else {
    await db.db.update(db.schema.portabilityModels).set(row).where(eq(db.schema.portabilityModels.id, id));
  }
  return toWire(row);
}

export async function deletePortabilityModel(db: Db, id: string): Promise<boolean> {
  const existing = await getPortabilityModelRaw(db, id);
  if (!existing) {
    return false;
  }
  if (isMultiTenant() && existing.organizationId !== tenantOrgId()) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id));
  } else {
    await db.db.delete(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id));
  }
  return true;
}

// Providers stamp dated snapshot suffixes onto model ids ("gpt-4o-mini-2024-07-18",
// "claude-haiku-4-5-20251001") while the pricing catalog keys the base id. Stripping one trailing
// date suffix lets snapshot traffic price under its base model without a per-snapshot catalog row.
export function normalizeModelId(model: string): string {
  return model.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

// cacheReadTokens/cacheWriteTokens are subsets of inputTokens (not additional tokens - see
// traces.cacheReadTokens's comment in schema.sqlite.ts), priced separately when the model has its
// own cache rates configured. Unconfigured cache rates fall back to the regular input rate, so a
// model that hasn't opted into cache pricing produces byte-identical cost to before this feature.
export function estimateCostUSD(
  model: PortabilityModel | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens?: number | null,
  cacheWriteTokens?: number | null
): number | null {
  if (!model || inputTokens == null || outputTokens == null) {
    return null;
  }
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const regularInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
  const cacheReadRate = model.pricePerMCacheReadTokens ?? model.pricePerMInputTokens;
  const cacheWriteRate = model.pricePerMCacheWriteTokens ?? model.pricePerMInputTokens;
  return (
    (regularInput / 1_000_000) * model.pricePerMInputTokens +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (outputTokens / 1_000_000) * model.pricePerMOutputTokens
  );
}

export type TestCustomModelConnectionResult = { live: boolean; error?: string; availableModelIds?: string[] };

// "Load model" button (PortabilityModelsPanel.tsx) - tests whatever's currently typed in the add/
// edit form, before the model is saved. GET {baseUrl}/models, then confirm modelId is actually
// among the results - zero token cost, and works against any server implementing the standard
// OpenAI-compatible models-list endpoint. Never throws: any failure (network error, bad auth,
// timeout, endpoint not implemented) becomes `{live: false, error}` so the route can always
// respond 200 with something renderable, instead of the frontend needing its own try/catch for a
// deliberately-unreliable-by-nature external call.
export async function testCustomModelConnection({
  baseUrl,
  modelId,
  apiKey,
}: {
  baseUrl: string;
  modelId: string;
  apiKey?: string | null;
}): Promise<TestCustomModelConnectionResult> {
  try {
    // Most self-hosted/local model servers don't require a key at all; the SDK still needs a
    // non-empty string to construct. 8s timeout so a dead/unreachable URL fails fast instead of
    // hanging the dashboard.
    const client = new OpenAI({ apiKey: apiKey || "not-required", baseURL: baseUrl, timeout: 8000 });
    const response = await client.models.list();
    const availableModelIds = response.data.map(m => m.id);
    if (!availableModelIds.includes(modelId)) {
      return {
        live: false,
        error: `Endpoint responded, but "${modelId}" wasn't in its model list.`,
        availableModelIds: availableModelIds.slice(0, 20),
      };
    }
    return { live: true, availableModelIds: availableModelIds.slice(0, 20) };
  } catch (err) {
    return { live: false, error: err instanceof Error ? err.message : "Connection failed" };
  }
}
