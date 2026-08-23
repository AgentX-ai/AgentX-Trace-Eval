import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import {
  EXPORT_BATCH,
  EXPORT_ENTITIES,
  countExportRows,
  fetchExportBatch,
  isExportEntity,
  type ExportEntity,
} from "../core/export/exportData.js";

// Bulk export (P2.1): GET /export lists what's exportable with live row counts; GET
// /export/:entity streams the rows as NDJSON (one JSON object per line, exactly the stored
// shape - timestamps serialize as ISO-8601). `?since=` takes any ISO date for incremental
// pulls. Project-scoped like every data-plane route: the API key IS the project selection, so
// an export can never cross a tenant boundary. Restore is documented in the self-host backup
// runbook: replay (traces re-POST through /ingest) or database-level (pg_dump / SQLite file
// copy) - there is deliberately no blind row-level import endpoint that could corrupt
// engine-owned invariants (dedupe, id uniqueness, derived agent rows).
export const exportRouter = asyncRouter();

exportRouter.get("/", async (req: Request, res: Response) => {
  const db = scopedDb(req);
  const entities = [];
  for (const entity of Object.keys(EXPORT_ENTITIES) as ExportEntity[]) {
    entities.push({ entity, rows: await countExportRows(db, entity), path: `/api/v1/export/${entity}` });
  }
  res.status(200).json({ generatedAt: new Date().toISOString(), format: "ndjson", entities });
});

exportRouter.get("/:entity", async (req: Request, res: Response) => {
  const entity = req.params.entity ?? "";
  if (!isExportEntity(entity)) {
    res.status(404).json({ error: `Unknown export entity "${entity}"`, entities: Object.keys(EXPORT_ENTITIES) });
    return;
  }
  let since: Date | null = null;
  if (typeof req.query.since === "string" && req.query.since) {
    since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "since must be an ISO-8601 date" });
      return;
    }
  }
  const db = scopedDb(req);
  res.status(200);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${entity}.ndjson"`);

  let cursor: string | null = null;
  for (;;) {
    const batch = await fetchExportBatch(db, entity, since, cursor);
    for (const row of batch) {
      // Respect socket backpressure so a huge table never balloons the response buffer.
      if (!res.write(`${JSON.stringify(row)}\n`)) {
        await new Promise<void>(resolve => res.once("drain", () => resolve()));
      }
    }
    if (batch.length < EXPORT_BATCH) {
      break;
    }
    cursor = String(batch[batch.length - 1]!.id);
  }
  res.end();
});
