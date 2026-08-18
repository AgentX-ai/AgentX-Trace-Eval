import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "./rateLimit.js";

// A limiter that throttles ingest is worse than no limiter - it drops the telemetry the engine
// exists to keep - so what matters here is the boundary: refuse exactly above the ceiling, let
// everything through below it, and never carry one client's count onto another.

function call(middleware: ReturnType<typeof rateLimit>, ip = "1.2.3.4") {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    body: undefined as unknown,
  };
  const next = vi.fn();
  middleware({ ip, socket: {} } as unknown as Request, res as unknown as Response, next as unknown as NextFunction);
  return { res, passed: next.mock.calls.length === 1 };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.AGENTX_RATE_LIMIT;
});

describe("rateLimit", () => {
  it("lets requests through up to the ceiling", () => {
    const middleware = rateLimit("test-under", 5);
    for (let i = 0; i < 5; i++) {
      expect(call(middleware).passed, `request ${i + 1} was refused`).toBe(true);
    }
  });

  it("refuses the first request past it, with a 429 and a Retry-After", () => {
    const middleware = rateLimit("test-over", 3);
    for (let i = 0; i < 3; i++) call(middleware);
    const { res, passed } = call(middleware);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ statusCode: 429 });
  });

  it("counts each client separately", () => {
    const middleware = rateLimit("test-per-ip", 2);
    call(middleware, "10.0.0.1");
    call(middleware, "10.0.0.1");
    expect(call(middleware, "10.0.0.1").passed).toBe(false);
    // A second client starts from zero rather than inheriting the first one's exhausted window.
    expect(call(middleware, "10.0.0.2").passed).toBe(true);
  });

  it("keeps separate buckets independent, so credential attempts cannot exhaust ingest", () => {
    const credential = rateLimit("credential", 1);
    const dataPlane = rateLimit("data-plane", 1);
    call(credential);
    expect(call(credential).passed).toBe(false);
    expect(call(dataPlane).passed).toBe(true);
  });

  it("starts a fresh window once the old one expires", () => {
    vi.useFakeTimers();
    const middleware = rateLimit("test-window", 2);
    call(middleware);
    call(middleware);
    expect(call(middleware).passed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(call(middleware).passed, "the window never reset").toBe(true);
  });

  it("is a no-op when disabled or given a nonsensical ceiling", () => {
    process.env.AGENTX_RATE_LIMIT = "off";
    const disabled = rateLimit("test-disabled", 1);
    for (let i = 0; i < 10; i++) {
      expect(call(disabled).passed).toBe(true);
    }
    delete process.env.AGENTX_RATE_LIMIT;

    for (const limit of [0, -1, NaN]) {
      const middleware = rateLimit(`test-limit-${limit}`, limit);
      for (let i = 0; i < 5; i++) {
        expect(call(middleware).passed, `limit ${limit} refused a request`).toBe(true);
      }
    }
  });

  it("passes a burst far larger than any real ingest at the data-plane ceiling", () => {
    // The concurrency suite fires 60 parallel ingests; the shipped ceiling is 6000/minute.
    const middleware = rateLimit("test-burst", 6000);
    for (let i = 0; i < 500; i++) {
      expect(call(middleware).passed, `request ${i + 1} was refused`).toBe(true);
    }
  });
});
