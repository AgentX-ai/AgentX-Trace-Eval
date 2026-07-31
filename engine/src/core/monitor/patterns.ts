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
    sampleRate: 1,
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
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorPatterns).values(row);
  } else {
    await db.db.insert(db.schema.monitorPatterns).values(row);
  }
  return toWire(row);
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
