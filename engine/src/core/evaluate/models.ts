import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Model Portability's candidate models + $/M-token pricing — dashboard-editable
// (portability_models table, seeded once on first boot with a small curated default set, see
// storage/db.ts's seedPortabilityModelsIfEmpty), not a hardcoded list anymore. No live pricing API
// exists or should be added (an external dependency self-host has no reason to take on just to
// show a cost estimate) — prices are whatever the user has configured here, approximate/
// point-in-time by nature, verify against the provider's current pricing page before using a
// resulting estimate for a real budget decision.
export type PortabilityModel = {
  id: string;
  provider: "openai" | "anthropic";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
};

export type PortabilityModelRow = PortabilityModel & { createdAt: Date; updatedAt: Date };

function toWire(row: PortabilityModelRow): PortabilityModel {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    pricePerMInputTokens: row.pricePerMInputTokens,
    pricePerMOutputTokens: row.pricePerMOutputTokens,
  };
}

export async function listPortabilityModels(db: Db): Promise<PortabilityModel[]> {
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.portabilityModels).all()
      : await db.db.select().from(db.schema.portabilityModels)
  ) as PortabilityModelRow[];
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows.map(toWire);
}

export async function getPortabilityModel(db: Db, id: string): Promise<PortabilityModel | null> {
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id)).all()[0] as
          | PortabilityModelRow
          | undefined)
      : ((await db.db.select().from(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id)))[0] as
          | PortabilityModelRow
          | undefined);
  return row ? toWire(row) : null;
}

export type SavePortabilityModelInput = {
  id: string;
  provider: "openai" | "anthropic";
  label: string;
  pricePerMInputTokens: number;
  pricePerMOutputTokens: number;
};

export async function createPortabilityModel(db: Db, input: SavePortabilityModelInput): Promise<PortabilityModel> {
  const now = new Date();
  const row: PortabilityModelRow = { ...input, createdAt: now, updatedAt: now };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.portabilityModels).values(row);
  } else {
    await db.db.insert(db.schema.portabilityModels).values(row);
  }
  return toWire(row);
}

// Full replace of the mutable fields, same convention as core/monitor/patterns.ts's
// updatePattern — the dashboard's edit form always submits the complete row, not a sparse patch.
export async function updatePortabilityModel(
  db: Db,
  id: string,
  input: { provider: "openai" | "anthropic"; label: string; pricePerMInputTokens: number; pricePerMOutputTokens: number }
): Promise<PortabilityModel | null> {
  const existing = await getPortabilityModel(db, id);
  if (!existing) {
    return null;
  }
  const setValues = { ...input, updatedAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.portabilityModels).set(setValues).where(eq(db.schema.portabilityModels.id, id));
  } else {
    await db.db.update(db.schema.portabilityModels).set(setValues).where(eq(db.schema.portabilityModels.id, id));
  }
  return { id, ...input };
}

export async function deletePortabilityModel(db: Db, id: string): Promise<boolean> {
  const existing = await getPortabilityModel(db, id);
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id));
  } else {
    await db.db.delete(db.schema.portabilityModels).where(eq(db.schema.portabilityModels.id, id));
  }
  return true;
}

export function estimateCostUSD(model: PortabilityModel | null, inputTokens: number | null, outputTokens: number | null): number | null {
  if (!model || inputTokens == null || outputTokens == null) {
    return null;
  }
  return (inputTokens / 1_000_000) * model.pricePerMInputTokens + (outputTokens / 1_000_000) * model.pricePerMOutputTokens;
}
