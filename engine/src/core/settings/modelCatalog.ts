import type { Db } from "../../storage/db.js";
import { getAppSettings } from "./appSettings.js";
import { DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { logger } from "../../log.js";

// The model catalog behind every model PICKER in the dashboard (Platform model, and anywhere
// else that grows one): what can this instance actually call right now?
//
// Three sources, each labeled so the picker can group them:
// - builtin: the curated direct-provider names (OpenAI/Anthropic/Gemini) the engine routes
//   natively. Deliberately short - a menu, not an encyclopedia.
// - custom: the pricing catalog's custom endpoints (vLLM/Ollama/...), by their configured ids.
// - openrouter: the live OpenRouter catalog (vendor/model ids), included only when an
//   OpenRouter key is configured - listing hundreds of models the instance cannot call would
//   be noise, not choice. Fetched from their public /models endpoint and cached for 10
//   minutes; a fetch failure degrades to the other sources rather than failing the picker.

export type CatalogModel = { id: string; label: string; source: "builtin" | "custom" | "openrouter" };

const BUILTIN_MODELS: CatalogModel[] = [
  { id: DEFAULT_JUDGE_MODEL, label: `${DEFAULT_JUDGE_MODEL} (engine default)`, source: "builtin" },
  { id: "gpt-5.5-turbo", label: "gpt-5.5-turbo", source: "builtin" },
  { id: "gpt-4o", label: "gpt-4o", source: "builtin" },
  { id: "gpt-4o-mini", label: "gpt-4o-mini", source: "builtin" },
  { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5", source: "builtin" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5", source: "builtin" },
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash", source: "builtin" },
  { id: "gemini-2.5-pro", label: "gemini-2.5-pro", source: "builtin" },
];

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_MS = 10 * 60 * 1000;
let openrouterCache: { at: number; models: CatalogModel[] } | null = null;

async function fetchOpenRouterModels(): Promise<CatalogModel[]> {
  if (openrouterCache && Date.now() - openrouterCache.at < OPENROUTER_CACHE_MS) {
    return openrouterCache.models;
  }
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
    const models = (body.data ?? [])
      .filter((row): row is { id: string; name?: string } => typeof row.id === "string")
      .map(row => ({
        id: row.id,
        label: typeof row.name === "string" && row.name ? row.name : row.id,
        source: "openrouter" as const,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    openrouterCache = { at: Date.now(), models };
    return models;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "OpenRouter model catalog fetch failed");
    return openrouterCache?.models ?? [];
  }
}

export async function getModelCatalog(db: Db): Promise<{ models: CatalogModel[]; openrouterConfigured: boolean }> {
  const settings = await getAppSettings(db);
  const openrouterConfigured = !!(settings.openrouterApiKey || process.env.OPENROUTER_API_KEY);

  const { listPortabilityModels } = await import("../evaluate/models.js");
  const custom = (await listPortabilityModels(db).catch(() => []))
    .filter(row => row.provider === "custom")
    .map(row => ({ id: row.id, label: row.label || row.id, source: "custom" as const }));

  const openrouter = openrouterConfigured ? await fetchOpenRouterModels() : [];
  return { models: [...BUILTIN_MODELS, ...custom, ...openrouter], openrouterConfigured };
}
