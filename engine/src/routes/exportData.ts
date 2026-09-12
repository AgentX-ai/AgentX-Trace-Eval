import { logger } from "../log.js";
import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import { scopedDb } from "../auth/apiKey.js";
import {
  EXPORT_BATCH,
  EXPORT_ENTITIES,
  countExportRows,
  exportKeyName,
  fetchExportBatch,
  isExportEntity,
  type ExportEntity,
} from "../core/export/exportData.js";

// Bulk export (P2.1): GET /export lists what's exportable with live row counts; GET
// /export/:entity streams the rows as NDJSON (one JSON object per line, exactly the stored
// shape - timestamps serialize as ISO-8601). `?since=` takes any ISO date for incremental
// pulls. Project-scoped like every data-plane route: the API key IS the project selection, so
// an export can never cross a tenant boundary. On restore: re-POSTing exported traces to
// /ingest is LOSSY - rows get new ids and restore-time timestamps, and everything keyed on the
// old trace ids (outcome reports, review labels, monitor events) ends up orphaned. Database-
// level restore (pg_dump / SQLite file copy) is the fidelity path; this export exists for
// portability and offline analysis. There is deliberately no blind row-level import endpoint
// that could corrupt engine-owned invariants (dedupe, id uniqueness, derived agent rows).
export const exportRouter = asyncRouter();

// `?since=` parsing shared by both handlers. Returns undefined (after answering 400) when the
// value is present but not a date.
function parseSince(req: Request, res: Response): Date | null | undefined {
  if (typeof req.query.since === "string" && req.query.since) {
    const since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "since must be an ISO-8601 date" });
      return undefined;
    }
    return since;
  }
  return null;
}

exportRouter.get("/", async (req: Request, res: Response) => {
  // `?since=` works on the manifest too, so an incremental pull can see what a `?since=`
  // stream will actually contain before fetching it.
  const since = parseSince(req, res);
  if (since === undefined) {
    return;
  }
  const db = scopedDb(req);
  // Counts are independent reads - run them concurrently rather than one entity at a time.
  const entities = await Promise.all(
    (Object.keys(EXPORT_ENTITIES) as ExportEntity[]).map(async entity => ({
      entity,
      rows: await countExportRows(db, entity, since),
      path: `/api/v1/export/${entity}`,
    }))
  );
  res.status(200).json({ generatedAt: new Date().toISOString(), format: "ndjson", entities });
});

exportRouter.get("/:entity", async (req: Request, res: Response) => {
  const entity = req.params.entity ?? "";
  if (!isExportEntity(entity)) {
    res.status(404).json({ error: `Unknown export entity "${entity}"`, entities: Object.keys(EXPORT_ENTITIES) });
    return;
  }
  const since = parseSince(req, res);
  if (since === undefined) {
    return;
  }
  const db = scopedDb(req);
  res.status(200);
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${entity}.ndjson"`);

  let cursor: string | null = null;
  try {
    for (;;) {
      if (res.destroyed) {
        // Client went away (Ctrl-C on curl, closed tab) - stop paging, release everything.
        return;
      }
      const batch = await fetchExportBatch(db, entity, since, cursor);
      for (const row of batch) {
        // Respect socket backpressure so a huge table never balloons the response buffer.
        // Wait on drain OR close: a destroyed socket never drains, and waiting only on
        // drain leaked this handler (and its DB cursor loop) for the process lifetime on
        // every aborted export. Whichever fires removes the other - once() only cleans up
        // the listener that ran, and a long export pauses here thousands of times, so the
        // losers otherwise pile up until the emitter warns (and leak per pause).
        if (!res.write(`${JSON.stringify(row)}\n`)) {
          await new Promise<void>(resolve => {
            const onDrain = () => {
              res.off("close", onClose);
              resolve();
            };
            const onClose = () => {
              res.off("drain", onDrain);
              resolve();
            };
            res.once("drain", onDrain);
            res.once("close", onClose);
          });
          if (res.destroyed) {
            return;
          }
        }
      }
      if (batch.length < EXPORT_BATCH) {
        break;
      }
      // Keyed on the entity's cursor column - evaluation-analyses has no `id`, and a cursor of
      // String(undefined) would page forever.
      cursor = String(batch[batch.length - 1]![exportKeyName(entity)]);
    }
    res.end();
  } catch (err) {
    // Headers are already committed (200 + attachment): a clean end here would hand the
    // operator a silently TRUNCATED backup - the one failure a backup surface must never
    // hide. Destroy the socket so the client sees a broken transfer instead.
    logger.error({ err, entity }, "Export stream failed mid-flight - destroying the response");
    res.destroy(err instanceof Error ? err : new Error("export failed"));
  }
});
