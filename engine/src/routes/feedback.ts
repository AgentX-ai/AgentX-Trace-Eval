import { Router, type Request, type Response } from "express";
import { scopedDb } from "../auth/apiKey.js";
import { recordUserFeedback, listFeedbackForTrace } from "../core/monitor/userFeedback.js";

// Mounted at /api/v1/feedback - end-user thumbs on a traced response, forwarded by the
// customer's own app (or sent via the SDK's client.feedback.report). Sibling of /outcomes and
// deliberately separate from it: an outcome is an after-the-fact system result ("ticket
// reopened"), feedback is a human reaction with vote semantics ("up"/"down") plus its own
// signal-raising behavior - see core/monitor/userFeedback.ts for what one report fans out into.
export const feedbackRouter = Router();

feedbackRouter.post("/", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body.traceId !== "string" || !body.traceId.trim()) {
    res.status(400).json({ error: "traceId is required" });
    return;
  }
  if (body.rating !== "up" && body.rating !== "down") {
    res.status(400).json({ error: 'rating must be "up" or "down"' });
    return;
  }
  const feedback = await recordUserFeedback(scopedDb(req), {
    traceId: body.traceId,
    rating: body.rating,
    comment: typeof body.comment === "string" ? body.comment : undefined,
    endUserId: typeof body.endUserId === "string" ? body.endUserId : undefined,
  });
  if (!feedback) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.status(201).json({ feedback });
});

feedbackRouter.get("/trace/:traceId", async (req: Request, res: Response) => {
  res.status(200).json({ feedback: await listFeedbackForTrace(scopedDb(req), req.params.traceId!) });
});
