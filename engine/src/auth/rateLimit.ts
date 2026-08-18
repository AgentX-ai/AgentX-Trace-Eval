import type { NextFunction, Request, Response } from "express";

// A fixed-window request limiter, in-process and dependency-free - the same reason index.ts logs
// with console.log instead of morgan: engine/ compiles to a single Bun binary.
//
// Two ceilings, because the two surfaces have opposite failure modes. The credential surface
// (sign-in, sign-up, anything that hands out or is guarded by a project API key) is where an
// unbounded request rate is actually worth something to an attacker: guessing a 48-character key
// or a password is only viable at volume. The data plane is the opposite - throttling ingest
// drops telemetry, which is the one thing this engine exists to keep - so its ceiling is set far
// above any real SDK burst and exists only to bound a key-guessing loop.
//
// Per-process and per-IP: a restart clears it, and several replicas each keep their own count.
// That is the right trade for a self-hosted single binary, and it still removes the "unlimited
// attempts from one host" property. AGENTX_RATE_LIMIT=off disables it entirely for an operator
// whose ingest volume genuinely outruns the data-plane ceiling.
const WINDOW_MS = 60_000;

export const CREDENTIAL_LIMIT = Number(process.env.AGENTX_RATE_LIMIT_CREDENTIAL || 120);
export const DATA_PLANE_LIMIT = Number(process.env.AGENTX_RATE_LIMIT_DATA_PLANE || 6000);

function enabled(): boolean {
  return process.env.AGENTX_RATE_LIMIT !== "off";
}

type Window = { count: number; resetAt: number };

export function rateLimit(bucket: string, limit: number) {
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (!enabled() || !Number.isFinite(limit) || limit <= 0) {
      next();
      return;
    }
    const now = Date.now();
    const key = `${bucket}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const current = windows.get(key);

    if (!current || current.resetAt <= now) {
      // Sweeping only on a miss keeps this O(1) per request in the common case, and the map can
      // only grow to the number of distinct client addresses seen inside one window.
      if (windows.size > 10_000) {
        for (const [existing, window] of windows) {
          if (window.resetAt <= now) windows.delete(existing);
        }
      }
      windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      next();
      return;
    }

    current.count++;
    if (current.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ statusCode: 429, message: `Too many requests - retry in ${retryAfter}s` });
      return;
    }
    next();
  };
}
