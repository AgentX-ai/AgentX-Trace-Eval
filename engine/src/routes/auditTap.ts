import { secretEquals } from "../auth/secretEquals.js";
import type { NextFunction, Request, Response } from "express";
import { getDb } from "../storage/db.js";
import { recordAuditEvent, type AuditActorType } from "../core/audit/auditLog.js";
import { resolveProjectByApiKey } from "../core/project/projects.js";
import { authMode, getSessionUser } from "../auth/betterAuth.js";
import { logger } from "../log.js";

// The audit tap (P2.2): a response-finish observer that turns control-plane activity into
// append-only audit_events rows (core/audit/auditLog.ts). Two deliberate boundaries:
//
//  - Data plane is NOT audited (/ingest, /otel, /monitor, /feedback, /outcomes, ...): a
//    thousand traces a minute would bury the trail that matters. The one data-plane exception
//    is bulk egress - GET /export/* is exactly what a security team wants in the log.
//  - Values are NOT recorded: bodies carry scripts, keys, and passwords, so a mutation's
//    summary keeps the field NAMES that were sent plus a human-recognizable `name`, never
//    the values. The auth tap keeps only the attempted email (the identity claim itself).
//
// Recording is fire-and-forget on 'finish': an audit failure never fails the request.

const DATA_PLANE_PREFIXES = [
  "/ingest",
  "/otel",
  "/monitor",
  "/custom-agent-evaluations",
  "/feedback",
  "/outcomes",
  "/agents",
];

// Compute/preview POSTs that change no config - auditing them would be noise.
const TRANSIENT_MARKERS = [
  "/dry-run",
  "/generate-regex",
  "/coherence-check",
  "/session-sweep",
  "/suggest-",
  "/estimate",
  "/test-connection",
  "/tune",
  "/validate",
  "/mcp-oauth",
];

const VERB: Record<string, string> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

// Wire path segment -> audit noun. Falls back to the segment itself so new routes are audited
// (generically) the day they land rather than silently skipped.
const NOUN: Record<string, string> = {
  "custom-evaluators": "scorer",
  "online-evaluators": "judge",
  patterns: "pattern",
  profiles: "profile",
  signals: "signal",
  projects: "project",
  "portability/models": "model-endpoint",
};

type Classified = { action: string; entityType: string | null; entityId: string | null };

// Path is relative to the /api/v1 router mount (e.g. "/agent-monitoring/custom-evaluators/x1").
export function classifyControlPlane(method: string, path: string): Classified | null {
  if (method === "GET") {
    if (path === "/export" || path.startsWith("/export/")) {
      return { action: "export.read", entityType: "export", entityId: path.split("/")[2] ?? null };
    }
    return null;
  }
  if (!(method in VERB)) {
    return null;
  }
  if (DATA_PLANE_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))) {
    return null;
  }
  if (TRANSIENT_MARKERS.some(m => path.includes(m))) {
    return null;
  }

  // Named special cases first: the actions a compliance reviewer greps for by name.
  if (path === "/settings/api-key/regenerate" || path.endsWith("/settings/api-key/regenerate")) {
    return { action: "api-key.regenerate", entityType: "project", entityId: null };
  }
  if (path.endsWith("/settings/monitoring-defaults")) {
    return { action: "settings.update", entityType: "settings", entityId: "monitoring-defaults" };
  }
  if (path.endsWith("/settings/llm-keys")) {
    return { action: "llm-keys.update", entityType: "settings", entityId: "llm-keys" };
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  // Drop router prefixes that carry no entity meaning of their own.
  const scoped = segments[0] === "agent-monitoring" || segments[0] === "evaluate" || segments[0] === "auth-org"
    ? segments.slice(1)
    : segments;
  if (scoped.length === 0) {
    return null;
  }
  const two = scoped.slice(0, 2).join("/");
  const nounKey = NOUN[two] ? two : scoped[0]!;
  const noun = NOUN[nounKey] ?? nounKey;
  const idIndex = nounKey.includes("/") ? 2 : 1;
  const entityId = scoped.length > idIndex ? scoped[idIndex]! : null;
  const verb = VERB[method]!;
  return { action: `${noun}.${verb}`, entityType: noun, entityId };
}

function safeSummary(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const fields = Object.keys(record).slice(0, 30);
  if (fields.length === 0) {
    return null;
  }
  return {
    fields,
    ...(typeof record.name === "string" ? { name: record.name.slice(0, 200) } : {}),
  };
}

async function resolveActor(req: Request): Promise<{ actor: string; actorType: AuditActorType }> {
  const adminToken = process.env.AGENTX_ADMIN_TOKEN;
  if (adminToken && secretEquals(req.header("x-admin-token"), adminToken)) {
    return { actor: "admin", actorType: "admin" };
  }
  if (req.projectId) {
    return { actor: `project:${req.projectId}`, actorType: "project-key" };
  }
  // /projects handlers resolve the key themselves rather than through requireApiKey.
  const key = req.header("x-api-key");
  if (key) {
    const project = await resolveProjectByApiKey(getDb(), key).catch(() => null);
    if (project) {
      return { actor: `project:${project.id}`, actorType: "project-key" };
    }
  }
  if (authMode() === "enabled") {
    const user = await getSessionUser(req).catch(() => null);
    if (user?.email) {
      return { actor: user.email, actorType: "user" };
    }
  }
  return { actor: "anonymous", actorType: "anonymous" };
}

export function auditControlPlaneTap(req: Request, res: Response, next: NextFunction): void {
  const classified = classifyControlPlane(req.method, req.path);
  if (!classified) {
    next();
    return;
  }
  const summary = req.method === "GET" ? null : safeSummary(req.body);
  res.on("finish", () => {
    void (async () => {
      const { actor, actorType } = await resolveActor(req);
      await recordAuditEvent(getDb(), {
        actor,
        actorType,
        action: classified.action,
        method: req.method,
        path: req.originalUrl.split("?")[0] ?? req.path,
        status: res.statusCode,
        entityType: classified.entityType,
        entityId: classified.entityId,
        summary,
        ip: req.ip ?? null,
        projectId: req.projectId ?? null,
      });
    })().catch((err: unknown) => logger.error({ err }, "Audit tap failed (request unaffected)"));
  });
  next();
}

// Auth events: mounted BEFORE better-auth's handler (and before express.json - better-auth
// reads the raw stream itself), so the body is sniffed passively from 'data' events, capped,
// and only the attempted email is kept. Failed and successful attempts both land, with status.
const AUTH_ACTIONS: [RegExp, string][] = [
  [/\/sign-in\b/, "auth.sign-in"],
  [/\/sign-up\b/, "auth.sign-up"],
  [/\/sign-out\b/, "auth.sign-out"],
  [/\/forget-password\b/, "auth.forget-password"],
  [/\/reset-password\b/, "auth.reset-password"],
  [/\/callback\//, "auth.oauth-callback"],
];

export function auditAuthTap(req: Request, res: Response, next: NextFunction): void {
  const match = AUTH_ACTIONS.find(([re]) => re.test(req.path));
  if (!match || (req.method !== "POST" && !match[1].endsWith("oauth-callback"))) {
    next();
    return;
  }
  const action = match[1];
  let sniffed = "";
  if (req.method === "POST") {
    req.on("data", chunk => {
      if (sniffed.length < 8192) {
        sniffed += String(chunk);
      }
    });
  }
  res.on("finish", () => {
    void (async () => {
      let email: string | null = null;
      try {
        const parsed = JSON.parse(sniffed || "{}");
        if (typeof parsed.email === "string") {
          email = parsed.email.slice(0, 200);
        }
      } catch {
        // body wasn't JSON (or was truncated) - the event still records without an email
      }
      await recordAuditEvent(getDb(), {
        actor: email ?? "anonymous",
        // A successful attempt with an email IS that user acting; anything else stays anonymous
        // (failed attempts are the rows a security review reads most closely).
        actorType: email && res.statusCode < 400 ? "user" : "anonymous",
        action,
        method: req.method,
        path: req.originalUrl.split("?")[0] ?? req.path,
        status: res.statusCode,
        summary: email ? { email } : null,
        ip: req.ip ?? null,
      });
    })().catch((err: unknown) => logger.error({ err }, "Auth audit tap failed (request unaffected)"));
  });
  next();
}
