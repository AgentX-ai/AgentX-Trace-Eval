import { nanoid } from "nanoid";
import type { Db } from "../storage/db.js";
import { createDataset, listDatasets } from "./evaluate/datasets.js";
import { createEvaluationSettings, listStandaloneEvaluationSettings } from "./evaluate/evaluationSettings.js";
import { createPrompt, listPromptRows } from "./evaluate/prompts.js";
import { createOnlineEvaluator, listOnlineEvaluatorRows } from "./monitor/onlineEvaluators.js";

// One-time starter content, not a permanent hardcoded fallback — same convention as db.ts's
// seedPortabilityModelsIfEmpty: each piece only inserts when its own table is genuinely empty, so
// a user who deletes an example never sees it silently reappear on the next restart, and a user
// who already has real data of their own is never touched. Point of this file: a fresh install
// isn't a blank slate with four empty tabs and no idea what to put in them — Datasets, Evaluator,
// Online Evaluators, and Prompts each start with one clearly-labeled "Example: ..." entry showing
// the shape real data takes.
export async function seedExampleDataIfEmpty(db: Db): Promise<void> {
  const evaluatorConfigId = await seedExampleEvaluatorConfig(db);
  // Only seeds an online evaluator when the config above was *just* created here — never wired up
  // to reference an arbitrary pre-existing user config just because monitor_online_evaluators
  // happens to be empty (e.g. the user deleted only their online evaluators, not their configs).
  await seedExampleOnlineEvaluator(db, evaluatorConfigId);
  await seedExampleDataset(db);
  await seedExamplePrompt(db);
}

async function seedExampleEvaluatorConfig(db: Db): Promise<string | null> {
  const existing = await listStandaloneEvaluationSettings(db);
  if (existing.length > 0) {
    return null;
  }
  const created = await createEvaluationSettings(db, {
    name: "Example: Helpfulness Judge",
    description: "A starter grading config — safe to edit or delete once you've made your own.",
    acceptanceCriteria:
      "The response directly and correctly addresses what the user asked, without unnecessary hedging or irrelevant information.",
    rejectionCriteria: "The response is off-topic, factually wrong, or ignores part of the user's question.",
    isDefault: true,
    status: "published",
  });
  return created._id;
}

async function seedExampleOnlineEvaluator(db: Db, evaluatorConfigId: string | null): Promise<void> {
  if (!evaluatorConfigId) {
    return;
  }
  const existing = await listOnlineEvaluatorRows(db);
  if (existing.length > 0) {
    return;
  }
  // Disabled by default: every check is a real LLM call against the user's own API key — an
  // example should be safe to look at, not something that silently starts spending credits the
  // moment traces start flowing in.
  await createOnlineEvaluator(db, {
    name: "Example: Helpfulness Monitor",
    evaluationSettingsId: evaluatorConfigId,
    sampleRate: 0.2,
    scopeMode: "all",
    enabled: false,
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
    description: "A starter dataset — safe to edit or delete once you've added your own test cases.",
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
    description: "A starter prompt — safe to edit or delete once you've registered your own.",
    text: "You are a helpful, empathetic customer support agent. Always acknowledge the customer's concern first, ask clarifying questions when the request is ambiguous, and offer a concrete next step or solution.",
  });
}
