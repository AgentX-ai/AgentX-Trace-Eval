import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { logger } from "../../log.js";

// Auto-improve: close the loop from human-confirmed production failures to a code fix.
//
// Batch lifecycle: exactly one COLLECTING group exists at a time - every Confirm verdict in
// signal review lands the confirmed occurrence there automatically (signals.ts calls
// captureConfirmedFailure; Confirm IS the accumulation gesture, declining is choosing Ignore).
// Generating a report SEALS that group: it becomes the report's permanent batch (status
// "proposed", renamed with its seal time, keeping exactly the source cases the report was built
// from) and the pending accumulator is thereby cleared - the next Confirm lazily starts a fresh
// collecting group, and the next generate produces a new report from a new batch. One report
// per group, one group per report.
//
// The report is stored id-addressable so the AgentX-Eval-Skill auto-improve skill can fetch it
// (GET /agent-monitoring/improvement-reports/:id) and triage the fixes against the agent's
// actual source. This is the ONLINE half of improvement - evidence comes exclusively from
// production verdicts a human confirmed, never from offline dataset runs.

export const DEFAULT_GROUP_NAME = "Confirmed failures";

type GroupRow = { id: string; projectId: string | null; name: string; status: string; createdAt: Date };
type MemberRow = {
  id: string;
  projectId: string | null;
  groupId: string;
  signalId: string | null;
  eventId: string | null;
  traceId: string | null;
  source: string;
  summary: string | null;
  scorerName: string | null;
  rating: number | null;
  judgeRationale: string | null;
  inputText: string | null;
  outputText: string | null;
  addedAt: Date;
};
type ReportRow = {
  id: string;
  projectId: string | null;
  groupId: string;
  memberCount: number;
  report: unknown;
  createdAt: Date;
};

const groupWire = (row: GroupRow, memberCount: number) => ({
  _id: row.id,
  name: row.name,
  status: row.status,
  memberCount,
  createdAt: row.createdAt.toISOString(),
});

const memberWire = (row: MemberRow) => ({
  _id: row.id,
  signalId: row.signalId,
  eventId: row.eventId,
  traceId: row.traceId,
  source: row.source,
  summary: row.summary,
  scorerName: row.scorerName,
  rating: row.rating,
  judgeRationale: row.judgeRationale,
  inputText: row.inputText,
  outputText: row.outputText,
  addedAt: row.addedAt.toISOString(),
});

async function listGroupRows(db: Db): Promise<GroupRow[]> {
  const cond = eq(db.schema.improvementGroups.projectId, db.projectId);
  return (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementGroups).where(cond).all()
      : await db.db.select().from(db.schema.improvementGroups).where(cond)
  ) as GroupRow[];
}

async function listMemberRows(db: Db, groupId: string): Promise<MemberRow[]> {
  const cond = and(
    eq(db.schema.improvementGroupMembers.groupId, groupId),
    eq(db.schema.improvementGroupMembers.projectId, db.projectId)
  );
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementGroupMembers).where(cond).all()
      : await db.db.select().from(db.schema.improvementGroupMembers).where(cond)
  ) as MemberRow[];
  return rows.sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
}

async function ensureCollectingGroup(db: Db): Promise<GroupRow> {
  // Status, not name, identifies the accumulator: sealed batches keep a timestamped variant of
  // the default name, and only ever one group is collecting.
  const existing = (await listGroupRows(db)).find(group => group.status === "collecting");
  if (existing) return existing;
  const row: GroupRow = {
    id: nanoid(),
    projectId: db.projectId,
    name: DEFAULT_GROUP_NAME,
    status: "collecting",
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.improvementGroups).values(row);
  } else {
    await db.db.insert(db.schema.improvementGroups).values(row);
  }
  return row;
}

// Called by signals.ts when a Confirm verdict lands. Snapshots the evidence at confirm time so
// a later trace prune cannot hollow out the report the member ends up in. Deduped per
// (group, signal, event): re-confirming after a reopen must not double the evidence.
export async function captureConfirmedFailure(
  db: Db,
  input: {
    signalId: string;
    patternKey: string;
    summary: string;
    scorerName: string | null;
    eventId: string | null;
    traceId: string | null;
    rating: number | null;
    judgeRationale: string | null;
    inputText: string | null;
    outputText: string | null;
  }
): Promise<void> {
  const group = await ensureCollectingGroup(db);
  const members = await listMemberRows(db, group.id);
  const duplicate = members.some(
    member => member.signalId === input.signalId && (member.eventId ?? null) === (input.eventId ?? null)
  );
  if (duplicate) return;
  const row: MemberRow = {
    id: nanoid(),
    projectId: db.projectId,
    groupId: group.id,
    signalId: input.signalId,
    eventId: input.eventId,
    traceId: input.traceId,
    source: input.patternKey.startsWith("online-eval:") ? "low-score" : "confirm",
    summary: input.summary,
    scorerName: input.scorerName,
    rating: input.rating,
    judgeRationale: input.judgeRationale,
    inputText: input.inputText,
    outputText: input.outputText,
    addedAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.improvementGroupMembers).values(row);
  } else {
    await db.db.insert(db.schema.improvementGroupMembers).values(row);
  }
}

export async function listImprovementGroups(db: Db) {
  const groups = await listGroupRows(db);
  const wires = [];
  for (const group of groups) {
    const members = await listMemberRows(db, group.id);
    wires.push(groupWire(group, members.length));
  }
  // The collecting accumulator first, then sealed batches newest first.
  return wires.sort((a, b) => {
    if (a.status !== b.status) return a.status === "collecting" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function getImprovementGroup(db: Db, id: string) {
  const group = (await listGroupRows(db)).find(row => row.id === id);
  if (!group) return null;
  const members = await listMemberRows(db, id);
  return { ...groupWire(group, members.length), members: members.map(memberWire) };
}

export async function removeGroupMember(db: Db, groupId: string, memberId: string): Promise<boolean> {
  const cond = and(
    eq(db.schema.improvementGroupMembers.id, memberId),
    eq(db.schema.improvementGroupMembers.groupId, groupId),
    eq(db.schema.improvementGroupMembers.projectId, db.projectId)
  );
  const existing = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementGroupMembers).where(cond).all()
      : await db.db.select().from(db.schema.improvementGroupMembers).where(cond)
  ) as MemberRow[];
  if (existing.length === 0) return false;
  if (db.kind === "sqlite") {
    await db.db.delete(db.schema.improvementGroupMembers).where(cond);
  } else {
    await db.db.delete(db.schema.improvementGroupMembers).where(cond);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The report: one LLM pass clustering confirmed failures into issues + fixes.
// ---------------------------------------------------------------------------

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          recommendation: { type: "string" },
          memberIndexes: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "description", "recommendation", "memberIndexes"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "issues"],
  additionalProperties: false,
} as const;

const MAX_REPORT_MEMBERS = 30;
const clip = (value: string | null, max: number) => (value ? (value.length > max ? `${value.slice(0, max)}...` : value) : "");

export type ImprovementReportWire = {
  _id: string;
  groupId: string;
  groupName: string;
  memberCount: number;
  summary: string;
  issues: Array<{
    title: string;
    description: string;
    recommendation: string;
    evidence: Array<{
      traceId: string | null;
      scorerName: string | null;
      rating: number | null;
      judgeRationale: string | null;
      input: string | null;
      output: string | null;
      source: string;
    }>;
  }>;
  createdAt: string;
};

export async function generateImprovementReport(
  db: Db,
  groupId: string,
  options: { model?: string } = {}
): Promise<ImprovementReportWire | { error: string } | null> {
  const group = (await listGroupRows(db)).find(row => row.id === groupId);
  if (!group) return null;
  const members = (await listMemberRows(db, groupId)).slice(0, MAX_REPORT_MEMBERS);
  if (members.length === 0) {
    return { error: "This group has no confirmed failures yet - Confirm signals in Review first." };
  }

  const evidenceBlock = members
    .map(
      (member, index) =>
        `[${index}] scorer=${member.scorerName ?? member.source} rating=${member.rating ?? "n/a"}\n` +
        `  input: ${clip(member.inputText, 500) || "(not captured)"}\n` +
        `  output: ${clip(member.outputText, 500) || "(not captured)"}\n` +
        `  judge rationale: ${clip(member.judgeRationale ?? member.summary, 500) || "(none)"}`
    )
    .join("\n\n");

  const userMessage = `You are analyzing HUMAN-CONFIRMED production failures of an AI agent. Every item below was
flagged by an automated check (an LLM judge or a failure pattern) AND then confirmed as a real
failure by a human reviewer - treat the set as high-precision evidence, not noise.

Cluster them into distinct issues (typically 1-5). For each issue give:
- title: short, specific name for the failure mode
- description: what goes wrong, grounded in the evidence
- recommendation: what to change in the AGENT (its prompt, its tools, its retrieval, its flow)
  to fix it. Be concrete but do not invent facts about the agent's implementation - the reader
  will triage your recommendation against the real source code.
- memberIndexes: which evidence items belong to this issue.

Also write a one-paragraph summary of the overall picture.

EVIDENCE:
${evidenceBlock}`;

  const result = await callJudgeJson({
    userMessage,
    model: options.model ?? DEFAULT_JUDGE_MODEL,
    jsonSchema: REPORT_SCHEMA,
    maxTokens: 4000,
  });
  const payload = result.payload as {
    summary: string;
    issues: Array<{ title: string; description: string; recommendation: string; memberIndexes: number[] }>;
  };

  const sealedNamePreview =
    group.status === "collecting"
      ? `${DEFAULT_GROUP_NAME} · ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : group.name;
  const wire: ImprovementReportWire = {
    _id: nanoid(),
    groupId,
    groupName: sealedNamePreview,
    memberCount: members.length,
    summary: payload.summary,
    issues: payload.issues.map(issue => ({
      title: issue.title,
      description: issue.description,
      recommendation: issue.recommendation,
      evidence: issue.memberIndexes
        .filter(index => index >= 0 && index < members.length)
        .map(index => {
          const member = members[index]!;
          return {
            traceId: member.traceId,
            scorerName: member.scorerName,
            rating: member.rating,
            judgeRationale: member.judgeRationale,
            input: member.inputText,
            output: member.outputText,
            source: member.source,
          };
        }),
    })),
    createdAt: new Date().toISOString(),
  };

  const row: ReportRow = {
    id: wire._id,
    projectId: db.projectId,
    groupId,
    memberCount: members.length,
    report: wire,
    createdAt: new Date(),
  };
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.improvementReports).values(row);
  } else {
    await db.db.insert(db.schema.improvementReports).values(row);
  }
  // Seal the batch: it now belongs to this report, named by when it was spent. The pending
  // accumulator is cleared by construction - the next Confirm starts a fresh collecting group.
  const sealedName = sealedNamePreview;
  {
    const cond = and(eq(db.schema.improvementGroups.id, groupId), eq(db.schema.improvementGroups.projectId, db.projectId));
    if (db.kind === "sqlite") {
      await db.db.update(db.schema.improvementGroups).set({ status: "proposed", name: sealedName }).where(cond);
    } else {
      await db.db.update(db.schema.improvementGroups).set({ status: "proposed", name: sealedName }).where(cond);
    }
  }
  logger.info(`Improvement report ${wire._id} generated from group "${group.name}" (${members.length} failures)`);
  return wire;
}

export async function getImprovementReport(db: Db, id: string): Promise<ImprovementReportWire | null> {
  const cond = and(eq(db.schema.improvementReports.id, id), eq(db.schema.improvementReports.projectId, db.projectId));
  const rows = (
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.improvementReports).where(cond).all()
      : await db.db.select().from(db.schema.improvementReports).where(cond)
  ) as ReportRow[];
  return rows.length ? (rows[0]!.report as ImprovementReportWire) : null;
}

export async function listImprovementReports(db: Db) {
  const cond = eq(db.schema.improvementReports.projectId, db.projectId);
  const rows = (
    db.kind === "sqlite"
      ? db.db
          .select()
          .from(db.schema.improvementReports)
          .where(cond)
          .orderBy(desc(db.schema.improvementReports.createdAt))
          .all()
      : await db.db
          .select()
          .from(db.schema.improvementReports)
          .where(cond)
          .orderBy(desc(db.schema.improvementReports.createdAt))
  ) as ReportRow[];
  return rows.map(row => {
    const report = row.report as ImprovementReportWire;
    return {
      _id: row.id,
      groupId: row.groupId,
      groupName: report.groupName,
      memberCount: row.memberCount,
      issueCount: report.issues.length,
      summary: report.summary,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
