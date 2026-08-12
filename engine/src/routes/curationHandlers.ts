import type { Request, Response } from "express";
import { scopedDb } from "../auth/apiKey.js";
import {
  previewCaseFromTrace,
  previewCaseFromSession,
  suggestExpected,
  addCaseToDataset,
  type CuratedCase,
} from "../core/evaluate/curation.js";

// Curation's three handlers, shared verbatim between the SDK-facing evaluations router
// (/custom-agent-evaluations, for scripts and a future SDK method) and the dashboard router
// (/evaluate, what the Add-to-dataset dialog calls) - same contract on both mounts, defined once.

export async function handleCasePreview(req: Request, res: Response) {
  const { traceId, sessionId } = req.body ?? {};
  if (typeof traceId !== "string" && typeof sessionId !== "string") {
    res.status(400).json({ error: "traceId or sessionId is required" });
    return;
  }
  const preview =
    typeof traceId === "string"
      ? await previewCaseFromTrace(scopedDb(req), traceId)
      : await previewCaseFromSession(scopedDb(req), sessionId as string);
  if (!preview) {
    res.status(404).json({ error: "No usable turns found for that trace/session" });
    return;
  }
  res.status(200).json(preview);
}

export async function handleSuggestExpected(req: Request, res: Response) {
  const { query, actualOutput, error, judgeModel } = req.body ?? {};
  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  try {
    const suggestion = await suggestExpected({
      query,
      actualOutput: typeof actualOutput === "string" ? actualOutput : undefined,
      error: typeof error === "string" ? error : undefined,
      judgeModel: typeof judgeModel === "string" ? judgeModel : undefined,
    });
    res.status(200).json(suggestion);
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleAddCase(req: Request, res: Response) {
  const body = (req.body ?? {}) as { case?: CuratedCase; dedupe?: boolean };
  const curated = body.case;
  const query = curated?.main_question?.query;
  if (typeof query !== "string" || !query.trim() || !curated?.source) {
    res.status(400).json({ error: "case with main_question.query and source is required" });
    return;
  }
  const result = await addCaseToDataset(
    scopedDb(req),
    req.params.id!,
    {
      main_question: {
        query,
        expectedResults:
          typeof curated.main_question.expectedResults === "string" ? curated.main_question.expectedResults : null,
      },
      follow_up_questions: (Array.isArray(curated.follow_up_questions) ? curated.follow_up_questions : [])
        .filter(f => typeof f?.query === "string" && f.query.trim())
        .map(f => ({
          query: f.query,
          expectedResults: typeof f.expectedResults === "string" ? f.expectedResults : null,
        })),
      source: {
        traceId: typeof curated.source.traceId === "string" ? curated.source.traceId : undefined,
        sessionId: typeof curated.source.sessionId === "string" ? curated.source.sessionId : undefined,
        signalId: typeof curated.source.signalId === "string" ? curated.source.signalId : undefined,
        addedAt: new Date().toISOString(),
      },
    },
    { dedupe: body.dedupe !== false }
  );
  if (!result.ok && "error" in result) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }
  if (!result.ok) {
    res.status(409).json({ error: "Duplicate case", duplicate: result.duplicate });
    return;
  }
  res.status(201).json(result);
}
