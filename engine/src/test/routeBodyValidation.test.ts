import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A ratchet for CONTRIBUTING.md's body-validation rule, in the same spirit as the coverage floors
// in .github/workflows/test.yml: it does not demand the codebase already be clean, it demands the
// debt only ever shrink.
//
// The rule ("new/changed routes validate with validateBody(schema) ... Never the silent
// typeof-skip pattern it replaced") is real and load-bearing, because the pattern it replaced
// fails silently: a mistyped field is IGNORED rather than rejected, so a caller believes a setting
// was applied while nothing changed. That is the same class of bug as the placebo knobs the same
// document bans. But the rule was reviewer-enforced only, and reviewer-enforced rules decay: at
// the time this test was written 8 of 94 mutating routes used validateBody and the other 86 still
// carried hand-rolled typeof checks. Nothing failed, because nothing was checking.
//
// So: the list below is the frozen inventory of that debt. Adding a mutating route without
// validateBody fails this test, and converting one fails it too until the entry is deleted. The
// list is allowed to shrink and never to grow.

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(here, "../routes");

// Not debt: endpoints whose body is not JSON that a zod schema could describe. OTLP/HTTP takes
// protobuf (routes/otlp.ts mounts express.raw for it) or an OTLP-shaped JSON envelope, and does
// its own content-type gate and decode; there is no request-shaped schema to apply.
const EXEMPT = new Set(["otlp.ts POST /v1/traces"]);

// Frozen 2026-08. Delete an entry when its route moves to validateBody(); never add one.
const KNOWN_UNVALIDATED = [
  "agentMonitoringDashboard.ts PATCH /profiles/:agentId/approval-policy",
  "agentMonitoringDashboard.ts POST /agents",
  "agentMonitoringDashboard.ts POST /custom-evaluators",
  "agentMonitoringDashboard.ts POST /custom-evaluators/dry-run",
  "agentMonitoringDashboard.ts POST /estimate",
  "agentMonitoringDashboard.ts POST /judge-scorers",
  "agentMonitoringDashboard.ts POST /judge-scorers/preview-score",
  "agentMonitoringDashboard.ts POST /online-evaluators",
  "agentMonitoringDashboard.ts POST /online-evaluators/:evaluatorId/tune",
  "agentMonitoringDashboard.ts POST /online-evaluators/:evaluatorId/tune/publish",
  "agentMonitoringDashboard.ts POST /online-evaluators/:evaluatorId/tune/validate",
  "agentMonitoringDashboard.ts POST /patterns",
  "agentMonitoringDashboard.ts POST /patterns/generate-regex",
  "agentMonitoringDashboard.ts POST /portability/models",
  "agentMonitoringDashboard.ts POST /portability/models/test-connection",
  "agentMonitoringDashboard.ts POST /session-sweep/run",
  "agentMonitoringDashboard.ts POST /sessions/:sessionId/coherence-check",
  "agentMonitoringDashboard.ts POST /sessions/:sessionId/judge/:evaluatorId",
  "agentMonitoringDashboard.ts POST /settings/api-key/regenerate",
  "agentMonitoringDashboard.ts POST /signals/:signalId/create-evaluator",
  "agentMonitoringDashboard.ts POST /signals/:signalId/feedback",
  "agentMonitoringDashboard.ts POST /signals/:signalId/suggest-expected-results",
  "agentMonitoringDashboard.ts POST /signals/:signalId/suggest-human-feedback",
  "agentMonitoringDashboard.ts POST /traces/:traceId/portability",
  "agentMonitoringDashboard.ts PUT /custom-evaluators/:evaluatorId",
  "agentMonitoringDashboard.ts PUT /judge-scorers/:id",
  "agentMonitoringDashboard.ts PUT /online-evaluators/:evaluatorId",
  "agentMonitoringDashboard.ts PUT /patterns/:patternId",
  "agentMonitoringDashboard.ts PUT /portability/models/:id",
  "agentMonitoringDashboard.ts PUT /profiles/:agentId",
  "agentMonitoringDashboard.ts PUT /settings/llm-keys",
  "agents.ts POST /",
  "apiV1.ts POST /projects",
  "authOrg.ts POST /invitations/:id/accept",
  "authOrg.ts POST /organizations/:orgId/invitations",
  "evaluateDashboard.ts PATCH /playground/runs/:id",
  "evaluateDashboard.ts PATCH /prompts/:id",
  "evaluateDashboard.ts PATCH /tool-schemas/:id",
  "evaluateDashboard.ts PATCH /tool-schemas/:id/test-endpoint",
  "evaluateDashboard.ts POST /agent-connectors",
  "evaluateDashboard.ts POST /agent-connectors/test-connection",
  "evaluateDashboard.ts POST /analyze/:id",
  "evaluateDashboard.ts POST /datasets/:datasetId/run-with-connector",
  "evaluateDashboard.ts POST /datasets/:id/cases",
  "evaluateDashboard.ts POST /datasets/case-preview",
  "evaluateDashboard.ts POST /datasets/suggest-expected",
  "evaluateDashboard.ts POST /evaluationSettings/create",
  "evaluateDashboard.ts POST /evaluationSettings/create-standalone",
  "evaluateDashboard.ts POST /improve/inbox/:id/dismiss",
  "evaluateDashboard.ts POST /improve/inbox/:id/publish",
  "evaluateDashboard.ts POST /improve/inbox/sweep/run",
  "evaluateDashboard.ts POST /mcp/tools",
  "evaluateDashboard.ts POST /playground/run",
  "evaluateDashboard.ts POST /playground/runs",
  "evaluateDashboard.ts POST /playground/simulate",
  "evaluateDashboard.ts POST /prompts",
  "evaluateDashboard.ts POST /prompts/:id/proposals/validate",
  "evaluateDashboard.ts POST /prompts/:id/propose",
  "evaluateDashboard.ts POST /prompts/:id/versions",
  "evaluateDashboard.ts POST /synthesize-cases",
  "evaluateDashboard.ts POST /tool-schemas",
  "evaluateDashboard.ts POST /tool-schemas/:id/proposals/validate",
  "evaluateDashboard.ts POST /tool-schemas/:id/propose",
  "evaluateDashboard.ts POST /tool-schemas/:id/versions",
  "evaluateDashboard.ts PUT /agent-connectors/:id",
  "evaluateDashboard.ts PUT /evaluationSettings/:id",
  "evaluations.ts POST /datasets",
  "evaluations.ts POST /datasets/:id/cases",
  "evaluations.ts POST /datasets/case-preview",
  "evaluations.ts POST /datasets/suggest-expected",
  "evaluations.ts POST /evaluation-settings",
  "evaluations.ts POST /prompts",
  "evaluations.ts POST /runs",
  "evaluations.ts POST /runs/:runId/analyze",
  "evaluations.ts POST /runs/:runId/finalize",
  "evaluations.ts POST /runs/:runId/results",
  "feedback.ts POST /",
  "ingest.ts POST /traces",
  "ingest.ts POST /traces/:traceId/evaluate",
  "monitor.ts POST /online-evaluators",
  "monitor.ts POST /patterns",
  "monitor.ts PUT /online-evaluators/:id",
  "monitor.ts PUT /profiles/:agentId",
  "outcomes.ts POST /",
];

type Registration = { key: string; validated: boolean };

// Every mutating registration in routes/ is written the same way: `<router>.post(<path>, ...
// async (req: Request, res: Response) => {`, with any middleware between the path and the handler.
// So "is this route validated" is exactly "does validateBody( appear before the handler opens".
// Source scanning rather than introspecting a booted express app: express 4 exposes middleware
// only through the undocumented router.stack internals that routes/asyncRouter.ts deliberately
// refuses to touch, and a wrapped handler is anonymous there anyway.
const HANDLER_START = /async \(\s*(_?req|_)/;

// Bounded, so a registration with no handler of its own cannot silently borrow the NEXT route's
// and be recorded under the wrong path. The widest real middleware chain in routes/ is a few
// hundred characters; anything past this is a parse failure, not a long chain.
const HANDLER_SEARCH_WINDOW = 1200;

// A `router.post(...)` written inside a line comment is prose, not a route. Without this the
// scanner would try to parse it and fail the suite over a code sample in a comment.
function insideLineComment(src: string, index: number): boolean {
  const lineStart = src.lastIndexOf("\n", index) + 1;
  const commentAt = src.slice(lineStart, index).indexOf("//");
  return commentAt !== -1;
}

function scan(file: string): Registration[] {
  const src = fs.readFileSync(path.join(routesDir, file), "utf8");
  const out: Registration[] = [];
  const registration = /\b[A-Za-z_$][\w$]*\.(post|put|patch)\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = registration.exec(src))) {
    if (insideLineComment(src, match.index)) {
      continue;
    }
    const verb = match[1]?.toUpperCase();
    const rest = src.slice(match.index + match[0].length);
    const handlerAt = rest.slice(0, HANDLER_SEARCH_WINDOW).search(HANDLER_START);
    const pathLiteral = /^\s*(`[^`]*`|"[^"]*"|'[^']*')/.exec(rest)?.[1];
    // A registration the scanner cannot parse would silently drop out of the inventory, which is
    // how a ratchet quietly stops ratcheting. Fail loudly rather than skipping it.
    if (verb === undefined || handlerAt === -1 || pathLiteral === undefined) {
      throw new Error(
        `${file}: could not parse a route registration at offset ${match.index}. The scanner ` +
          `expects <router>.post|put|patch(<literal path>, ...async (req, res) => ...). Teach it ` +
          `the new form rather than letting the route escape the inventory.`
      );
    }
    out.push({
      key: `${file} ${verb} ${pathLiteral.slice(1, -1)}`,
      validated: /validateBody\(/.test(rest.slice(0, handlerAt)),
    });
  }
  return out;
}

function allRegistrations(): Registration[] {
  return fs
    .readdirSync(routesDir)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
    .flatMap(scan);
}

describe("route body validation", () => {
  it("finds the mutating routes at all, so a broken scanner cannot pass vacuously", () => {
    const registrations = allRegistrations();
    // Not an exact count: routes get added. A floor near the inventory this was frozen against is
    // enough to catch a regex that stopped matching anything.
    expect(registrations.length).toBeGreaterThanOrEqual(90);
    expect(registrations.some(r => r.validated)).toBe(true);
  });

  it("adds no new route that skips validateBody", () => {
    const unvalidated = allRegistrations()
      .filter(r => !r.validated && !EXEMPT.has(r.key))
      .map(r => r.key);
    const known = new Set(KNOWN_UNVALIDATED);
    const added = unvalidated.filter(key => !known.has(key));
    expect(
      added,
      "These mutating routes read their body without validateBody(schema). CONTRIBUTING.md " +
        "requires a zod schema on new and changed routes: shape and range in the schema, " +
        "cross-data checks in the handler. Hand-rolled typeof checks ignore a mistyped field " +
        "instead of rejecting it, so the caller is told nothing went wrong."
    ).toEqual([]);
  });

  it("keeps the known-unvalidated list free of entries that are already fixed", () => {
    const stillUnvalidated = new Set(
      allRegistrations()
        .filter(r => !r.validated)
        .map(r => r.key)
    );
    const stale = KNOWN_UNVALIDATED.filter(key => !stillUnvalidated.has(key));
    expect(
      stale,
      "These routes now validate their body, or no longer exist. Delete them from " +
        "KNOWN_UNVALIDATED so the ratchet holds the ground you just gained."
    ).toEqual([]);
  });

  it("lists the known-unvalidated routes exactly once each, in sorted order", () => {
    expect(KNOWN_UNVALIDATED).toEqual([...new Set(KNOWN_UNVALIDATED)].sort());
  });
});
