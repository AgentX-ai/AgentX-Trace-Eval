import type { Db } from "../../storage/db.js";
import { callJudgeJson, DEFAULT_JUDGE_MODEL } from "../evaluate/judge.js";
import { getSignal } from "./signals.js";
import { listFeedbackForSignal } from "./feedback.js";

// Both of these reuse the same BYO OPENAI_API_KEY/ANTHROPIC_API_KEY judge-calling helper Monitor's
// semantic pattern detector and Evaluate's judge scoring already use (core/evaluate/judge.ts),
// rather than a separate LLM integration - one place that throws a clear "set OPENAI_API_KEY"
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

// Signal.evidence/summary are last-write-wins (upsertSignal overwrites them on every repeat match,
// see signals.ts) - always the LATEST occurrence, not necessarily the one the reviewer picked in
// DraftEvaluatorDialog's occurrence picker. occurrenceId (an occurrence's event id, from
// signal.occurrences[].id) lets the caller pin these to a specific occurrence's real captured
// input/output instead, resolved by getSignal via resolveOccurrenceEvidence. Falls back to the
// signal's own evidence/summary when omitted or not found, matching the pre-picker behavior.
function resolveOccurrenceContext(
  signal: NonNullable<Awaited<ReturnType<typeof getSignal>>>,
  occurrenceId?: string
): { input?: unknown; output?: unknown; summary: string } {
  const evidence = signal.evidence as { input?: unknown; output?: unknown } | undefined;
  const occurrence = occurrenceId ? signal.occurrences?.find(o => o.id === occurrenceId) : undefined;
  if (occurrence && (occurrence.query !== undefined || occurrence.responsePreview !== undefined)) {
    return {
      input: occurrence.query,
      output: occurrence.responsePreview,
      summary:
        occurrence.rating != null && occurrence.justification
          ? `Rated ${occurrence.rating.toFixed(1)}/10: ${occurrence.justification}`
          : signal.summary,
    };
  }
  return { input: evidence?.input, output: evidence?.output, summary: signal.summary };
}

// AgentX-web-front's DraftEvaluatorDialog shows this verbatim in a "review before accepting" card
// (see useSuggestMonitoringHumanFeedback.ts) - a starting draft for a human reviewer to edit, not
// a final judgment, so the prompt asks for a short, reviewer-voice note rather than a rating.
export async function suggestHumanFeedback(db: Db, signalId: string, occurrenceId?: string): Promise<string> {
  const signal = await getSignal(db, signalId);
  if (!signal) {
    throw new Error("Signal not found");
  }

  const context = resolveOccurrenceContext(signal, occurrenceId);
  const userMessage = [
    "Draft a short (1-3 sentence) human-reviewer note explaining what went wrong with this agent response, ",
    "written as feedback a reviewer would leave, not a formal report.",
    "",
    `Issue: ${context.summary}`,
    signal.rootCause ? `Root cause: ${signal.rootCause}` : null,
    context.input !== undefined ? `Input: ${JSON.stringify(context.input)}` : null,
    context.output !== undefined ? `Output: ${JSON.stringify(context.output)}` : null,
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

const expectedResultsSchema = {
  type: "object",
  properties: { expectedResults: { type: "string" }, resolution: { type: "string" } },
  required: ["expectedResults"],
};

// Enterprise/multi-operator case: several reviewers may each leave a note on the same occurrence
// (via SignalFeedbackDialog or DraftEvaluatorDialog's own "Human feedback" field, which now writes
// through to the same table - see feedback.ts) before anyone drafts a test case from it. Pulls
// every recorded note for this specific occurrence so drafting can build on accumulated feedback
// instead of only whatever's typed in the current session.
async function getOccurrenceFeedback(db: Db, signalId: string, occurrenceId?: string): Promise<string[]> {
  if (!occurrenceId) {
    return [];
  }
  const all = await listFeedbackForSignal(db, signalId);
  return all.filter(entry => entry.occurrenceId === occurrenceId).map(entry => entry.rationale);
}

// Drafts the "correct" answer field for DraftEvaluatorDialog's create-evaluator flow (routes/
// agentMonitoringDashboard.ts), given a human reviewer's note on what was actually wrong -
// the same reviewer-voice framing as suggestHumanFeedback above, but proposing the fix rather
// than describing the problem. humanFeedback may be empty if operator feedback already recorded on
// this occurrence is enough to go on - the route only requires that at least one of the two exists.
export async function suggestExpectedResults(
  db: Db,
  signalId: string,
  humanFeedback: string,
  occurrenceId?: string
): Promise<{ expectedResults: string; resolution?: string }> {
  const signal = await getSignal(db, signalId);
  if (!signal) {
    throw new Error("Signal not found");
  }

  const occurrenceFeedback = await getOccurrenceFeedback(db, signalId, occurrenceId);
  if (!humanFeedback.trim() && occurrenceFeedback.length === 0) {
    throw new Error("No feedback available for this occurrence yet");
  }

  const context = resolveOccurrenceContext(signal, occurrenceId);
  const userMessage = [
    "A reviewer flagged this agent response as wrong and explained why. Draft what the agent's ",
    "response SHOULD have said instead - this becomes the expected answer in a golden test case, ",
    "so write the ideal response itself, not a description of the fix.",
    "",
    `Issue: ${context.summary}`,
    context.input !== undefined ? `Original input: ${JSON.stringify(context.input)}` : null,
    context.output !== undefined ? `Original (wrong) output: ${JSON.stringify(context.output)}` : null,
    occurrenceFeedback.length > 0
      ? `Operator feedback already recorded on this exact occurrence:\n${occurrenceFeedback.map(f => `- ${f}`).join("\n")}`
      : null,
    humanFeedback.trim() ? `Reviewer's explanation: ${humanFeedback.trim()}` : null,
    "",
    'Respond with JSON {"expectedResults": "...", "resolution": "one-sentence summary of the fix"}.',
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const result = await callJudgeJson({ model: DEFAULT_JUDGE_MODEL, jsonSchema: expectedResultsSchema, userMessage });
  const payload = result.payload as { expectedResults?: string; resolution?: string } | null;
  if (typeof payload?.expectedResults !== "string" || !payload.expectedResults.trim()) {
    throw new Error("Judge model did not return usable expected results");
  }
  return { expectedResults: payload.expectedResults.trim(), resolution: payload.resolution?.trim() };
}
