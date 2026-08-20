import { nanoid } from "nanoid";
import type { Db } from "../../storage/db.js";
import { getDataset } from "./datasets.js";
import { getAgentConnectorRow, callAgentConnector, type AgentConnectorRow } from "./agentConnectors.js";
import { initRun, appendResults, finalizeRun, failRun } from "./runs.js";

// Drives a dataset's questions through a customer's own deployed agent (via an Agent Connector,
// see agentConnectors.ts) instead of requiring the SDK to push pre-computed results - closes the
// gap where offline/sub-prod evaluation only ever worked if a human manually ran the agent and
// called append_results themselves first. Deliberately reuses initRun/appendResults/finalizeRun
// unmodified: once a connector produces an answer, scoring it is identical to an SDK-pushed
// result, so there's no second scoring pipeline to maintain.
type DatasetQuestion = {
  main_question?: { query?: string; expectedResults?: string; judgeGuideline?: string };
  // Multi-turn (threading a connector call per follow-up with conversation history) is
  // deliberately not attempted here yet - v1 only drives each case's main_question through the
  // connector. AgentConnectorRequest already has a conversationHistory field ready for that,
  // left for a follow-up pass rather than scoping it into this change.
  follow_up_questions?: unknown[];
};

// A real agent call is heavy (its own retrieval/tool-use/multiple LLM calls), unlike Custom
// Evaluators' lightweight verdict check - firing every question at once risks tripping the
// customer's own agent's rate limits, same reasoning Playground's grid frontend already applies
// via its own client-side concurrency cap.
const CONNECTOR_RUN_CONCURRENCY = 4;

export type ConnectorRunResult = { runId: string; questionCount: number };

// Fast path only: validates the dataset/connector exist and creates the run row (a single insert,
// same cost as an SDK-driven init_run), then kicks the actual per-question work off in the
// background without awaiting it - a real dataset run can take minutes (one HTTP round-trip per
// question to the customer's own agent), and holding the dashboard's POST request open that long
// risks a client-side timeout for no benefit, since the dashboard already polls GET /:id for an
// in-progress SDK run the same way. Returns the runId immediately so the caller can start polling.
export async function startConnectorRun(
  db: Db,
  datasetId: string,
  connectorId: string
): Promise<ConnectorRunResult | null> {
  const dataset = await getDataset(db, datasetId);
  if (!dataset) {
    return null;
  }
  const connector = await getAgentConnectorRow(db, connectorId);
  if (!connector) {
    return null;
  }

  const initResult = await initRun(db, { datasetId, runSource: "connector" });
  if (!initResult) {
    return null;
  }
  const { runId } = initResult;
  const questions = ((dataset.questions as DatasetQuestion[] | undefined) ?? []).filter(q => q.main_question?.query);

  // Fire-and-forget: driveConnectorRun awaits internally but this call site doesn't, so the HTTP
  // response can return now. Errors are handled inside driveConnectorRun itself (failRun on an
  // unexpected failure) - nothing here should ever reject and become an unhandled rejection.
  void driveConnectorRun(db, runId, questions, connector);

  return { runId, questionCount: questions.length };
}

async function driveConnectorRun(
  db: Db,
  runId: string,
  questions: DatasetQuestion[],
  connector: AgentConnectorRow
): Promise<void> {
  try {
    const batchId = nanoid();
    for (let i = 0; i < questions.length; i += CONNECTOR_RUN_CONCURRENCY) {
      const chunk = questions.slice(i, i + CONNECTOR_RUN_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (question, offsetInChunk) => {
          const questionIndex = i + offsetInChunk;
          const query = question.main_question!.query!;
          // Isolated per-question, same posture as runCustomEvaluators/runOnlineEvaluators - a
          // failing connector call becomes this one question's {error}, never aborts the run.
          try {
            const startedAt = Date.now();
            const response = await callAgentConnector(connector, { query });
            // Everything below is optional on the wire - a connector returning only `output`
            // behaves exactly as before. When it does return a traceId, the result links its
            // trace like an SDK-pushed one, so the judge sees the agent's real execution path.
            const timings = {
              latencyMs: response.latencyMs ?? Date.now() - startedAt,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
            };
            return {
              idempotencyKey: nanoid(),
              questionIndex,
              input: { query },
              output: { text: response.output },
              traceId: response.traceId,
              timings,
            };
          } catch (err) {
            return {
              idempotencyKey: nanoid(),
              questionIndex,
              input: { query },
              error: {
                type: "connector_error",
                message: err instanceof Error ? err.message : "Agent connector call failed",
              },
            };
          }
        })
      );
      await appendResults(db, runId, batchId, results);
    }
    await finalizeRun(db, runId);
  } catch (err) {
    console.error(`Connector-driven run ${runId} failed:`, err instanceof Error ? err.message : err);
    await failRun(db, runId);
  }
}
