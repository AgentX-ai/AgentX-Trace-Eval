import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { getSignal } from "./signals.js";

// Both of these reuse the same BYO OPENAI_API_KEY/ANTHROPIC_API_KEY judge-calling helper Monitor's
// semantic pattern detector and Evaluate's judge scoring already use (core/evaluate/judge.ts),
// rather than a separate LLM integration — one place that throws a clear "set OPENAI_API_KEY"
// error when no key is configured, instead of three.

const regexSchema = { type: "object", properties: { regex: { type: "string" } }, required: ["regex"] };

// AgentX-web-front's PatternConditionRow sends only a plain-language description (see
// useGenerateMonitoringPatternRegex.ts) and writes the result straight into a condition's `value`
// field verbatim, so this must return a bare pattern body, no slashes/flags/anchors assumed.
export async function generateRegex(description: string): Promise<string> {
  const result = await callJudgeJson({
    model: DEFAULT_JUDGE_MODEL,
    jsonSchema: regexSchema,
    userMessage:
      `Write a single regular expression (JavaScript/PCRE-compatible, no slashes, no flags) that matches: ${description}\n\n` +
      `Respond with JSON {"regex": "..."}. The regex body only, e.g. for "mentions a refund or chargeback" respond ` +
      `{"regex": "refund|chargeback"}.`,
  });
  const payload = result.payload as { regex?: string } | null;
  if (typeof payload?.regex !== "string" || !payload.regex.trim()) {
    throw new Error("Judge model did not return a usable regex");
  }
  return payload.regex.trim();
}

const feedbackSchema = { type: "object", properties: { feedback: { type: "string" } }, required: ["feedback"] };

// AgentX-web-front's DraftEvaluatorDialog shows this verbatim in a "review before accepting" card
// (see useSuggestMonitoringHumanFeedback.ts) — a starting draft for a human reviewer to edit, not
// a final judgment, so the prompt asks for a short, reviewer-voice note rather than a rating.
export async function suggestHumanFeedback(db: Db, signalId: string): Promise<string> {
  const signal = await getSignal(db, signalId);
  if (!signal) {
    throw new Error("Signal not found");
  }

  const evidence = signal.evidence as { input?: unknown; output?: unknown } | undefined;
  const userMessage = [
    "Draft a short (1-3 sentence) human-reviewer note explaining what went wrong with this agent response, ",
    "written as feedback a reviewer would leave, not a formal report.",
    "",
    `Issue: ${signal.summary}`,
    signal.rootCause ? `Root cause: ${signal.rootCause}` : null,
    evidence?.input !== undefined ? `Input: ${JSON.stringify(evidence.input)}` : null,
    evidence?.output !== undefined ? `Output: ${JSON.stringify(evidence.output)}` : null,
    "",
    'Respond with JSON {"feedback": "..."}.',
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const result = await callJudgeJson({ model: DEFAULT_JUDGE_MODEL, jsonSchema: feedbackSchema, userMessage });
  const payload = result.payload as { feedback?: string } | null;
  if (typeof payload?.feedback !== "string" || !payload.feedback.trim()) {
    throw new Error("Judge model did not return usable feedback");
  }
  return payload.feedback.trim();
}
