import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import {
  callModelWithTools,
  callJudgeJson,
  scoreAgainstCriteria,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_PROMPT,
  type ToolCallTrace,
} from "./judge.js";
import { getEvaluationSettingsRow } from "./evaluationSettings.js";
import { ingestTrace } from "../trace/ingest.js";
import type { PlaygroundMessage, PlaygroundTool } from "./playground.js";

// Conversation simulation: a simulated USER (persona + goal, its own model) converses with the
// prompt/model/tools under test for up to maxTurns, so multi-turn behavior - context retention,
// goal completion, tool use across turns - is testable before production traffic exists. The
// agent side is exactly a Playground run per turn (same callModelWithTools + schema-only tool
// simulation via the caller-supplied tool runner), and each turn is recorded through the real
// ingest path under one sim-<id> session, so everything session-shaped downstream lights up for
// free: the Sessions table, the coherence sweep, session-scoped evaluators, "Add to dataset"
// from the session view. metadata.simulated=true marks every recorded trace so simulated
// sessions are always tellable apart from real traffic.

const MAX_TURNS_CAP = 10;
const DEFAULT_MAX_TURNS = 6;

const USER_TURN_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The user's next message, in the persona's own voice. Empty string when done is true.",
    },
    done: {
      type: "boolean",
      description: "true when the conversation should end - the goal was achieved, or the persona would realistically give up.",
    },
    outcome: {
      type: "string",
      enum: ["goal_achieved", "gave_up", "continuing"],
      description: "Why the conversation ended, or 'continuing' when done is false.",
    },
    note: { type: "string", description: "One sentence on why the persona is done (empty when continuing)." },
  },
  required: ["message", "done", "outcome", "note"],
};

type UserTurn = { message: string; done: boolean; outcome: "goal_achieved" | "gave_up" | "continuing"; note: string };

async function simulateUserTurn(
  userModel: string,
  persona: string,
  goal: string,
  history: { role: "user" | "assistant"; content: string }[],
  turnsLeft: number
): Promise<UserTurn> {
  const transcript = history.length
    ? history.map(m => `${m.role === "user" ? "You" : "Agent"}: ${m.content}`).join("\n\n")
    : "(conversation has not started - write the opening message)";
  const userMessage = `You are role-playing a USER talking to an AI agent. Stay fully in character - message the agent the way this person actually would (tone, patience, level of detail), never as an evaluator.

Persona: ${persona}

Your goal in this conversation: ${goal}

Conversation so far:
${transcript}

You have at most ${turnsLeft} more message${turnsLeft === 1 ? "" : "s"}. Write your next message. Set done=true only when the goal has genuinely been achieved (outcome=goal_achieved) or this persona would realistically walk away unsatisfied (outcome=gave_up) - do not end early just to be polite, and do not keep going once the goal is clearly met.`;

  const result = await callJudgeJson({
    model: userModel,
    jsonSchema: USER_TURN_SCHEMA,
    userMessage,
    maxTokens: 800,
  });
  const payload = result.payload as Partial<UserTurn> | null;
  if (!payload || typeof payload.message !== "string") {
    throw new Error("The simulated user model did not return a usable turn");
  }
  return {
    message: payload.message,
    done: payload.done === true,
    outcome: payload.outcome === "goal_achieved" || payload.outcome === "gave_up" ? payload.outcome : "continuing",
    note: typeof payload.note === "string" ? payload.note : "",
  };
}

export type SimulationInput = {
  model: string;
  // Fixed prefix, same convention as PlaygroundRunInput.messages (first system message is the
  // system prompt; the conversation's turns are appended after it each round).
  messages: PlaygroundMessage[];
  persona: string;
  goal: string;
  maxTurns?: number;
  // The simulated user's own model - defaults to the engine's judge default, deliberately allowed
  // to differ from the agent model under test.
  userModel?: string;
  tools?: PlaygroundTool[];
  // Optional: score the finished transcript against an Evaluator config's criteria.
  evaluationSettingsId?: string;
  // Trace/agent name for the recorded session - defaults to "playground-simulation" so simulated
  // sessions never masquerade as a real agent unless the caller opts in.
  agentName?: string;
  // record=false runs compute-only (no traces written), for quick iteration on a persona.
  record?: boolean;
  maxTokens?: number;
  temperature?: number;
};

export type SimulationTurn = {
  userMessage: string;
  agentMessage: string | null;
  toolCalls?: ToolCallTrace[];
  latencyMs: number | null;
  error: string | null;
};

export type SimulationResult = {
  sessionId: string | null;
  turns: SimulationTurn[];
  outcome: "goal_achieved" | "gave_up" | "max_turns" | "error";
  outcomeNote: string | null;
  rating: number | null;
  justification: string | null;
  error: string | null;
};

export async function runConversationSimulation(
  db: Db,
  input: SimulationInput,
  callTool: (tools: PlaygroundTool[], name: string, args: Record<string, unknown>) => Promise<unknown>,
  // Live-progress hook: called the moment each turn completes (the streaming route forwards it
  // to the dashboard as an SSE event, so the transcript renders turn by turn).
  onTurn?: (turn: SimulationTurn, index: number) => void
): Promise<SimulationResult> {
  const maxTurns = Math.max(1, Math.min(MAX_TURNS_CAP, input.maxTurns ?? DEFAULT_MAX_TURNS));
  const userModel = input.userModel?.trim() || DEFAULT_JUDGE_MODEL;
  const record = input.record !== false;
  const sessionId = record ? `sim-${nanoid(12)}` : null;
  const agentName = input.agentName?.trim() || "playground-simulation";
  const tools = input.tools ?? [];

  const [first, ...rest] = input.messages;
  const system = first?.role === "system" ? first.content : undefined;
  const prefixTurns = (first?.role === "system" ? rest : input.messages).filter(
    (m): m is PlaygroundMessage & { role: "user" | "assistant" } => m.role !== "system"
  );

  const turns: SimulationTurn[] = [];
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let outcome: SimulationResult["outcome"] = "max_turns";
  let outcomeNote: string | null = null;

  for (let i = 0; i < maxTurns; i++) {
    // The simulated user speaks first each round and may instead declare the conversation over.
    let userTurn: UserTurn;
    try {
      userTurn = await simulateUserTurn(userModel, input.persona, input.goal, history, maxTurns - i);
    } catch (err) {
      return {
        sessionId: turns.length > 0 ? sessionId : null,
        turns,
        outcome: "error",
        outcomeNote: null,
        rating: null,
        justification: null,
        error: err instanceof Error ? err.message : "Simulated user failed",
      };
    }
    if (userTurn.done) {
      outcome = userTurn.outcome === "gave_up" ? "gave_up" : "goal_achieved";
      outcomeNote = userTurn.note || null;
      break;
    }

    const turn: SimulationTurn = { userMessage: userTurn.message, agentMessage: null, latencyMs: null, error: null };
    const start = Date.now();
    try {
      const completion = await callModelWithTools(
        input.model,
        { system, messages: [...prefixTurns, ...history, { role: "user", content: userTurn.message }] },
        tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
        (name, args) => callTool(tools, name, args),
        { maxTokens: input.maxTokens, temperature: input.temperature }
      );
      turn.latencyMs = Date.now() - start;
      turn.agentMessage = completion.text;
      if (completion.toolCalls.length > 0) turn.toolCalls = completion.toolCalls;

      if (record && sessionId) {
        // Through the real ingest path, not a raw insert - agent resolution, session grouping,
        // and every downstream reader behave exactly as they would for genuine traffic.
        await ingestTrace(db, {
          name: agentName,
          input: { query: userTurn.message },
          output: completion.text,
          latency_ms: turn.latencyMs,
          model: input.model,
          session_id: sessionId,
          tool_calls: completion.toolCalls.length > 0 ? (completion.toolCalls as unknown as Record<string, unknown>[]) : undefined,
          input_tokens: completion.usage?.inputTokens,
          output_tokens: completion.usage?.outputTokens,
          metadata: { simulated: true, persona: input.persona, goal: input.goal },
        });
      }
    } catch (err) {
      turn.error = err instanceof Error ? err.message : "Agent call failed";
      turns.push(turn);
      try {
        onTurn?.(turn, turns.length - 1);
      } catch {
        // A broken client stream must never abort the simulation itself.
      }
      return {
        sessionId,
        turns,
        outcome: "error",
        outcomeNote: null,
        rating: null,
        justification: null,
        error: turn.error,
      };
    }
    turns.push(turn);
    try {
      onTurn?.(turn, turns.length - 1);
    } catch {
      // See above.
    }
    history.push({ role: "user", content: turn.userMessage });
    history.push({ role: "assistant", content: turn.agentMessage ?? "" });
  }

  // Optional whole-transcript scoring against an Evaluator config - reference-free by
  // construction (a simulated conversation has no expected answer), so the default prompt case
  // routes through scoreAgainstCriteria's reference-free path.
  let rating: number | null = null;
  let justification: string | null = null;
  if (input.evaluationSettingsId && turns.length > 0) {
    const settings = await getEvaluationSettingsRow(db, input.evaluationSettingsId);
    if (settings) {
      try {
        const transcript = turns
          .map((t, i) => `[turn ${i + 1}] User: ${t.userMessage}\nAgent: ${t.agentMessage ?? "(no reply)"}`)
          .join("\n\n");
        const scored = await scoreAgainstCriteria(
          {
            acceptanceCriteria: settings.acceptanceCriteria ?? "",
            rejectionCriteria: settings.rejectionCriteria ?? "",
            evaluationCriteria: settings.evaluationCriteria ?? "",
            judgePrompt: (settings.judgePrompt ?? "").trim() || DEFAULT_JUDGE_PROMPT,
            judgeModel: settings.judgeModel ?? DEFAULT_JUDGE_MODEL,
          },
          { input: `Persona: ${input.persona}\nGoal: ${input.goal}`, output: transcript }
        );
        rating = scored.rating;
        justification = scored.justification;
      } catch (err) {
        justification = `Scoring failed: ${err instanceof Error ? err.message : "unknown error"}`;
      }
    }
  }

  return {
    sessionId: turns.length > 0 ? sessionId : null,
    turns,
    outcome,
    outcomeNote,
    rating,
    justification,
    error: null,
  };
}
