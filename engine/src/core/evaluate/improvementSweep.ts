import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../storage/db.js";
import { getDb, withProjectId } from "../../storage/db.js";
import { runWithTenancy } from "../../auth/requestContext.js";
import { listProjectRows } from "../project/projects.js";
import {
  listPromptRows,
  getPromptVersionRow,
  getWorstRatedExamples,
  proposePromptImprovement,
  publishPromptVersion,
} from "./prompts.js";
import {
  listToolSchemasWire,
  getToolSchemaVersionRow,
  getToolFailureExamples,
  proposeToolSchemaImprovement,
  publishToolSchemaVersion,
} from "./toolSchemas.js";
import { validatePromptProposal, validateToolSchemaProposal } from "./proposalValidation.js";
import { acquireSweepLease } from "../shared/sweepLease.js";
import { logger } from "../../log.js";

// The Improvement Inbox's producer: a background sweep that notices when a registered prompt or
// tool schema has accumulated enough fresh failure evidence, then does the expensive thinking on
// its own - generates the judge proposal AND runs the baseline-vs-candidate validation - and
// queues the result for a human. The human's job collapses to reading a measured verdict and
// clicking publish; nothing here ever publishes itself.
//
// Spend controls, since every proposal is a judge call and every validation is a batch of model
// calls: at most MAX_NEW_PROPOSALS_PER_SWEEP per cycle, a 24h per-target cooldown (a dismissed
// proposal means "stop nagging", not "try again in ten minutes"), never while one is already
// pending for the same target, and validation capped at VALIDATION_MAX_CASES cases.
// AGENTX_IMPROVEMENT_SWEEP=false disables entirely; POST /evaluate/improve/inbox/sweep/run
// triggers one manually (the demo/test path).

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TARGET_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_NEW_PROPOSALS_PER_SWEEP = 2;
const EVIDENCE_THRESHOLD = 3;
const LOW_RATING = 5;
const VALIDATION_MAX_CASES = 6;

export type ImprovementProposalRow = {
  id: string;
  kind: string;
  targetId: string;
  targetName: string;
  status: string;
  triggerReason: string;
  currentText: string;
  proposal: unknown;
  validation: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  projectId: string | null;
};

function toWire(row: ImprovementProposalRow) {
  return {
    _id: row.id,
    kind: row.kind as "prompt" | "tool-schema",
    targetId: row.targetId,
    targetName: row.targetName,
    status: row.status as "pending" | "published" | "dismissed",
    triggerReason: row.triggerReason,
    currentText: row.currentText,
    proposal: row.proposal,
    validation: row.validation,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function listImprovementProposals(db: Db) {
  const cond = eq(db.schema.improvementProposals.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementProposals).where(cond).all()
      : await db.db.select().from(db.schema.improvementProposals).where(cond)
  ) as ImprovementProposalRow[];
  // Pending first (the actual inbox), then resolved history newest-first.
  rows.sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    return aPending - bPending || b.createdAt.getTime() - a.createdAt.getTime();
  });
  return rows.map(toWire);
}

async function getProposalRow(db: Db, id: string): Promise<ImprovementProposalRow | null> {
  const cond = and(eq(db.schema.improvementProposals.id, id), eq(db.schema.improvementProposals.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementProposals).where(cond).all()
      : await db.db.select().from(db.schema.improvementProposals).where(cond)
  ) as ImprovementProposalRow[];
  return rows[0] ?? null;
}

async function setStatus(db: Db, id: string, status: "published" | "dismissed"): Promise<void> {
  const cond = and(eq(db.schema.improvementProposals.id, id), eq(db.schema.improvementProposals.projectId, db.projectId));
  const values = { status, resolvedAt: new Date() };
  if (db.kind === "sqlite") {
    await db.db.update(db.schema.improvementProposals).set(values).where(cond);
  } else {
    await db.db.update(db.schema.improvementProposals).set(values).where(cond);
  }
}

export async function dismissImprovementProposal(db: Db, id: string) {
  const row = await getProposalRow(db, id);
  if (!row || row.status !== "pending") return null;
  await setStatus(db, id, "dismissed");
  return { ...toWire(row), status: "dismissed" as const };
}

// Publishes through the exact same registry paths the manual dialogs use, with the validation
// verdict appended to the version's reasoning so history keeps the receipt.
export async function publishImprovementProposal(db: Db, id: string) {
  const row = await getProposalRow(db, id);
  if (!row || row.status !== "pending") return null;
  const proposal = row.proposal as { revisedText?: string; definition?: string; reasoning?: string; basedOnVersion?: number };
  const validation = row.validation as { summary?: string } | null;
  const reasoning = [proposal.reasoning ?? "", validation?.summary ? `Validated: ${validation.summary}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (row.kind === "prompt") {
    const text = proposal.revisedText;
    if (!text) return null;
    const published = await publishPromptVersion(db, row.targetId, {
      text,
      source: "proposed",
      reasoning,
      basedOnVersion: proposal.basedOnVersion,
    });
    if (!published) return null;
  } else {
    const definition = proposal.definition;
    if (!definition) return null;
    const published = await publishToolSchemaVersion(db, row.targetId, {
      definition,
      source: "proposed",
      reasoning,
      basedOnVersion: proposal.basedOnVersion,
    });
    if (!published) return null;
  }
  await setStatus(db, id, "published");
  return { ...toWire(row), status: "published" as const };
}

async function insertProposal(db: Db, row: Omit<ImprovementProposalRow, "resolvedAt" | "projectId">): Promise<void> {
  const full: ImprovementProposalRow = { ...row, resolvedAt: null, projectId: db.projectId };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.improvementProposals).values(full);
  } else {
    await db.db.insert(db.schema.improvementProposals).values(full);
  }
}

// Cooldown gate: no new proposal for a target while one is pending, or within 24h of the last
// one regardless of how it resolved.
function targetBlocked(existing: ImprovementProposalRow[], kind: string, targetId: string, now: number): boolean {
  return existing.some(
    p =>
      p.kind === kind &&
      p.targetId === targetId &&
      (p.status === "pending" || now - p.createdAt.getTime() < TARGET_COOLDOWN_MS)
  );
}

// The most recent eval run whose subject was tagged with this prompt's name - the natural dataset
// to validate a prompt proposal against (the same dataset the team already grades this prompt
// with). Null when the prompt has never been run against a dataset; validation is skipped then.
async function findDatasetForPrompt(db: Db, promptName: string): Promise<string | null> {
  const cond = eq(db.schema.evaluationRuns.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).where(cond).all()
      : await db.db.select().from(db.schema.evaluationRuns).where(cond)
  ) as { datasetId: string; evaluationSubject: unknown; createdAt: Date }[];
  const tagged = rows
    .filter(r => {
      const subject = r.evaluationSubject as { metadata?: { promptName?: unknown } } | null;
      return subject?.metadata?.promptName === promptName;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return tagged[0]?.datasetId ?? null;
}

export async function sweepImprovementsOnce(scoped?: Db): Promise<{ created: number }> {
  let created = 0;
  const base = getDb();
  const projects = scoped ? null : await listProjectRows(base);
  const orgByProject = new Map((projects ?? []).map(p => [p.id, (p as { organizationId?: string | null }).organizationId ?? null]));
  const dbs: Db[] = scoped ? [scoped] : (projects ?? []).map(p => withProjectId(base, p.id));

  for (const db of dbs) {
    if (created >= MAX_NEW_PROPOSALS_PER_SWEEP) break;
    // Tenancy context for judge calls made below - same reason sessionSweep.ts wraps its
    // per-project body (multi-tenant key resolution happens outside any request here).
    await runWithTenancy({ projectId: db.projectId, organizationId: orgByProject.get(db.projectId) ?? null }, async () => {
    const existing = (await listImprovementProposals(db)).map(w => ({
      ...w,
      createdAt: new Date(w.createdAt),
    })) as unknown as ImprovementProposalRow[];
    const now = Date.now();

    // --- Tool schemas: fresh failures since the target's last proposal ---
    for (const schema of await listToolSchemasWire(db)) {
      if (created >= MAX_NEW_PROPOSALS_PER_SWEEP) break;
      if (targetBlocked(existing, "tool-schema", schema._id, now)) continue;
      const evidence = await getToolFailureExamples(db, schema._id, 1);
      const failures = (evidence?.examples ?? []).filter(e => e.source === "tool-failure");
      if (failures.length < EVIDENCE_THRESHOLD) continue;

      try {
        const result = await proposeToolSchemaImprovement(db, schema._id, { windowDays: 1 });
        if (!result?.proposal) continue;
        const current = await getToolSchemaVersionRow(db, schema._id, schema.currentVersion);
        let validation: unknown = null;
        try {
          const validated = await validateToolSchemaProposal(db, schema._id, {
            candidateDefinition: result.proposal.definition,
            maxCases: VALIDATION_MAX_CASES,
          });
          validation = "error" in validated ? null : validated;
        } catch {
          validation = null; // a validation failure queues the proposal unvalidated, never drops it
        }
        await insertProposal(db, {
          id: nanoid(),
          kind: "tool-schema",
          targetId: schema._id,
          targetName: schema.name,
          status: "pending",
          triggerReason: `${failures.length} tool failure${failures.length === 1 ? "" : "s"} in the last 24h`,
          currentText: current?.definition ?? "",
          proposal: result.proposal,
          validation,
          createdAt: new Date(),
        });
        created++;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err }, `Improvement sweep (tool ${schema.name}) failed:`);
      }
    }

    // --- Prompts: fresh low-rated evidence ---
    for (const prompt of await listPromptRows(db)) {
      if (created >= MAX_NEW_PROPOSALS_PER_SWEEP) break;
      if (targetBlocked(existing, "prompt", prompt.id, now)) continue;
      const gathered = await getWorstRatedExamples(db, prompt.id, { window: "24h" });
      const lowRated = (gathered?.examples ?? []).filter(e => e.rating < LOW_RATING);
      if (lowRated.length < EVIDENCE_THRESHOLD) continue;

      try {
        const result = await proposePromptImprovement(db, prompt.id, { window: "24h" });
        if (!result?.revisedText) continue;
        const current = await getPromptVersionRow(db, prompt.id, prompt.currentVersion);
        let validation: unknown = null;
        const datasetId = await findDatasetForPrompt(db, prompt.name);
        if (datasetId) {
          try {
            const validated = await validatePromptProposal(db, prompt.id, {
              candidateText: result.revisedText,
              datasetId,
              maxCases: VALIDATION_MAX_CASES,
            });
            validation = "error" in validated ? null : validated;
          } catch {
            validation = null;
          }
        }
        await insertProposal(db, {
          id: nanoid(),
          kind: "prompt",
          targetId: prompt.id,
          targetName: prompt.name,
          status: "pending",
          triggerReason: `${lowRated.length} low-rated example${lowRated.length === 1 ? "" : "s"} (below ${LOW_RATING}/10) in the last 24h`,
          currentText: current?.text ?? "",
          proposal: {
            revisedText: result.revisedText,
            reasoning: result.reasoning,
            changes: result.changes,
            basedOnVersion: result.basedOnVersion,
            judgeModel: result.judgeModel,
            exampleCount: result.exampleCount,
          },
          validation,
          createdAt: new Date(),
        });
        created++;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err }, `Improvement sweep (prompt ${prompt.name}) failed:`);
      }
    }
    });
  }
  return { created };
}

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

export function startImprovementSweep(): void {
  if (process.env.AGENTX_IMPROVEMENT_SWEEP === "false") {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweeping) return; // proposal + validation rounds are slow; never stack two sweeps
    sweeping = true;
    // Cross-replica guard (see core/shared/sweepLease.ts): one elected sweeper per tick when
    // several engines share a database. TTL sized for a full proposal+validation round. The
    // manual /improve/inbox/sweep/run route bypasses this on purpose.
    acquireSweepLease(getDb(), "improvement-sweep", 15 * 60_000)
      .then(acquired => (acquired ? sweepImprovementsOnce() : null))
      .catch((err: unknown) => logger.error({ err }, "Improvement sweep failed"))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopImprovementSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
