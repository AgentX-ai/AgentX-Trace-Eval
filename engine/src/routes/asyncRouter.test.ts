import { describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import net from "node:net";
import { asyncHandler, asyncRouter } from "./asyncRouter.js";

// Drives a real Express app over a real socket: the whole point of this module is what Express
// itself does with a rejected handler, which a hand-called wrapper would not exercise.
async function request(build: (app: express.Express) => void, path = "/boom") {
  const app = express();
  build(app);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ handled: true, message: err instanceof Error ? err.message : String(err) });
  });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const p = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(p));
    });
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json().catch(() => null)) as { handled?: boolean } | null };
  } finally {
    await new Promise(r => server.close(r));
  }
}

describe("asyncRouter", () => {
  // The regression this exists for: Express 4 turns a rejected async handler into an unhandled
  // rejection, and Node exits over it. Without the wrapper this request never reaches the error
  // middleware at all.
  it("sends a rejected async handler to the error middleware", async () => {
    const router = asyncRouter();
    router.get("/boom", async () => {
      throw new Error("rejected");
    });
    const res = await request(app => app.use(router));
    expect(res.status).toBe(500);
    expect(res.body?.handled).toBe(true);
  });

  it("does the same for a handler that rejects after an await", async () => {
    const router = asyncRouter();
    router.get("/boom", async () => {
      await new Promise(r => setTimeout(r, 1));
      throw new Error("rejected later");
    });
    expect((await request(app => app.use(router))).status).toBe(500);
  });

  it("still forwards a synchronous throw", async () => {
    const router = asyncRouter();
    router.get("/boom", () => {
      throw new Error("sync");
    });
    expect((await request(app => app.use(router))).status).toBe(500);
  });

  it("leaves a successful handler alone", async () => {
    const router = asyncRouter();
    router.get("/ok", async (_req: Request, res: Response) => {
      res.status(204).end();
    });
    expect((await request(app => app.use(router), "/ok")).status).toBe(204);
  });

  it("wraps app-level handlers through asyncHandler too", async () => {
    const res = await request(app =>
      app.get(
        "/boom",
        asyncHandler(async () => {
          throw new Error("app-level");
        })
      )
    );
    expect(res.status).toBe(500);
    expect(res.body?.handled).toBe(true);
  });

  // Express detects error middleware by arity, so re-wrapping at arity 3 would hide it and the
  // error would fall through to Express's default handler instead.
  it("does not re-wrap error middleware", () => {
    const errorMiddleware = (_e: unknown, _q: Request, _s: Response, _n: NextFunction) => undefined;
    expect(asyncHandler(errorMiddleware as never)).toBe(errorMiddleware);
  });
});
