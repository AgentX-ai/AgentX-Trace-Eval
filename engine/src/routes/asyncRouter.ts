import { Router, type IRouter, type NextFunction, type Request, type RequestHandler, type Response } from "express";

// Express 4 only forwards SYNCHRONOUS throws to error middleware. An `async (req, res) => ...`
// handler that rejects - and every handler in this engine is one - produces an unhandled promise
// rejection instead, which Node's default `--unhandled-rejections=throw` turns into an immediate
// process exit. That is not a 500 for one caller: it takes the engine down for every project on
// the box, mid-request, skipping index.ts's SIGTERM path (so SQLite's WAL is never flushed).
//
// It was reachable from a plain SDK call: POST /ingest/traces with a `started_at_unix_nano` that
// isn't a decimal integer reached `BigInt(...)`, which throws, and the whole engine went down.
// That specific parse is fixed at its source (core/trace/ingest.ts), but the next unvalidated
// field would be the next outage, so the class of failure is closed here rather than one instance
// of it: routers built with asyncRouter() route a rejected handler into `next(err)`, where the
// error handler in index.ts turns it into an ordinary 500.
//
// Public Express API only - a Router with wrapped registration methods, no reaching into
// `router.stack` or patching Layer.prototype the way express-async-errors does.

// A handler Express treats as error middleware (err, req, res, next) is left exactly as it is:
// re-wrapping it at arity 3 would hide it from Express's own error-handler detection.
function isErrorMiddleware(handler: unknown): boolean {
  return typeof handler === "function" && handler.length >= 4;
}

export function asyncHandler(handler: RequestHandler): RequestHandler {
  if (isErrorMiddleware(handler)) {
    return handler;
  }
  return function wrapped(this: unknown, req: Request, res: Response, next: NextFunction) {
    try {
      const result = (handler as (req: Request, res: Response, next: NextFunction) => unknown).call(this, req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
      return result;
    } catch (err) {
      next(err);
      return undefined;
    }
  } as RequestHandler;
}

const WRAPPED_METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;

export function asyncRouter(): IRouter {
  const router = Router();
  for (const method of WRAPPED_METHODS) {
    const original = router[method].bind(router) as (...args: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any)[method] = (...args: unknown[]) =>
      original(...args.map(arg => (typeof arg === "function" ? asyncHandler(arg as RequestHandler) : arg)));
  }
  return router;
}
