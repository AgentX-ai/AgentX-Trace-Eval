import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../storage/db.js";

// Interactive Playground's own run history - a persistence layer that sits next to, not inside,
// playground.ts's runPlayground (still pure "compute and return", untouched by this file). Lets
// the frontend survive a refresh and browse past runs, without turning a single model call into a
// persisted resource itself. `snapshot`/`results` are opaque JSON as far as this file is
// concerned - shaped by the frontend (PlaygroundTab.tsx's RunSnapshot/CellState), just stored and
// returned verbatim, same posture core/monitor/patterns.ts's `conditions: unknown` column has.

export type PlaygroundRunRow = {
  id: string;
  kind: string | null;
  projectId: string | null;
  // Which prompt (prompts.id) this session was testing, when started from the prompt registry -
  // lets gatherPlaygroundExamples (prompts.ts) find every run that reviewed a given prompt. Null
  // for a promptless session.
  promptId: string | null;
  snapshot: unknown;
  results: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type PlaygroundRunSummary = {
  _id: string;
  kind: "grid" | "simulation";
  createdAt: Date;
  modelCount: number;
  caseCount: number;
  doneCount: number;
  // Simulation rows only - what the History list shows for them (goal + outcome + turn count).
  goal?: string;
  outcome?: string;
  turnCount?: number;
};

function toSummary(row: PlaygroundRunRow): PlaygroundRunSummary {
  const snapshot = row.snapshot as { models?: unknown[]; questions?: unknown[]; goal?: unknown } | null;
  const resultCells = Object.values(row.results ?? {});
  const simulation = (row.results as { simulation?: { outcome?: unknown; turns?: unknown[] } } | null)?.simulation;
  return {
    _id: row.id,
    kind: row.kind === "simulation" ? "simulation" : "grid",
    createdAt: row.createdAt,
    modelCount: snapshot?.models?.length ?? 0,
    caseCount: snapshot?.questions?.length ?? 0,
    doneCount: resultCells.filter(cell => (cell as { status?: string })?.status === "done").length,
    goal: typeof snapshot?.goal === "string" ? snapshot.goal : undefined,
    outcome: typeof simulation?.outcome === "string" ? simulation.outcome : undefined,
    turnCount: Array.isArray(simulation?.turns) ? simulation.turns.length : undefined,
  };
}

export async function createPlaygroundRun(
  db: Db,
  snapshot: unknown,
  promptId?: string | null,
  kind: "grid" | "simulation" = "grid",
  results: unknown = {}
): Promise<{ id: string; createdAt: Date }> {
  const now = new Date();
  const row = {
    id: nanoid(),
    projectId: db.projectId,
    promptId: promptId ?? null,
    kind,
    snapshot,
    results,
    createdAt: now,
    updatedAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.playgroundRuns).values(row);
  } else {
    await db.db.insert(db.schema.playgroundRuns).values(row);
  }
  // Keep this a bounded scratch log, not an unbounded persisted resource - same "prune on write"
  // shape as core/monitor/events.ts's pruneOldEvents, count-capped instead of time-capped since
  // there's no natural per-agent partition for Playground runs.
  await prunePlaygroundRuns(db, 50);
  return { id: row.id, createdAt: now };
}

// A run that's already been pruned out from under an in-progress grid (rare - only possible if
// someone runs 50+ grids without ever reloading the page in one sitting) no-ops rather than
// throwing: the in-flight run just stops persisting further, it never breaks the UI mid-run.
export async function updatePlaygroundRunResults(db: Db, id: string, results: unknown): Promise<void> {
  const row = { results, updatedAt: new Date() };
  const cond = and(eq(db.schema.playgroundRuns.id, id), eq(db.schema.playgroundRuns.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.playgroundRuns).set(row).where(cond);
  } else {
    await db.db.update(db.schema.playgroundRuns).set(row).where(cond);
  }
}

// Every playground_runs row that reviewed a given prompt - the read side of gatherPlaygroundExamples
// (core/evaluate/prompts.ts), which scans each row's opaque `results` JSON for human-reviewed
// cells. Full rows, not summaries, since the caller needs `results` itself, not just its counts.
export async function listPlaygroundRunsByPrompt(db: Db, promptId: string): Promise<PlaygroundRunRow[]> {
  const cond = and(eq(db.schema.playgroundRuns.promptId, promptId), eq(db.schema.playgroundRuns.projectId, db.projectId));
  return (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.playgroundRuns).where(cond).all()
      : await db.db.select().from(db.schema.playgroundRuns).where(cond)
  ) as PlaygroundRunRow[];
}

// Full rows across ALL runs - the read side of tool-schema evidence gathering
// (core/evaluate/toolSchemas.ts's getToolFailureExamples), which scans each row's `results` JSON
// for failed tool calls; unlike listPlaygroundRunsByPrompt's caller, that isn't prompt-scoped.
export async function listPlaygroundRunRows(db: Db): Promise<PlaygroundRunRow[]> {
  const cond = eq(db.schema.playgroundRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.playgroundRuns).where(cond).all()
      : await db.db.select().from(db.schema.playgroundRuns).where(cond)
  ) as PlaygroundRunRow[];
  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function listPlaygroundRuns(db: Db): Promise<PlaygroundRunSummary[]> {
  const cond = eq(db.schema.playgroundRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.playgroundRuns).where(cond).all()
      : await db.db.select().from(db.schema.playgroundRuns).where(cond)
  ) as PlaygroundRunRow[];
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toSummary);
}

export async function getPlaygroundRun(db: Db, id: string): Promise<{ snapshot: unknown; results: unknown } | null> {
  const cond = and(eq(db.schema.playgroundRuns.id, id), eq(db.schema.playgroundRuns.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.playgroundRuns).where(cond).all()
      : await db.db.select().from(db.schema.playgroundRuns).where(cond)
  ) as PlaygroundRunRow[];
  const row = rows[0];
  return row ? { snapshot: row.snapshot, results: row.results } : null;
}

export async function deletePlaygroundRun(db: Db, id: string): Promise<boolean> {
  const cond = and(eq(db.schema.playgroundRuns.id, id), eq(db.schema.playgroundRuns.projectId, db.projectId));
  const existing =
    db.kind === "sqlite"
      ? db.db.select({ id: db.schema.playgroundRuns.id }).from(db.schema.playgroundRuns).where(cond).all()[0]
      : (await db.db.select({ id: db.schema.playgroundRuns.id }).from(db.schema.playgroundRuns).where(cond))[0];
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.playgroundRuns).where(cond);
  } else {
    await db.db.delete(db.schema.playgroundRuns).where(cond);
  }
  return true;
}

export async function prunePlaygroundRuns(db: Db, keep: number): Promise<void> {
  const listCond = eq(db.schema.playgroundRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select({ id: db.schema.playgroundRuns.id, createdAt: db.schema.playgroundRuns.createdAt })
          .from(db.schema.playgroundRuns)
          .where(listCond)
          .all()
      : await db.db
          .select({ id: db.schema.playgroundRuns.id, createdAt: db.schema.playgroundRuns.createdAt })
          .from(db.schema.playgroundRuns)
          .where(listCond)
  ) as { id: string; createdAt: Date }[];
  const staleIds = rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(keep)
    .map(r => r.id);
  if (staleIds.length === 0) {
    return;
  }
  const cond = and(inArray(db.schema.playgroundRuns.id, staleIds), eq(db.schema.playgroundRuns.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.playgroundRuns).where(cond);
  } else {
    await db.db.delete(db.schema.playgroundRuns).where(cond);
  }
}
