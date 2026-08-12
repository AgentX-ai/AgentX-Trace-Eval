import { nanoid } from "nanoid";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getTraceRow } from "../trace/ingest.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { extractText } from "../monitor/events.js";

// Tool/skill schema registry - the Prompt Registry's propose → human-approve → publish loop
// applied to tool definitions (see schema.sqlite.ts's toolSchemas comment for the full design
// rationale and the v1 "registry + suggestions only, no SDK runtime pull" scope). A bad tool
// description or under-specified parameter doc is as common a failure mode as a bad prompt in
// tool-heavy agents, but the prompt loop can't see it: this closes that gap. Neither Braintrust
// nor Langfuse automates this step (Langfuse's own skill-evaluation writeup documents doing the
// definition rewrites by hand between experiment runs).

export type ToolSchemaRow = {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ToolSchemaVersionRow = {
  id: string;
  projectId: string | null;
  toolSchemaId: string;
  version: number;
  definition: string;
  source: string;
  reasoning: string | null;
  basedOnVersion: number | null;
  createdAt: Date;
};

function toolSchemaToWire(row: ToolSchemaRow) {
  return {
    _id: row.id,
    name: row.name,
    description: row.description,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function versionToWire(row: ToolSchemaVersionRow) {
  return {
    _id: row.id,
    version: row.version,
    definition: row.definition,
    source: row.source,
    reasoning: row.reasoning,
    basedOnVersion: row.basedOnVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createToolSchema(db: Db, input: { name: string; definition: string; description?: string }) {
  const now = new Date();
  const schemaRow: ToolSchemaRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name,
    description: input.description ?? null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const versionRow: ToolSchemaVersionRow = {
    id: nanoid(),
    projectId: db.projectId,
    toolSchemaId: schemaRow.id,
    version: 1,
    definition: input.definition,
    source: "manual",
    reasoning: null,
    basedOnVersion: null,
    createdAt: now,
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.toolSchemas).values(schemaRow);
    await db.db.insert(db.schema.toolSchemaVersions).values(versionRow);
  } else {
    await db.db.insert(db.schema.toolSchemas).values(schemaRow);
    await db.db.insert(db.schema.toolSchemaVersions).values(versionRow);
  }
  return { ...toolSchemaToWire(schemaRow), version: versionRow.version, definition: versionRow.definition };
}

export async function getToolSchemaRow(db: Db, id: string): Promise<ToolSchemaRow | null> {
  const cond = and(eq(db.schema.toolSchemas.id, id), eq(db.schema.toolSchemas.projectId, db.projectId));
  const row =
    db.kind === "sqlite"
      ? (db.db.select().from(db.schema.toolSchemas).where(cond).all()[0] as ToolSchemaRow | undefined)
      : ((await db.db.select().from(db.schema.toolSchemas).where(cond))[0] as ToolSchemaRow | undefined);
  return row ?? null;
}

async function listToolSchemaVersionRows(db: Db, toolSchemaId: string): Promise<ToolSchemaVersionRow[]> {
  const cond = and(
    eq(db.schema.toolSchemaVersions.toolSchemaId, toolSchemaId),
    eq(db.schema.toolSchemaVersions.projectId, db.projectId)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.toolSchemaVersions).where(cond).all()
      : await db.db.select().from(db.schema.toolSchemaVersions).where(cond)
  ) as ToolSchemaVersionRow[];
  rows.sort((a, b) => b.version - a.version);
  return rows;
}

// One specific version's row - proposalValidation.ts needs the current published definition to
// compare a candidate against, same accessor shape as prompts.ts's getPromptVersionRow.
export async function getToolSchemaVersionRow(
  db: Db,
  toolSchemaId: string,
  version: number
): Promise<ToolSchemaVersionRow | null> {
  const rows = await listToolSchemaVersionRows(db, toolSchemaId);
  return rows.find(r => r.version === version) ?? null;
}

export async function listToolSchemasWire(db: Db) {
  const cond = eq(db.schema.toolSchemas.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.toolSchemas).where(cond).all()
      : await db.db.select().from(db.schema.toolSchemas).where(cond)
  ) as ToolSchemaRow[];
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows.map(toolSchemaToWire);
}

export async function getToolSchemaWithVersionsWire(db: Db, id: string) {
  const row = await getToolSchemaRow(db, id);
  if (!row) return null;
  const versions = await listToolSchemaVersionRows(db, id);
  return { ...toolSchemaToWire(row), versions: versions.map(versionToWire) };
}

export async function publishToolSchemaVersion(
  db: Db,
  toolSchemaId: string,
  input: { definition: string; source?: string; reasoning?: string; basedOnVersion?: number }
) {
  const schema = await getToolSchemaRow(db, toolSchemaId);
  if (!schema) return null;
  const now = new Date();
  const nextVersion = schema.currentVersion + 1;
  const versionRow: ToolSchemaVersionRow = {
    id: nanoid(),
    projectId: db.projectId,
    toolSchemaId,
    version: nextVersion,
    definition: input.definition,
    source: input.source ?? "manual",
    reasoning: input.reasoning ?? null,
    basedOnVersion: input.basedOnVersion ?? null,
    createdAt: now,
  };
  const updateCond = and(eq(db.schema.toolSchemas.id, toolSchemaId), eq(db.schema.toolSchemas.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.toolSchemaVersions).values(versionRow);
    await db.db.update(db.schema.toolSchemas).set({ currentVersion: nextVersion, updatedAt: now }).where(updateCond);
  } else {
    await db.db.insert(db.schema.toolSchemaVersions).values(versionRow);
    await db.db.update(db.schema.toolSchemas).set({ currentVersion: nextVersion, updatedAt: now }).where(updateCond);
  }
  return {
    ...toolSchemaToWire({ ...schema, currentVersion: nextVersion, updatedAt: now }),
    version: versionRow.version,
    definition: versionRow.definition,
  };
}

export async function deleteToolSchema(db: Db, id: string): Promise<boolean> {
  const existing = await getToolSchemaRow(db, id);
  if (!existing) return false;
  const versionsCond = and(
    eq(db.schema.toolSchemaVersions.toolSchemaId, id),
    eq(db.schema.toolSchemaVersions.projectId, db.projectId)
  );
  const schemaCond = and(eq(db.schema.toolSchemas.id, id), eq(db.schema.toolSchemas.projectId, db.projectId));
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.toolSchemaVersions).where(versionsCond);
    await db.db.delete(db.schema.toolSchemas).where(schemaCond);
  } else {
    await db.db.delete(db.schema.toolSchemaVersions).where(versionsCond);
    await db.db.delete(db.schema.toolSchemas).where(schemaCond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evidence gathering - real failures involving this tool, from two sources:
// (a) Monitor's built-in tool-failure detection: `agent-tool-failure:<name>` patternKey rows
//     (detect.ts embeds the failing tool's name in the key - that's the join).
// (b) Low online-evaluator ratings on traces whose toolCalls actually invoked this tool - the
//     tool "succeeded" but the judged outcome was poor, often a misuse the schema's docs invited.
// Mirrors prompts.ts's getWorstRatedExamples shape (windowed, capped, worst-first).
// ---------------------------------------------------------------------------

export type ToolFailureExample = {
  id: string;
  source: "tool-failure" | "low-rating";
  traceId: string | null;
  input: string;
  output: string;
  detail: string;
  // Null for tool-failure rows (a hard failure has no judge score) - populated for low-rating
  // rows so the dashboard's evidence card renders the same rating pill / justification block the
  // prompt-proposal evidence card does.
  rating: number | null;
  justification: string | null;
  createdAt: string;
};

const MAX_EXAMPLES = 20;
// Matches monitor_online_evaluators.alertThreshold's default - the codebase's one existing
// "below this rating is a failure" line (same constant outcomeCalibration.ts reuses).
const LOW_RATING_THRESHOLD = 5;

type EvidenceEventRow = {
  id: string;
  traceId: string | null;
  patternKey: string;
  onlineEvaluatorId: string | null;
  customEvaluatorId: string | null;
  rating: number | null;
  justification: string | null;
  createdAt: Date;
};

// The bridge from "a tool is failing in traffic" to "that tool is in the registry where the
// improvement loop can reach it": tool names observed in recent traces' tool_calls, minus the
// registered ones, each with a DRAFTED definition ready to register - verbatim from the trace's
// own metadata.tools when the SDK sent it (the same tools/toolDefinitions/tool_definitions
// convention Model Portability reads), else inferred from the arguments the model actually sent
// (parameter names + JS types), marked as inferred so nobody mistakes a guess for the real
// schema. Detection was never registry-gated (agent-tool-failure:<name> fires regardless), so
// the moment a name is registered, its accumulated failure history becomes proposal evidence.
export type UnregisteredTool = {
  name: string;
  callCount: number;
  failureCount: number;
  lastSeenAt: string;
  definitionSource: "metadata" | "inferred";
  draftDefinition: string;
};

const UNREGISTERED_SCAN_CAP = 500;

type ObservedCall = { input?: unknown; success?: unknown };

function draftFromMetadata(metadata: unknown, toolName: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of ["tools", "toolDefinitions", "tool_definitions"]) {
    const list = (metadata as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const fn =
        (entry as { type?: unknown; function?: unknown }).type === "function" &&
        typeof (entry as { function?: unknown }).function === "object"
          ? ((entry as { function: Record<string, unknown> }).function)
          : (entry as Record<string, unknown>);
      if (fn.name === toolName) {
        return JSON.stringify(fn, null, 2);
      }
    }
  }
  return null;
}

function draftFromObservedArgs(name: string, calls: ObservedCall[]): string {
  const properties: Record<string, { type: string }> = {};
  for (const call of calls) {
    let args: unknown = call.input;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (properties[key]) continue;
      const jsType = Array.isArray(value) ? "array" : value === null ? "string" : typeof value;
      properties[key] = { type: jsType === "number" && Number.isInteger(value as number) ? "integer" : jsType === "object" ? "object" : jsType === "boolean" ? "boolean" : jsType === "array" ? "array" : jsType === "number" ? "number" : "string" };
    }
  }
  return JSON.stringify(
    {
      name,
      description: "TODO: describe when the agent should call this tool (drafted from observed calls - parameter names and types were inferred, verify before relying on them)",
      parameters: { type: "object", properties },
    },
    null,
    2
  );
}

export async function listUnregisteredTools(db: Db, windowDays = 7): Promise<UnregisteredTool[]> {
  const registered = new Set((await listToolSchemasWire(db)).map(s => s.name));

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const cond = and(gte(db.schema.traces.createdAt, since), eq(db.schema.traces.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.traces).where(cond).all()
      : await db.db.select().from(db.schema.traces).where(cond)
  ) as { toolCalls: unknown; metadata: unknown; createdAt: Date }[];

  type Acc = { callCount: number; failureCount: number; lastSeenAt: Date; calls: ObservedCall[]; metadataDraft: string | null };
  const byName = new Map<string, Acc>();
  // Newest-first so the per-tool observed-call sample (and any metadata definition) reflects
  // current behavior, and capped so one busy instance doesn't turn this read into a full scan.
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const row of rows.slice(0, UNREGISTERED_SCAN_CAP)) {
    if (!Array.isArray(row.toolCalls)) continue;
    for (const raw of row.toolCalls) {
      if (!raw || typeof raw !== "object") continue;
      const call = raw as { name?: unknown } & ObservedCall;
      if (typeof call.name !== "string" || !call.name.trim() || registered.has(call.name)) continue;
      const acc = byName.get(call.name) ?? { callCount: 0, failureCount: 0, lastSeenAt: row.createdAt, calls: [], metadataDraft: null };
      acc.callCount += 1;
      if (call.success === false) acc.failureCount += 1;
      if (row.createdAt.getTime() > acc.lastSeenAt.getTime()) acc.lastSeenAt = row.createdAt;
      if (acc.calls.length < 10) acc.calls.push(call);
      if (!acc.metadataDraft) acc.metadataDraft = draftFromMetadata(row.metadata, call.name);
      byName.set(call.name, acc);
    }
  }

  return Array.from(byName.entries())
    .map(([name, acc]) => ({
      name,
      callCount: acc.callCount,
      failureCount: acc.failureCount,
      lastSeenAt: acc.lastSeenAt.toISOString(),
      definitionSource: (acc.metadataDraft ? "metadata" : "inferred") as "metadata" | "inferred",
      draftDefinition: acc.metadataDraft ?? draftFromObservedArgs(name, acc.calls),
    }))
    .sort((a, b) => b.failureCount - a.failureCount || b.callCount - a.callCount);
}

// The failed call's actual arguments and error are THE diagnostic data for "the model formed the
// call wrong because the definition under-specifies it" - a proposal judge that only sees "Tool
// call X failed" has to guess what the model sent; one that sees arguments {"q": "order #88231"}
// and the ValueError can tighten the parameter description against the exact mistake.
function buildFailureDetail(toolName: string, toolCalls: unknown): string {
  const base = `Tool call "${toolName}" failed`;
  if (!Array.isArray(toolCalls)) return base;
  const failed = toolCalls.find(
    (c): c is { name?: unknown; input?: unknown; error?: unknown; success?: unknown } =>
      !!c && typeof c === "object" && (c as { name?: unknown }).name === toolName && (c as { success?: unknown }).success === false
  );
  if (!failed) return base;
  const parts = [base];
  if (failed.input != null) {
    const args = typeof failed.input === "string" ? failed.input : JSON.stringify(failed.input);
    parts.push(`with arguments ${args.slice(0, 300)}`);
  }
  if (typeof failed.error === "string" && failed.error.trim()) {
    parts.push(`- error: ${failed.error.slice(0, 300)}`);
  }
  return parts.join(" ");
}

export async function getToolFailureExamples(db: Db, toolSchemaId: string, windowDays = 7) {
  const schema = await getToolSchemaRow(db, toolSchemaId);
  if (!schema) return null;

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const cond = and(gte(db.schema.monitorEvents.createdAt, since), eq(db.schema.monitorEvents.projectId, db.projectId));
  const events = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorEvents).where(cond).all()
      : await db.db.select().from(db.schema.monitorEvents).where(cond)
  ) as EvidenceEventRow[];

  const failureKey = `agent-tool-failure:${schema.name}`;
  const examples: ToolFailureExample[] = [];

  for (const event of events) {
    if (examples.length >= MAX_EXAMPLES * 2) break; // gather headroom before the final sort+cap
    const isToolFailure = event.patternKey === failureKey;
    const isLowRating =
      event.onlineEvaluatorId !== null && event.rating !== null && event.rating < LOW_RATING_THRESHOLD;
    if (!isToolFailure && !isLowRating) continue;
    if (!event.traceId) continue;

    const trace = await getTraceRow(db, event.traceId);
    if (!trace) continue;

    // The low-rating source only counts when this tool was actually part of the trace - a bad
    // rating on a trace that never called it says nothing about this schema.
    const calledThisTool =
      Array.isArray(trace.toolCalls) &&
      trace.toolCalls.some(t => t && typeof t === "object" && (t as { name?: unknown }).name === schema.name);
    if (isLowRating && !calledThisTool) continue;
    if (isToolFailure || calledThisTool) {
      examples.push({
        id: event.id,
        source: isToolFailure ? "tool-failure" : "low-rating",
        traceId: event.traceId,
        input: extractText(trace.input),
        output: extractText(trace.output),
        detail: isToolFailure
          ? buildFailureDetail(schema.name, trace.toolCalls)
          : `Judged ${event.rating}/10: ${event.justification ?? "no justification"}`,
        rating: isToolFailure ? null : event.rating,
        justification: isToolFailure ? null : event.justification,
        createdAt: event.createdAt.toISOString(),
      });
    }
  }

  // Tool failures first (the direct evidence), then low ratings, newest first within each.
  examples.sort((a, b) => {
    if (a.source !== b.source) return a.source === "tool-failure" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return { name: schema.name, examples: examples.slice(0, MAX_EXAMPLES) };
}

// ---------------------------------------------------------------------------
// Propose improvement - same "never writes on its own" posture as proposePromptImprovement:
// the dashboard shows the result, a human calls publishToolSchemaVersion (source: "proposed")
// to accept it.
// ---------------------------------------------------------------------------

const TOOL_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    definition: { type: "string", description: "The complete revised tool definition text" },
    reasoning: { type: "string", description: "Short overall explanation of what changed and why" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tag: { type: "string", enum: ["added", "tightened", "removed"] },
          text: { type: "string" },
        },
        required: ["tag", "text"],
      },
      description: "Itemized specific changes",
    },
  },
  required: ["definition", "reasoning", "changes"],
};

export async function proposeToolSchemaImprovement(
  db: Db,
  toolSchemaId: string,
  // exampleIds: a human-picked subset of getToolFailureExamples' ids (the proposal dialog's
  // checkboxes) - same "scope the rewrite to representative evidence" affordance
  // proposePromptImprovement already has. Omitted = use everything gathered.
  options: { windowDays?: number; exampleIds?: string[]; judgeModel?: string } = {}
) {
  const judgeModel = options.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const withVersions = await getToolSchemaWithVersionsWire(db, toolSchemaId);
  if (!withVersions) return null;
  const current = withVersions.versions.find(v => v.version === withVersions.currentVersion);
  if (!current) return null;

  const gathered = await getToolFailureExamples(db, toolSchemaId, options.windowDays);
  if (gathered && options.exampleIds && options.exampleIds.length > 0) {
    const wanted = new Set(options.exampleIds);
    gathered.examples = gathered.examples.filter(ex => wanted.has(ex.id));
  }
  if (!gathered || gathered.examples.length === 0) {
    return { proposal: null, exampleCount: 0, message: "No failure evidence found for this tool in the window" };
  }

  const evidence = gathered.examples
    .map(
      (ex, i) =>
        `Example ${i + 1} (${ex.source}): ${ex.detail}\n  User input: ${ex.input.slice(0, 800)}\n  Agent output: ${ex.output.slice(0, 800)}`
    )
    .join("\n\n");

  const userMessage = `You are improving the definition of an AI agent's tool named "${withVersions.name}". The definition below is what the agent's LLM reads to decide when and how to call the tool - an unclear description, a missing constraint, or an under-specified parameter doc directly causes wrong or failed calls.

Current definition (v${withVersions.currentVersion}):
${current.definition}

Real production failures involving this tool:

${evidence}

Rewrite the definition to prevent these failures. Where an example shows the arguments the model actually sent, compare them against the parameter schema: if the model keeps sending values the tool rejects (wrong format, free text where an id belongs, a missing field), fix the PARAMETERS themselves - rename or split parameters, add "required", add a type/enum/pattern constraint, and state the exact expected format in the parameter's description with an example value - rather than only expanding the top-level description. A failure that looks transient (timeout, upstream outage) is NOT evidence of a definition problem; do not invent constraints the failures don't support. Keep the same underlying capability and format (if it's JSON, return valid JSON; if prose, return prose). Return the complete revised definition (not a diff), a short overall reasoning, and an itemized change list, each tagged "added", "tightened", or "removed".`;

  const result = await callJudgeJson({ model: judgeModel, jsonSchema: TOOL_PROPOSAL_SCHEMA, userMessage, maxTokens: 4000 });
  const payload = result.payload as { definition?: unknown; reasoning?: unknown; changes?: unknown } | null;
  if (!payload || typeof payload.definition !== "string") {
    throw new Error("The judge did not return a usable proposal");
  }
  return {
    proposal: {
      definition: payload.definition,
      reasoning: typeof payload.reasoning === "string" ? payload.reasoning : "",
      changes: Array.isArray(payload.changes) ? payload.changes : [],
      basedOnVersion: withVersions.currentVersion,
      judgeModel,
    },
    exampleCount: gathered.examples.length,
  };
}
