import type { NextFunction, Request, Response } from "express";
import { getDb, withProjectId } from "../storage/db.js";
import { resolveProjectByApiKey } from "../core/project/projects.js";
import { runWithTenancy } from "./requestContext.js";

// Multi-project support (core/project/projects.ts): self-host used to have exactly one API key
// for the whole instance (no login, no workspace model - deliberately simple). Now each project
// has its own key, and the key itself is what selects the project - no separate project id is
// ever sent on a call. requireApiKey() resolves the incoming key against the projects table and
// attaches the matching project's id to the request; every downstream route builds its own scoped
// Db from it via withProjectId(getDb(), req.projectId) before calling into project-scoped core
// functions (traces, agents, patterns, datasets, ...).
declare global {
   
  namespace Express {
    interface Request {
      projectId?: string;
    }
  }
}

export function requireApiKey() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header("x-api-key");
    if (!provided) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }
    const project = await resolveProjectByApiKey(getDb(), provided);
    if (!project) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }
    req.projectId = project.id;
    // Tenancy context for everything downstream of this request, including the async passes
    // that outlive the response (see requestContext.ts). next() runs inside the ALS scope so
    // the whole continuation inherits it.
    runWithTenancy({ projectId: project.id, organizationId: project.organizationId ?? null }, () => next());
  };
}

// Small helper for route handlers: the scoped Db a project-authenticated request should pass into
// every project-scoped core function, built fresh per-request (never cached - getDb()'s own
// cached singleton always carries the "" sentinel, see its comment).
export function scopedDb(req: Request) {
  if (!req.projectId) {
    throw new Error("scopedDb() called on a request with no resolved projectId - is this route behind requireApiKey()?");
  }
  return withProjectId(getDb(), req.projectId);
}
