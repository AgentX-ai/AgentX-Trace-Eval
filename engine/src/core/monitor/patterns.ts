import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import type { PatternCondition } from "./conditions.js";

// Built-in checks (empty response, trace error, tool failure, latency regression) aren't rows,
// they're evaluated in code, see core/monitor/detect.ts. This module is custom, user-defined
// patterns only, mirroring AgentX-web-api's AgentMonitoringPattern model (source: "custom" rows;
// source: "builtIn" rows there come from the same static list core/monitor/detect.ts uses here).
export type CreatePatternInput = {
  name: string;
  description?: string;
  category?: string;
  detectorKind?: string;
  conditions: PatternCondition[];
  severity?: string;
  polarity?: string;
  enabled?: boolean;
  // Routing/throttling, not detection — see PatternRow.sampleRate's comment below.
  sampleRate?: number;
  scopeMode?: string;
  agentIds?: string[];
};

// AgentX-Python's MonitorPatternBuilder (agentx/monitor/patterns.py) doesn't send a `conditions`
// array at all, only the legacy single-detector fields (detectorKind/matchTarget/matchMode/
// includeTerms/excludeTerms/regex/semanticPrompt) that predate the dashboard's multi-condition
// builder. The hosted SaaS keeps two parallel detection engines to support both shapes
// (evaluatePatternConditions for conditions, matchesCustomPattern/evaluateSemanticPattern for
// legacy fields); self-host instead normalizes legacy fields into one equivalent conditions list
// at creation time, so there's only ever one detection engine to run (core/monitor/conditions.ts).
export function legacyPayloadToConditions(body: Record<string, unknown>): PatternCondition[] {
  if (Array.isArray(body.conditions) && body.conditions.length > 0) {
    return body.conditions as PatternCondition[];
  }

  const detectorKind = typeof body.detectorKind === "string" ? body.detectorKind : "contains";
  const matchTarget: PatternCondition["sources"] =
    Array.isArray(body.matchTarget) && body.matchTarget.length ? (body.matchTarget as PatternCondition["sources"]) : ["response"];
  const matchMode = body.matchMode === "all" ? "and" : "or";
  const includeTerms = Array.isArray(body.includeTerms) ? (body.includeTerms as string[]).filter(t => typeof t === "string" && t.trim()) : [];
  const excludeTerms = Array.isArray(body.excludeTerms) ? (body.excludeTerms as string[]).filter(t => typeof t === "string" && t.trim()) : [];

  const conditions: PatternCondition[] = [];

  if (detectorKind === "regex" && typeof body.regex === "string" && body.regex.trim()) {
    conditions.push({ connector: "and", negate: false, sources: matchTarget, detector: "regex", value: body.regex.trim(), caseSensitive: false });
  } else if (detectorKind === "semantic" && typeof body.semanticPrompt === "string" && body.semanticPrompt.trim()) {
    conditions.push({ connector: "and", negate: false, sources: matchTarget, detector: "semantic", value: body.semanticPrompt.trim(), caseSensitive: false });
  } else {
    includeTerms.forEach((term, i) => {
      conditions.push({ connector: i === 0 ? "and" : matchMode, negate: false, sources: matchTarget, detector: "phrase", value: term, caseSensitive: false });
    });
  }

  excludeTerms.forEach(term => {
    conditions.push({ connector: "and", negate: true, sources: matchTarget, detector: "phrase", value: term, caseSensitive: false });
  });

  return conditions;
}

export type PatternRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  detectorKind: string;
  conditions: unknown;
  severity: string;
  polarity: string;
  enabled: boolean;
  // Not read by core/monitor/detect.ts's detectCustomPatterns (which still runs every enabled
  // pattern, unscoped/unsampled, against every trace) — persisted only so the dashboard's pattern
  // editor round-trips these fields on edit instead of silently losing them. Enforcing them is a
  // disclosed follow-up.
  sampleRate: number;
  scopeMode: string;
  agentIds: unknown;
  createdAt: Date;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Matches AgentX-web-front's AgentMonitoringPattern type (src/types/agentMonitoring.ts).
// matchTarget/matchMode/includeTerms/excludeTerms are the pre-multi-condition-builder legacy
// fields that type still declares as required: self-host only ever writes `conditions` (see
// legacyPayloadToConditions above), so these are derived/defaulted for display rather than
// independently meaningful, the real match logic is entirely in `conditions`.
function toWire(row: PatternRow) {
  const conditions = (row.conditions as PatternCondition[]) ?? [];
  const matchTarget = conditions.length ? Array.from(new Set(conditions.flatMap(c => c.sources))) : ["response"];
  return {
    _id: row.id,
    workspaceId: "local",
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    source: "custom" as const,
    detectorKind: row.detectorKind,
    matchTarget,
    matchMode: "any" as const,
    includeTerms: [] as string[],
    excludeTerms: [] as string[],
    conditions: row.conditions,
    severity: row.severity,
    polarity: row.polarity,
    enabled: row.enabled,
    sampleRate: row.sampleRate,
    scopeMode: row.scopeMode,
    agentIds: (row.agentIds as string[] | null) ?? [],
    readOnly: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.createdAt.toISOString(),
  };
}

export async function createPattern(db: Db, input: CreatePatternInput) {
  const row: PatternRow = {
    id: nanoid(),
    key: `custom:${slugify(input.name) || nanoid(6)}`,
    name: input.name,
    description: input.description ?? null,
    category: input.category ?? null,
    detectorKind: input.detectorKind ?? "contains",
    conditions: input.conditions,
    severity: input.severity ?? "medium",
    polarity: input.polarity ?? "failure",
    enabled: input.enabled ?? true,
    sampleRate: input.sampleRate ?? 1,
    scopeMode: input.scopeMode ?? "all",
    agentIds: input.agentIds ?? null,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorPatterns).values(row);
  } else {
    await db.db.insert(db.schema.monitorPatterns).values(row);
  }
  return toWire(row);
}

export type UpdatePatternInput = Partial<CreatePatternInput>;

// Full replace of the mutable fields (not a deep-merge like updateProfile): the dashboard's
// pattern editor always submits the complete form, not a sparse patch, so there's no ambiguity
// to resolve between "field omitted" and "field explicitly cleared" the way there is for
// updateProfile's thresholdOverrides/approvalPolicy merges.
export async function updatePattern(db: Db, id: string, input: UpdatePatternInput): Promise<ReturnType<typeof toWire> | null> {
  const existing = await getPatternRow(db, id);
  if (!existing) {
    return null;
  }
  const updated: PatternRow = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? (input.description ?? null) : existing.description,
    category: input.category !== undefined ? (input.category ?? null) : existing.category,
    detectorKind: input.detectorKind ?? existing.detectorKind,
    conditions: input.conditions ?? existing.conditions,
    severity: input.severity ?? existing.severity,
    polarity: input.polarity ?? existing.polarity,
    enabled: input.enabled ?? existing.enabled,
    sampleRate: input.sampleRate ?? existing.sampleRate,
    scopeMode: input.scopeMode ?? existing.scopeMode,
    agentIds: input.agentIds !== undefined ? input.agentIds : existing.agentIds,
  };
  const setValues = {
    name: updated.name,
    description: updated.description,
    category: updated.category,
    detectorKind: updated.detectorKind,
    conditions: updated.conditions,
    severity: updated.severity,
    polarity: updated.polarity,
    enabled: updated.enabled,
    sampleRate: updated.sampleRate,
    scopeMode: updated.scopeMode,
    agentIds: updated.agentIds,
  };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorPatterns).set(setValues).where(eq(db.schema.monitorPatterns.id, id));
  } else {
    await db.db.update(db.schema.monitorPatterns).set(setValues).where(eq(db.schema.monitorPatterns.id, id));
  }
  return toWire(updated);
}

// Hard delete: AgentMonitoringPattern (src/types/agentMonitoring.ts) has no archived/status field
// for the dashboard to filter on, and there's no "archived patterns" view anywhere in the
// frontend to power — see the investigation this was scoped from. The frontend mutation is named
// "archive" and its success toast says "Pattern archived", but nothing in its actual request/
// response contract distinguishes a soft archive from a hard delete, so this does the simpler,
// unambiguous thing. Revisit if an archived-patterns view is ever built.
export async function deletePattern(db: Db, id: string): Promise<boolean> {
  const existing = await getPatternRow(db, id);
  if (!existing) {
    return false;
  }
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.monitorPatterns).where(eq(db.schema.monitorPatterns.id, id));
  } else {
    await db.db.delete(db.schema.monitorPatterns).where(eq(db.schema.monitorPatterns.id, id));
  }
  return true;
}

export async function getPattern(db: Db, id: string) {
  const row = await getPatternRow(db, id);
  return row ? toWire(row) : null;
}

export async function getPatternRow(db: Db, id: string): Promise<PatternRow | null> {
  let row: PatternRow | undefined;
  if (db.kind === "sqlite") {
    row = db.db.select().from(db.schema.monitorPatterns).where(eq(db.schema.monitorPatterns.id, id)).all()[0] as
      | PatternRow
      | undefined;
  } else {
    row = (await db.db.select().from(db.schema.monitorPatterns).where(eq(db.schema.monitorPatterns.id, id)))[0] as
      | PatternRow
      | undefined;
  }
  return row ?? null;
}

export async function listCustomPatterns(db: Db): Promise<PatternRow[]> {
  const rows =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorPatterns).all()
      : await db.db.select().from(db.schema.monitorPatterns);
  return rows as PatternRow[];
}

export async function listPatternsWire(db: Db) {
  return (await listCustomPatterns(db)).map(toWire);
}
