import { nanoid } from "nanoid";
import type { Db } from "../storage/db.js";
import { createDataset, listDatasets } from "./evaluate/datasets.js";
import { createEvaluationSettings, listStandaloneEvaluationSettings } from "./evaluate/evaluationSettings.js";
import { createPrompt, listPromptRows } from "./evaluate/prompts.js";
import { createAgent, listAgentsWire } from "./monitor/agents.js";
import { updateProfile } from "./monitor/profiles.js";
import { ingestTrace } from "./trace/ingest.js";
import { runMonitorCheck } from "./monitor/detect.js";

// One-time starter content, not a permanent hardcoded fallback - same convention as db.ts's
// seedPortabilityModelsIfEmpty: each piece only inserts when its own table is genuinely empty, so
// a user who deletes an example never sees it silently reappear on the next restart, and a user
// who already has real data of their own is never touched. Point of this file: a fresh install
// isn't a blank slate with four empty tabs and no idea what to put in them - Datasets, Evaluator,
// Online Evaluators, and Prompts each start with one clearly-labeled "Example: ..." entry showing
// the shape real data takes.
export async function seedExampleDataIfEmpty(db: Db): Promise<void> {
  await seedExampleEvaluatorConfig(db);
  await seedExampleDataset(db);
  await seedExamplePrompt(db);
  await seedExampleMonitorDataIfEmpty(db);
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

  const agent = await createAgent(db, "example-support-agent");
  await updateProfile(db, agent._id, { enabled: true, coverageMode: "all", sampleRate: 1 });

  // Three traces, each showing a different shape the product is actually about (not flat
  // input/output rows - those left the Execution Timeline empty on a fresh install's only
  // example traces):
  //   1. an agentic tool-use trace: root -> LLM planning call -> tool call -> LLM answer,
  //   2. a RAG trace: root -> retrieval (kind-marked, chunk outputs) -> LLM answer,
  //   3. a minimal flat failure trace that trips the built-in "Empty agent response" check,
  //      so Monitor starts with one real signal in the triage queue.
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

  // 3. Failure: deliberately trips the built-in "Empty agent response" check. Kept flat on
  // purpose - a minimal integration sends exactly this shape, and the point of this one is the
  // signal it raises, not its timeline.
  {
    const { traceId } = await ingestTrace(db, {
      name: agent.name,
      agent_id: agent._id,
      input: "Can I speak to a human agent?",
      output: "",
      latency_ms: 400,
      started_at_unix_nano: nano(120_000),
    });
    await runMonitorCheck(db, { input: "Can I speak to a human agent?", output: "", latencyMs: 400 }, { agentId: agent._id, traceId });
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
