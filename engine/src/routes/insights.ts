import type { Request, Response } from "express";
import { z } from "zod";
import { asyncRouter } from "./asyncRouter.js";
import { validateBody } from "./validateBody.js";
import { scopedDb } from "../auth/apiKey.js";
import { curateCasesFromTraces, getCoverage } from "../core/insights/coverage.js";
import { probe, probeBatch } from "../core/insights/probe.js";
import type { MonitoringWindow } from "../core/monitor/events.js";

// Insights: how well the evaluation datasets cover what production actually does. Reads report
// gaps; the ONE write (POST /topics/curate, the rail's "Generate N cases from traces") fills a
// gap through the same preview -> append path routes/evaluateDashboard.ts uses - dedupe and
// version history included, expectedResults left for a human - so a generated case is exactly
// what the manual flow would have produced, and coverage cannot be inflated past the dedupe.

export const insightsRouter = asyncRouter();

const WINDOWS: MonitoringWindow[] = ["24h", "7d", "30d"];

// 30d, where the monitoring surfaces default to 7d. Those charts are about recent health, so a
// short window is the point; coverage is accumulated test debt, and classification is sampled, so
// a 7d window is routinely empty on an install whose 30d window is full - which reads as "no data"
// rather than "look further back". Callers can still ask for 24h/7d explicitly.
function parseWindow(req: Request): MonitoringWindow {
  const raw = String(req.query.window ?? "30d");
  return (WINDOWS as string[]).includes(raw) ? (raw as MonitoringWindow) : "30d";
}

// Accepts `datasetId` or `datasetIds`, each repeated or comma-separated. Both spellings because the
// response field is `datasetIds` and a client that mirrors the name it reads back would otherwise be
// ignored in silence - answered project-wide with no error to say the scope was dropped.
function datasetIdsOf(req: Request): string[] {
  const raw = [req.query.datasetId, req.query.datasetIds];
  return raw
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
}

// Same reasoning on the POST bodies: an older caller sending the single `datasetId` must not be
// silently answered project-wide, which is the one wrong answer the probe exists to avoid.
const datasetScope = {
  datasetIds: z.array(z.string().trim().min(1)).optional(),
  datasetId: z.string().trim().min(1).optional(),
};
const scopeOf = (body: { datasetIds?: string[]; datasetId?: string }): string[] | undefined =>
  body.datasetIds?.length ? body.datasetIds : body.datasetId ? [body.datasetId] : undefined;

// The sweep: three headline numbers, the topic list with its state, and the off-map cases.
insightsRouter.get("/coverage", async (req: Request, res: Response) => {
  res.status(200).json(await getCoverage(scopedDb(req), { window: parseWindow(req), datasetIds: datasetIdsOf(req) }));
});

const probeSchema = z
  .object({
    query: z.string().trim().min(1, "query is required"),
    window: z.enum(["24h", "7d", "30d"]).optional(),
    ...datasetScope,
  })
  .strip();

// POST rather than GET despite being a read: the query is free text a user typed, and putting it
// in a URL would leak it into access logs and browser history.
insightsRouter.post("/probe", validateBody(probeSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof probeSchema>;
  res.status(200).json(
    await probe(scopedDb(req), { query: body.query, window: body.window ?? "30d", datasetIds: scopeOf(body) })
  );
});

const probeBatchSchema = z
  .object({
    queries: z.array(z.string()).min(1, "queries must contain at least one entry").max(50),
    window: z.enum(["24h", "7d", "30d"]).optional(),
    ...datasetScope,
  })
  .strip();

insightsRouter.post("/probe/batch", validateBody(probeBatchSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof probeBatchSchema>;
  res.status(200).json(
    await probeBatch(scopedDb(req), { queries: body.queries, window: body.window ?? "30d", datasetIds: scopeOf(body) })
  );
});

const curateSchema = z.object({
  topic: z.string().min(1),
  datasetId: z.string().min(1),
  window: z.enum(["24h", "7d", "30d"]).optional(),
  // Bounded: "fill the whole target" is at most a dozen cases; anything larger is a bulk import,
  // which has its own surface.
  limit: z.number().int().min(1).max(12).optional(),
});

insightsRouter.post("/topics/curate", validateBody(curateSchema), async (req: Request, res: Response) => {
  const body = req.body as z.infer<typeof curateSchema>;
  const result = await curateCasesFromTraces(scopedDb(req), {
    topic: body.topic,
    datasetId: body.datasetId,
    window: body.window ?? "30d",
    limit: body.limit ?? 6,
  });
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.status(200).json(result);
});

