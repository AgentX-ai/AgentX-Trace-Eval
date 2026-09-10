import rateLimitMiddleware from "express-rate-limit";
import type { RequestHandler } from "express";

// Two ceilings, because the two surfaces fail in opposite directions. The credential surface -
// sign-in, sign-up, anything that hands out or is guarded by a project API key - is where an
// unbounded request rate is worth something to an attacker: guessing a 48-character key or a
// password is only viable at volume. The data plane is the opposite, since throttling ingest
// drops the telemetry this engine exists to keep, so its ceiling sits far above any real SDK
// burst and exists only to bound a key-guessing loop against requireApiKey.
//
// Per-process and per-IP: a restart clears the counters and several replicas each keep their own.
// That is the right trade for a self-hosted single binary, and it still removes the "unlimited
// attempts from one host" property. AGENTX_RATE_LIMIT=off disables it entirely, and both ceilings
// are env-tunable, for an operator whose real volume outruns the default.
const WINDOW_MS = 60_000;

// A non-numeric override ("1k", a stray unit) must fall back to the default WITH a warning,
// not silently disable the limiter - fail-open on a typo is the exact property this module
// exists to remove from the credential surface. Explicit <= 0 remains the intentional off.
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    // eslint-disable-next-line no-console -- boot-time misconfiguration warning, logger not imported here to keep this module dependency-free
    console.warn(`${name}="${raw}" is not a number - using the default of ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const CREDENTIAL_LIMIT = envLimit("AGENTX_RATE_LIMIT_CREDENTIAL", 120);
export const DATA_PLANE_LIMIT = envLimit("AGENTX_RATE_LIMIT_DATA_PLANE", 6000);

export function rateLimit(limit: number): RequestHandler {
  return rateLimitMiddleware({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Each call builds its own store, so the two surfaces never share a counter.
    skip: () => process.env.AGENTX_RATE_LIMIT === "off" || !Number.isFinite(limit) || limit <= 0,
    handler: (_req, res) => {
      // Same statusCode-carrying JSON shape as every other error this engine returns, which is
      // what AgentX-web-front's axios interceptor reads.
      res.status(429).json({ statusCode: 429, message: "Too many requests" });
    },
  });
}
