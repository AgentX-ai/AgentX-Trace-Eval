import { Router, type IRouter, type NextFunction, type Request, type RequestHandler, type Response } from "express";

// Express 4 only forwards SYNCHRONOUS throws to error middleware. A rejected `async (req, res)`
// handler - which is every handler here - becomes an unhandled rejection, which Node exits over:
// not a 500 for one caller but an outage for every project on the box, skipping index.ts's
// SIGTERM path. It was reachable from a plain SDK call (a non-numeric started_at_unix_nano
// reaching BigInt()). Routers built with asyncRouter() send a rejection to next(err) instead.
//
// Public Express API only - no reaching into router.stack or patching Layer.prototype the way
// express-async-errors does.

// Error middleware is left alone: re-wrapping it at arity 3 hides it from Express's own detection.
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
