import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";

// A saved Playground workbench. What someone has open in the Playground is a whole setup - system
// messages, tool and MCP rows, which models are in the grid, which scorers grade it, and what it
// runs against - and until now none of it survived a reload except the prompt text, via "Save as
// prompt". The tools someone had just wired up were the most expensive part to lose.
//
// The workbench is stored as one JSON blob, the same posture playground_runs takes with its
// snapshot: the Playground gains fields regularly and the engine has no reason to model each one.
// The route validates the shape; this module owns the one rule the engine will not delegate to a
// client - an MCP OAuth session handle never reaches the database.

export type ProfileMessage = { role: string; content: string };

export type ProfileTool = {
  name: string;
  description?: string;
  parametersText?: string;
  endpointUrl?: string;
  mcpServer?: string;
};

export type PlaygroundProfileConfig = {
  messages: ProfileMessage[];
  tools: ProfileTool[];
  models: { ids: string[]; settings?: Record<string, { maxTokens?: string; temperature?: string }> };
  scorers: {
    evaluationSettingsId?: string | null;
    patternIds: string[];
    onlineEvaluatorIds: string[];
  };
  testInput: {
    mode: "dataset" | "query";
    datasetId?: string | null;
    questionIndexes: number[];
    query?: string;
  };
};

type Row = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  promptId: string | null;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

// An mcpSessionId is a short-lived server-side OAuth handle for one person's connection to an MCP
// server (see routes/mcp.ts). Persisting it would put a live credential into a row that is listed,
// exported and restorable - so it is stripped here rather than trusted to never be sent. Loading a
// profile re-adds the tool row unauthenticated and the person reconnects, which is the correct
// outcome: the session belongs to whoever is sitting there now.
export function stripSessionHandles(tools: ProfileTool[]): ProfileTool[] {
  return tools.map(tool => {
    const { ...rest } = tool as ProfileTool & { mcpSessionId?: string };
    delete (rest as { mcpSessionId?: string }).mcpSessionId;
    return rest;
  });
}

function toWire(row: Row) {
  const config = (row.config as PlaygroundProfileConfig | null) ?? {
    messages: [],
    tools: [],
    models: { ids: [] },
    scorers: { patternIds: [], onlineEvaluatorIds: [] },
    testInput: { mode: "dataset" as const, questionIndexes: [] },
  };
  return {
    _id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    promptId: row.promptId,
    config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type PlaygroundProfileWire = ReturnType<typeof toWire>;

async function rows(db: Db): Promise<Row[]> {
  const cond = eq(db.schema.playgroundProfiles.projectId, db.projectId);
  if (db.kind === "sqlite") {
    return db.db
      .select()
      .from(db.schema.playgroundProfiles)
      .where(cond)
      .orderBy(desc(db.schema.playgroundProfiles.updatedAt))
      .all() as Row[];
  }
  return (await db.db
    .select()
    .from(db.schema.playgroundProfiles)
    .where(cond)
    .orderBy(desc(db.schema.playgroundProfiles.updatedAt))) as Row[];
}

async function row(db: Db, id: string): Promise<Row | undefined> {
  const cond = and(
    eq(db.schema.playgroundProfiles.id, id),
    eq(db.schema.playgroundProfiles.projectId, db.projectId)
  );
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.playgroundProfiles).where(cond).all()[0] as Row | undefined;
  }
  return (await db.db.select().from(db.schema.playgroundProfiles).where(cond))[0] as Row | undefined;
}

export async function listPlaygroundProfiles(db: Db): Promise<PlaygroundProfileWire[]> {
  return (await rows(db)).map(toWire);
}

export async function getPlaygroundProfile(db: Db, id: string): Promise<PlaygroundProfileWire | null> {
  const found = await row(db, id);
  return found ? toWire(found) : null;
}

export type SaveProfileInput = {
  name: string;
  description?: string;
  promptId?: string | null;
  config: PlaygroundProfileConfig;
};

export async function createPlaygroundProfile(db: Db, input: SaveProfileInput): Promise<PlaygroundProfileWire> {
  const now = new Date();
  const record: Row = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    promptId: input.promptId ?? null,
    config: { ...input.config, tools: stripSessionHandles(input.config.tools) },
    createdAt: now,
    updatedAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.playgroundProfiles).values(record);
  } else {
    await db.db.insert(db.schema.playgroundProfiles).values(record);
  }
  return toWire(record);
}

export async function updatePlaygroundProfile(
  db: Db,
  id: string,
  patch: Partial<SaveProfileInput>
): Promise<PlaygroundProfileWire | null> {
  const existing = await row(db, id);
  if (!existing) return null;
  const updated: Row = {
    ...existing,
    name: patch.name?.trim() ?? existing.name,
    description: patch.description !== undefined ? patch.description.trim() || null : existing.description,
    promptId: patch.promptId !== undefined ? patch.promptId : existing.promptId,
    config: patch.config ? { ...patch.config, tools: stripSessionHandles(patch.config.tools) } : existing.config,
    updatedAt: new Date(),
  };
  const cond = eq(db.schema.playgroundProfiles.id, id);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.playgroundProfiles).set(updated).where(cond);
  } else {
    await db.db.update(db.schema.playgroundProfiles).set(updated).where(cond);
  }
  return toWire(updated);
}

export async function deletePlaygroundProfile(db: Db, id: string): Promise<boolean> {
  const existing = await row(db, id);
  if (!existing) return false;
  const cond = eq(db.schema.playgroundProfiles.id, id);
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.playgroundProfiles).where(cond);
  } else {
    await db.db.delete(db.schema.playgroundProfiles).where(cond);
  }
  return true;
}
