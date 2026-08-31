import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../storage/db.js";
import { createDataset, listDatasets } from "./evaluate/datasets.js";
import { createEvaluationSettings, listStandaloneEvaluationSettings } from "./evaluate/evaluationSettings.js";
import { createPrompt, listPromptRows } from "./evaluate/prompts.js";
import { createAgent, listAgentsWire } from "./monitor/agents.js";
import { updateProfile } from "./monitor/profiles.js";
import { ingestTrace } from "./trace/ingest.js";
import { runMonitorCheck } from "./monitor/detect.js";
import { createProject, listProjectRows } from "./project/projects.js";
import { ensureSessionBaselineJudge } from "./monitor/builtinEvaluators.js";
import { ensureMetricPackConfigs } from "./evaluate/metricPack.js";
import { withProjectId, type Db as DbType } from "../storage/db.js";
import { logger } from "../log.js";
import { traceStoreFor } from "./trace/store/index.js";

// The example content lives in its own project, not in Default.
//
// It used to go into Default, which meant the first project someone points their SDK at already
// contained a fake agent, fake traces and a fake dataset. Their own first trace landed in a list
// next to invented ones, and every count on every page was their data plus ours. Deleting it all
// was the first thing anyone did.
//
// So: Default starts genuinely empty, and a second project named "Example" holds the tour. It is
// created once, on a fresh install only - an existing install never sprouts a new project on
// upgrade, and someone who deletes the Example project does not get it back on the next restart.
export const EXAMPLE_PROJECT_NAME = "Example";
const EXAMPLE_AGENT_NAME = "example-support-agent";

export async function seedFreshInstall(db: Db, opts: { freshInstall: boolean }): Promise<void> {
  if (!opts.freshInstall) {
    return;
  }
  const projects = await listProjectRows(db);
  if (projects.some(p => p.name === EXAMPLE_PROJECT_NAME)) {
    return;
  }
  // Same organization as Default, so in auth mode the example is visible to the owner who just
  // signed up rather than orphaned behind a membership check.
  const defaultProject = projects.find(p => p.isDefault) ?? projects[0];
  const example = await createProject(db, EXAMPLE_PROJECT_NAME, defaultProject?.organizationId ?? null);
  const scoped = withProjectId(db as DbType, example._id);
  // Best-effort in the same sense the previous seeding was: a fresh install must boot even if one
  // piece of the tour cannot be written, and an engine that refuses to start because example data
  // failed would be a worse bug than a missing example.
  try {
    await seedExampleDataIfEmpty(scoped);
    await ensureSessionBaselineJudge(scoped);
    await ensureMetricPackConfigs(scoped);
  } catch (err) {
    logger.warn({ err }, "Could not seed the Example project - continuing with an empty one");
  }
}

// The content itself. Each piece still only inserts when its own table is genuinely empty, so
// re-running against a project someone has edited never resurrects a deleted example.
export async function seedExampleDataIfEmpty(db: Db): Promise<void> {
  await seedExampleEvaluatorConfig(db);
  await seedExampleDataset(db);
  await seedExamplePrompt(db);
  await seedExampleMonitorDataIfEmpty(db);
  await seedExampleSessionIfEmpty(db);
  await seedExampleTopicsIfEmpty(db);
  await seedExampleRunIfEmpty(db);
}

// Datasets/Evaluator/Prompts above cover Evaluate; Governance's Agents/Observe/Monitor tabs had
// nothing seeding them at all - a fresh install landed on an empty Agents tab with no idea what
// "monitored" even looks like. One example agent, pre-enabled for monitoring (so it shows up as
// "All traffic" rather than "Not monitored"), with real traces run through the actual detection
// pipeline (runMonitorCheck) rather than hand-inserted signal rows - this only exercises built-in
// checks (empty-response), never a judge call, so it works with zero API keys configured, same
// constraint every other seed here has to respect.
async function seedExampleMonitorDataIfEmpty(db: Db): Promise<void> {
  const existingAgents = await listAgentsWire(db);
  if (existingAgents.length > 0) {
    return;
  }

  const agent = await createAgent(db, EXAMPLE_AGENT_NAME);
  await updateProfile(db, agent._id, { enabled: true, coverageMode: "all", sampleRate: 1 });

  // Three traces, each showing a different shape the product is actually about (not flat
  // input/output rows - those left the Execution Timeline empty on a fresh install's only
  // example traces):
  //   1. an agentic tool-use trace: root -> LLM planning call -> tool call -> LLM answer,
  //   2. a RAG trace: root -> retrieval (kind-marked, chunk outputs) -> LLM answer,
  //   3. a failure trace: the escalation tool times out and the agent returns nothing -
  //      classified operationally (tool failure) into the KPI tallies, so Overview starts with
  //      real failure metrics pointing at a trace whose timeline shows the broken step.
  // Children are sent before their root, the same order the SDK emits.
  const base = Date.now() - 10 * 60 * 1000;
  const nano = (offsetMs: number) => String((base + offsetMs) * 1_000_000);

  // 1. Tool use: "where is my order"
  {
    const sessionId = nanoid();
    const root = nanoid();
    const children = [
      {
        name: "LLM Call 1",
        input: "Plan: the user asks about order #4471's status. Decide which tool to call.",
        output: 'Call lookup_order with {"order_id": "4471"}.',
        latency_ms: 420,
        model: "gpt-4o-mini",
        input_tokens: 210,
        output_tokens: 24,
        started_at_unix_nano: nano(0),
      },
      {
        name: "lookup_order",
        input: { order_id: "4471" },
        output: { status: "in_transit", carrier: "UPS", eta_days: 2 },
        latency_ms: 240,
        started_at_unix_nano: nano(430),
      },
      {
        name: "LLM Call 2",
        input: "Compose the answer from the tool result.",
        output: "Order #4471 is in transit with UPS and should arrive within 2 days.",
        latency_ms: 610,
        model: "gpt-4o-mini",
        input_tokens: 260,
        output_tokens: 41,
        started_at_unix_nano: nano(680),
      },
    ];
    for (const child of children) {
      await ingestTrace(db, { ...child, session_id: sessionId, span_id: nanoid(), parent_span_id: root });
    }
    const { traceId } = await ingestTrace(db, {
      name: agent.name,
      agent_id: agent._id,
      input: "Where is my order #4471? It's been a week.",
      output: "Order #4471 is in transit with UPS and should arrive within 2 days.",
      latency_ms: 1290,
      model: "gpt-4o-mini",
      input_tokens: 470,
      output_tokens: 65,
      session_id: sessionId,
      span_id: root,
      started_at_unix_nano: nano(0),
      tool_calls: [
        {
          name: "lookup_order",
          input: { order_id: "4471" },
          output: { status: "in_transit", carrier: "UPS", eta_days: 2 },
          latency_ms: 240,
          success: true,
        },
      ],
    });
    await runMonitorCheck(
      db,
      { input: "Where is my order #4471? It's been a week.", output: "Order #4471 is in transit with UPS and should arrive within 2 days.", latencyMs: 1290 },
      { agentId: agent._id, traceId }
    );
  }

  // 2. RAG: "what's your return policy" - the retrieval child carries the kind marker and its
  // chunks, exactly what the RAG judges' {context} extraction reads.
  {
    const sessionId = nanoid();
    const root = nanoid();
    const policyChunk =
      "Returns: any item can be returned within 30 days of delivery for a full refund. Items must be unused and in original packaging. Refunds are issued within 5-7 business days.";
    await ingestTrace(db, {
      name: "kb_search",
      input: "return policy",
      output: [policyChunk],
      latency_ms: 90,
      metadata: { kind: "retrieval" },
      session_id: sessionId,
      span_id: nanoid(),
      parent_span_id: root,
      started_at_unix_nano: nano(60_000),
    });
    await ingestTrace(db, {
      name: "LLM Call 1",
      input: "Answer from the retrieved policy chunk only.",
      output: "You can return any item within 30 days of delivery for a full refund - unused and in original packaging. Refunds land in 5-7 business days.",
      latency_ms: 540,
      model: "gpt-4o-mini",
      input_tokens: 190,
      output_tokens: 46,
      session_id: sessionId,
      span_id: nanoid(),
      parent_span_id: root,
      started_at_unix_nano: nano(60_100),
    });
    const { traceId } = await ingestTrace(db, {
      name: agent.name,
      agent_id: agent._id,
      input: "What's your return policy?",
      output: "You can return any item within 30 days of delivery for a full refund - unused and in original packaging. Refunds land in 5-7 business days.",
      latency_ms: 650,
      model: "gpt-4o-mini",
      input_tokens: 190,
      output_tokens: 46,
      session_id: sessionId,
      span_id: root,
      started_at_unix_nano: nano(60_000),
    });
    await runMonitorCheck(
      db,
      { input: "What's your return policy?", output: "You can return any item within 30 days of delivery for a full refund - unused and in original packaging. Refunds land in 5-7 business days.", latencyMs: 650 },
      { agentId: agent._id, traceId }
    );
  }

  // 3. Failure: the escalation tool times out and the agent gives up with an empty response -
  // one incident that trips two built-in checks (Tool failure + Empty agent response), the
  // shape a real bad trace has: a full timeline showing exactly which step broke, not a bare
  // input/output row.
  {
    const sessionId = nanoid();
    const root = nanoid();
    const toolError = "Connection to helpdesk API timed out after 2000ms";
    await ingestTrace(db, {
      name: "LLM Call 1",
      input: "The user asks for a human agent. Decide which tool to call.",
      output: 'Call escalate_to_human with {"reason": "customer requested human support"}.',
      latency_ms: 380,
      model: "gpt-4o-mini",
      input_tokens: 180,
      output_tokens: 22,
      session_id: sessionId,
      span_id: nanoid(),
      parent_span_id: root,
      started_at_unix_nano: nano(120_000),
    });
    await ingestTrace(db, {
      name: "escalate_to_human",
      input: { reason: "customer requested human support" },
      output: { error: toolError },
      error: toolError,
      latency_ms: 2000,
      session_id: sessionId,
      span_id: nanoid(),
      parent_span_id: root,
      started_at_unix_nano: nano(120_390),
    });
    const failedToolCalls = [
      {
        name: "escalate_to_human",
        input: { reason: "customer requested human support" },
        output: { error: toolError },
        latency_ms: 2000,
        success: false,
      },
    ];
    const { traceId } = await ingestTrace(db, {
      name: agent.name,
      agent_id: agent._id,
      input: "Can I speak to a human agent?",
      output: "",
      latency_ms: 2400,
      model: "gpt-4o-mini",
      input_tokens: 180,
      output_tokens: 22,
      session_id: sessionId,
      span_id: root,
      started_at_unix_nano: nano(120_000),
      tool_calls: failedToolCalls,
    });
    await runMonitorCheck(
      db,
      { input: "Can I speak to a human agent?", output: "", latencyMs: 2400, toolCalls: failedToolCalls },
      { agentId: agent._id, traceId }
    );
  }
}

// No seeded online evaluator (there used to be a disabled "Example: Helpfulness Monitor"
// placeholder): every online-evaluator check is a real judge call against the user's own key,
// and an example that must ship disabled to be safe demonstrates nothing a two-line snippet in
// the docs doesn't - see /evaluation/rag's online section.
async function seedExampleEvaluatorConfig(db: Db): Promise<void> {
  const existing = await listStandaloneEvaluationSettings(db);
  if (existing.length > 0) {
    return;
  }
  await createEvaluationSettings(db, {
    name: "Example: Helpfulness Judge",
    description: "A starter grading config - safe to edit or delete once you've made your own.",
    acceptanceCriteria:
      "The response directly and correctly addresses what the user asked, without unnecessary hedging or irrelevant information.",
    rejectionCriteria: "The response is off-topic, factually wrong, or ignores part of the user's question.",
    isDefault: true,
    status: "published",
    seeded: true,
  });
}

async function seedExampleDataset(db: Db): Promise<void> {
  const existing = await listDatasets(db);
  if (existing.length > 0) {
    return;
  }
  // Dataset + its evaluationSettings twin share one id, same convention as the dashboard's real
  // "New dataset" flow (routes/evaluateDashboard.ts's POST /evaluationSettings/create).
  const id = nanoid();
  const shared = {
    name: "Example: Customer Support Agent",
    description: "A starter dataset - safe to edit or delete once you've added your own test cases.",
    acceptanceCriteria: "Response is empathetic, asks clarifying questions when needed, and offers a concrete next step.",
  };
  const questions = [
    {
      main_question: {
        query: "A customer says their order hasn't arrived after 2 weeks. How do you respond?",
        expectedResults:
          "Apologizes for the delay, asks for the order number, and offers to check shipping status or issue a refund/replacement if appropriate.",
      },
      follow_up_questions: [],
    },
  ];
  await Promise.all([
    createDataset(db, { id, ...shared, questions }),
    createEvaluationSettings(db, { id, ...shared }),
  ]);
}

async function seedExamplePrompt(db: Db): Promise<void> {
  const existing = await listPromptRows(db);
  if (existing.length > 0) {
    return;
  }
  await createPrompt(db, {
    name: "example-support-agent-system-prompt",
    description: "A starter prompt - safe to edit or delete once you've registered your own.",
    text: "You are a helpful, empathetic customer support agent. Always acknowledge the customer's concern first, ask clarifying questions when the request is ambiguous, and offer a concrete next step or solution.",
  });
}

// A real multi-turn conversation. Every other seeded trace is a single exchange with its own
// session id, which leaves the Sessions view technically populated and practically useless -
// nothing to expand, no turn ordering, no drift across a conversation to look at.
async function seedExampleSessionIfEmpty(db: Db): Promise<void> {
  const agents = await listAgentsWire(db);
  const agent = agents.find(a => a.name === EXAMPLE_AGENT_NAME);
  if (!agent) {
    return;
  }
  const sessionId = nanoid();
  const base = Date.now() - 6 * 60 * 1000;
  const nano = (offsetMs: number) => String((base + offsetMs) * 1_000_000);

  const turns: { input: string; output: string; latency: number }[] = [
    {
      input: "I was charged twice for order 7781.",
      output:
        "I can see two authorizations on order 7781 from the same card. The second one is a pending hold, not a completed charge - it should drop off within 3 business days. Would you like me to release it now instead?",
      latency: 720,
    },
    {
      input: "Yes, release it. How long until I see the money?",
      output:
        "Released. Your bank decides when it posts, which is usually 1-3 business days. You will get an email as soon as we send the release, and the reference number is on that email if your bank asks.",
      latency: 640,
    },
    {
      input: "And can you make sure it doesn't happen again next time I order?",
      output:
        "It happens when an order is retried after a network timeout. I have flagged the account so retries reuse the original authorization instead of opening a second one.",
      latency: 810,
    },
  ];

  for (const [i, turn] of turns.entries()) {
    const { traceId } = await ingestTrace(db, {
      name: agent.name,
      agent_id: agent._id,
      input: turn.input,
      output: turn.output,
      latency_ms: turn.latency,
      model: "gpt-4o-mini",
      input_tokens: 210 + i * 40,
      output_tokens: 52 + i * 6,
      session_id: sessionId,
      span_id: nanoid(),
      started_at_unix_nano: nano(i * 45_000),
    });
    await runMonitorCheck(
      db,
      { input: turn.input, output: turn.output, latencyMs: turn.latency },
      { agentId: agent._id, traceId }
    );
  }
}

// Topics for the seeded traces. Classification is normally an LLM call, and this file's hard
// constraint is that a fresh install boots with no API key configured and spends nothing - so
// these rows are written directly rather than run through core/monitor/topics.ts.
//
// The consequence is deliberate and visible: no embedding column, so the Topics "Map" view stays
// empty for them while the trend, top intents and issue breakdown - the parts that answer "what
// are people asking about" - have something real to draw. Rows classified from actual traffic
// later carry embeddings and appear on the map normally.
async function seedExampleTopicsIfEmpty(db: Db): Promise<void> {
  const existing =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.monitorClassifications).limit(1).all()
      : await db.db.select().from(db.schema.monitorClassifications).limit(1);
  if (existing.length > 0) {
    return;
  }
  const agents = await listAgentsWire(db);
  const agent = agents.find(a => a.name === EXAMPLE_AGENT_NAME);
  if (!agent) {
    return;
  }
  const traces = await listRecentTraceRows(db, 40);
  if (traces.length === 0) {
    return;
  }

  // Mapped off what each seeded trace actually says, so the Topics page and the traces behind it
  // agree with each other.
  const classify = (input: string): { intent: string; sentiment: string; issueType: string } => {
    const text = input.toLowerCase();
    if (text.includes("charged twice") || text.includes("release it") || text.includes("happen again")) {
      return { intent: "Billing dispute", sentiment: "negative", issueType: "Duplicate charge" };
    }
    if (text.includes("human agent")) {
      return { intent: "Escalation request", sentiment: "negative", issueType: "Unresolved request" };
    }
    if (text.includes("return policy")) {
      return { intent: "Returns policy", sentiment: "neutral", issueType: "None" };
    }
    return { intent: "Order status", sentiment: "neutral", issueType: "None" };
  };

  const rows = traces.map(trace => {
    const { intent, sentiment, issueType } = classify(typeof trace.input === "string" ? trace.input : "");
    return {
      id: nanoid(),
      traceId: trace.id,
      agentId: agent._id,
      intent,
      sentiment,
      issueType,
      createdAt: trace.createdAt ?? new Date(),
      projectId: db.projectId,
      embedding: null,
    };
  });
  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.monitorClassifications).values(rows);
  } else {
    await db.db.insert(db.schema.monitorClassifications).values(rows);
  }
}

// Root traces only, newest first - the classification rows attach to what a person sees in
// Observe, not to the child spans underneath them.
async function listRecentTraceRows(db: Db, limit: number) {
  type Row = { id: string; input: unknown; createdAt: Date | null; parentSpanId: string | null };
  return (await traceStoreFor(db).queryWindow({ rootsOnly: true, orderDesc: true, limit })) as unknown as Row[];
}

// One finished evaluation run, so Evaluate opens on a result instead of an empty list and the
// run-comparison, gate and analysis surfaces have something to point at.
//
// The rows are written directly, with the same "only if empty" guard as everything else here.
// The alternative - driving the real run path - would make a judge call per case at install time,
// against whatever key happens to be configured, before anyone has asked for anything. A fresh
// install must not spend money to draw a chart. These are fixture numbers in a project named
// Example, on a dataset named "Example: ...", which is what they are allowed to be.
async function seedExampleRunIfEmpty(db: Db): Promise<void> {
  const existingRuns =
    db.kind === "sqlite"
      ? db.db.select().from(db.schema.evaluationRuns).limit(1).all()
      : await db.db.select().from(db.schema.evaluationRuns).limit(1);
  if (existingRuns.length > 0) {
    return;
  }
  const datasets = await listDatasets(db);
  const dataset = datasets.find(d => d.name.startsWith("Example:"));
  if (!dataset) {
    return;
  }

  const runId = nanoid();
  const createdAt = new Date(Date.now() - 45 * 60 * 1000);
  const runRow = {
    id: runId,
    datasetId: dataset._id,
    evaluationSettingsId: dataset._id,
    evaluationSubject: { displayName: "example-support-agent", framework: "custom", runtime: "local" },
    version: "example-v1",
    runSource: "sdk",
    sdkInfo: null,
    smokeTestVariants: null,
    status: "completed",
    createdAt,
    projectId: db.projectId,
  };

  const cases = [
    {
      query: "A customer says their order hasn't arrived after 2 weeks. How do you respond?",
      output:
        "I'm sorry your order is this late. Could you share the order number? I'll check where it is with the carrier, and if it cannot be located I'll send a replacement or refund it today, whichever you prefer.",
      rating: 8.5,
      justification:
        "Apologizes, asks for the order number, and offers both remedies with a concrete timeframe - all of the acceptance criteria.",
    },
  ];

  const resultRows = cases.map((c, index) => ({
    id: nanoid(),
    runId,
    batchId: "example-batch",
    idempotencyKey: `${runId}-${index}`,
    caseId: null,
    questionIndex: index,
    runNumber: 1,
    input: { query: c.query },
    output: { text: c.output },
    error: null,
    traceId: null,
    isSmokeTestVariant: false,
    smokeTestVariantText: null,
    latencyMs: 900 + index * 120,
    inputTokens: 240,
    outputTokens: 62,
    vectorSimilarity: null,
    jaccardSimilarity: null,
    bleuScore: null,
    rougeScore: null,
    codeScorerResults: null,
    rating: c.rating,
    justification: c.justification,
    status: "scored",
    createdAt,
    projectId: db.projectId,
  }));

  if (db.kind === "sqlite") {
    await db.db.insert(db.schema.evaluationRuns).values(runRow);
    await db.db.insert(db.schema.evaluationRunResults).values(resultRows);
  } else {
    await db.db.insert(db.schema.evaluationRuns).values(runRow);
    await db.db.insert(db.schema.evaluationRunResults).values(resultRows);
  }
}
