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

export const CREDENTIAL_LIMIT = Number(process.env.AGENTX_RATE_LIMIT_CREDENTIAL || 120);
export const DATA_PLANE_LIMIT = Number(process.env.AGENTX_RATE_LIMIT_DATA_PLANE || 6000);

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
