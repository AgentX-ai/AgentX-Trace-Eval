import { and, desc, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { logger } from "../../log.js";
import { matchesAgentScope, passesSampleRate } from "./routing.js";
import { queueTraceForReview } from "./reviewQueue.js";
import { postWebhooks } from "./webhooks.js";
import { addCaseToDataset, previewCaseFromTrace } from "../evaluate/curation.js";

// Automation rules: filter + sample + action, evaluated once per ingested root trace.
//
// The boundary that keeps this from duplicating scorers: a SCORER scores traffic and owns its own
// sampling (what a judge costs is a scorer question); a RULE routes traffic - into the human
// review queue, into a dataset, or out to a webhook - and never scores anything. Enabling a rule
// therefore cannot change a judge's spend or its verdicts.
//
// Deliberately NOT a filter expression language: four typed fields cover the cases people
// actually ask for, and a rule whose filter cannot match anything is visibly wrong in the UI
// instead of silently parsing to "match nothing".

export type RuleAction = "review" | "dataset" | "webhook";

export type RuleFilter = {
  scopeMode?: "all" | "selected";
  agentIds?: string[];
  model?: string;
  // "error" narrows to traces that recorded an error; "any" (default) matches either.
  status?: "any" | "error";
  contains?: string;
};

export type RuleActionConfig = { datasetId?: string; url?: string };

type RuleRow = {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  filter: unknown;
  sampleRate: number;
  action: string;
  actionConfig: unknown;
  firedCount: number;
  lastFiredAt: Date | null;
  createdAt: Date;
};

export type RuleTrace = {
  input?: unknown;
  output?: unknown;
  error?: string | null;
  model?: string | null;
  name?: string | null;
};

function toWire(row: RuleRow) {
  return {
    _id: row.id,
    name: row.name,
    enabled: row.enabled,
    filter: (row.filter as RuleFilter | null) ?? {},
    sampleRate: row.sampleRate,
    action: row.action as RuleAction,
    actionConfig: (row.actionConfig as RuleActionConfig | null) ?? {},
    firedCount: row.firedCount,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type RuleWire = ReturnType<typeof toWire>;

async function listRows(db: Db): Promise<RuleRow[]> {
  const cond = or(eq(db.schema.monitorRules.projectId, db.projectId), isNull(db.schema.monitorRules.projectId));
  if (db.kind === "sqlite") {
    return db.db
      .select()
      .from(db.schema.monitorRules)
      .where(cond)
      .orderBy(desc(db.schema.monitorRules.createdAt))
      .all() as RuleRow[];
  }
  return (await db.db
    .select()
    .from(db.schema.monitorRules)
    .where(cond)
    .orderBy(desc(db.schema.monitorRules.createdAt))) as RuleRow[];
}

async function getRow(db: Db, id: string): Promise<RuleRow | undefined> {
  const cond = and(
    eq(db.schema.monitorRules.id, id),
    or(eq(db.schema.monitorRules.projectId, db.projectId), isNull(db.schema.monitorRules.projectId))
  );
  if (db.kind === "sqlite") {
    return db.db.select().from(db.schema.monitorRules).where(cond).all()[0] as RuleRow | undefined;
  }
  return (await db.db.select().from(db.schema.monitorRules).where(cond))[0] as RuleRow | undefined;
}

export async function listRules(db: Db): Promise<RuleWire[]> {
  return (await listRows(db)).map(toWire);
}

export async function getRule(db: Db, id: string): Promise<RuleWire | null> {
  const row = await getRow(db, id);
  return row ? toWire(row) : null;
}

export type CreateRuleInput = {
  name: string;
  enabled?: boolean;
  filter?: RuleFilter;
  sampleRate?: number;
  action: RuleAction;
  actionConfig?: RuleActionConfig;
};

export async function createRule(db: Db, input: CreateRuleInput): Promise<RuleWire> {
  const row: RuleRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    filter: input.filter ?? {},
    // Routing is cheap (no LLM call), so unlike a judge scorer the honest default is everything
    // that matches the filter; the operator dials it down when the queue fills up.
    sampleRate: input.sampleRate ?? 1,
    action: input.action,
    actionConfig: input.actionConfig ?? {},
    firedCount: 0,
    lastFiredAt: null,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorRules).values(row);
  } else {
    await db.db.insert(db.schema.monitorRules).values(row);
  }
  return toWire(row);
}

export type UpdateRuleInput = Partial<CreateRuleInput>;

export async function updateRule(db: Db, id: string, patch: UpdateRuleInput): Promise<RuleWire | null> {
  const existing = await getRow(db, id);
  if (!existing) return null;
  const updated: RuleRow = {
    ...existing,
    name: patch.name?.trim() ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    filter: patch.filter ?? existing.filter,
    sampleRate: patch.sampleRate ?? existing.sampleRate,
    action: patch.action ?? existing.action,
    actionConfig: patch.actionConfig ?? existing.actionConfig,
  };
  const cond = eq(db.schema.monitorRules.id, id);
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorRules).set(updated).where(cond);
  } else {
    await db.db.update(db.schema.monitorRules).set(updated).where(cond);
  }
  return toWire(updated);
}

export async function deleteRule(db: Db, id: string): Promise<boolean> {
  const existing = await getRow(db, id);
  if (!existing) return false;
  const cond = eq(db.schema.monitorRules.id, id);
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.monitorRules).where(cond);
  } else {
    await db.db.delete(db.schema.monitorRules).where(cond);
  }
  return true;
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

// Exported for the rule editor's "would this match?" affordance and for tests: filter evaluation
// has to be one function, or the preview and the live path drift.
export function ruleMatches(filter: RuleFilter, trace: RuleTrace, agentId: string | null): boolean {
  if (!matchesAgentScope({ scopeMode: filter.scopeMode ?? "all", agentIds: filter.agentIds ?? [] }, agentId)) {
    return false;
  }
  if (filter.model && (trace.model ?? "") !== filter.model) return false;
  if (filter.status === "error" && !trace.error) return false;
  const contains = filter.contains?.trim().toLowerCase();
  if (contains) {
    const haystack = `${asText(trace.input)} ${asText(trace.output)}`.toLowerCase();
    if (!haystack.includes(contains)) return false;
  }
  return true;
}

async function recordFired(db: Db, row: RuleRow): Promise<void> {
  const cond = eq(db.schema.monitorRules.id, row.id);
  const patch = { firedCount: row.firedCount + 1, lastFiredAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.monitorRules).set(patch).where(cond);
  } else {
    await db.db.update(db.schema.monitorRules).set(patch).where(cond);
  }
}

async function runAction(db: Db, row: RuleRow, traceId: string): Promise<boolean> {
  const config = (row.actionConfig as RuleActionConfig | null) ?? {};
  switch (row.action) {
    case "review": {
      const result = await queueTraceForReview(db, { traceId, source: "rule", note: `Sampled by rule "${row.name}"` });
      if (!result.ok) {
        // Not an error worth alarming about: a full queue or a trace already waiting is the
        // system working as designed. Logged at debug-ish level so a flood is diagnosable.
        logger.info({ rule: row.name, reason: result.reason }, "Rule did not queue a trace for review");
        return false;
      }
      return true;
    }
    case "dataset": {
      if (!config.datasetId) {
        logger.warn({ rule: row.name }, "Rule has action 'dataset' but no datasetId - skipping");
        return false;
      }
      const preview = await previewCaseFromTrace(db, traceId);
      if (!preview) return false;
      // Expected results stay empty on purpose: the trace's own answer is what happened, not
      // necessarily what SHOULD happen, so the case lands under the Dataset Editor's "Needs
      // work" filter for a human to complete rather than pretending it is a golden answer.
      const added = await addCaseToDataset(db, config.datasetId, preview.case);
      if (!added.ok) {
        // A duplicate is the dedupe working, not a failure - both are reported, neither throws.
        const reason = "duplicate" in added ? "duplicate" : added.error;
        logger.info({ rule: row.name, reason }, "Rule did not add a case to the dataset");
        return false;
      }
      return true;
    }
    case "webhook": {
      if (!config.url) {
        logger.warn({ rule: row.name }, "Rule has action 'webhook' but no url - skipping");
        return false;
      }
      postWebhooks([config.url], {
        text: `[AgentX Rule] ${row.name} matched a trace`,
        rule: row.name,
        ruleId: row.id,
        traceId,
      });
      return true;
    }
    default:
      logger.warn({ rule: row.name, action: row.action }, "Rule has an unknown action - skipping");
      return false;
  }
}

// Fire-and-forget from routes/ingest.ts, same posture as runMonitorCheck: never blocks or fails
// an ingest, every action isolated so one broken rule cannot stop the others.
export async function runRules(
  db: Db,
  trace: RuleTrace,
  ctx: { agentId: string | null; traceId: string | null }
): Promise<void> {
  if (!ctx.traceId) return;
  const rules = await listRows(db);
  for (const row of rules) {
    if (!row.enabled) continue;
    const filter = (row.filter as RuleFilter | null) ?? {};
    if (!ruleMatches(filter, trace, ctx.agentId)) continue;
    if (!passesSampleRate(row.sampleRate)) continue;
    try {
      const fired = await runAction(db, row, ctx.traceId);
      if (fired) await recordFired(db, row);
    } catch (err) {
      logger.error({ err, rule: row.name }, "Rule action failed");
    }
  }
}
