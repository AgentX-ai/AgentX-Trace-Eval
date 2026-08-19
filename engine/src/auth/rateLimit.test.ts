import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { rateLimit, CREDENTIAL_LIMIT, DATA_PLANE_LIMIT } from "./rateLimit.js";

// A limiter that throttles ingest is worse than no limiter - it drops the telemetry the engine
// exists to keep - so what matters is the boundary: everything through below the ceiling, refused
// above it, and one surface's counter never spent by another's traffic.

let server: Server | undefined;

async function serve(build: (app: express.Express) => void): Promise<string> {
  const app = express();
  build(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  delete process.env.AGENTX_RATE_LIMIT;
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

async function hit(base: string, path = "/", count = 1): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(base + path);
    await res.text();
    statuses.push(res.status);
  }
  return statuses;
}

describe("rateLimit", () => {
  it("lets requests through up to the ceiling, then refuses with 429", async () => {
    const base = await serve(app => app.get("/", rateLimit(3), (_req, res) => res.json({ ok: true })));
    expect(await hit(base, "/", 3)).toEqual([200, 200, 200]);
    expect(await hit(base, "/", 1)).toEqual([429]);
  });

  it("answers a refusal in the statusCode shape the dashboard reads", async () => {
    const base = await serve(app => app.get("/", rateLimit(1), (_req, res) => res.json({ ok: true })));
    await hit(base);
    const res = await fetch(base + "/");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ statusCode: 429 });
  });

  it("keeps separate limiters independent, so credential attempts cannot exhaust ingest", async () => {
    const base = await serve(app => {
      app.get("/credential", rateLimit(1), (_req, res) => res.json({ ok: true }));
      app.get("/ingest", rateLimit(1), (_req, res) => res.json({ ok: true }));
    });
    expect(await hit(base, "/credential", 2)).toEqual([200, 429]);
    expect(await hit(base, "/ingest", 1)).toEqual([200]);
  });

  it("is a no-op when disabled", async () => {
    process.env.AGENTX_RATE_LIMIT = "off";
    const base = await serve(app => app.get("/", rateLimit(1), (_req, res) => res.json({ ok: true })));
    expect(await hit(base, "/", 6)).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("is a no-op for a ceiling that isn't a usable number", async () => {
    for (const limit of [0, -1, NaN]) {
      const base = await serve(app => app.get("/", rateLimit(limit), (_req, res) => res.json({ ok: true })));
      expect(await hit(base, "/", 4), `limit ${limit}`).toEqual([200, 200, 200, 200]);
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("ships a data-plane ceiling far above any real ingest burst, and a tighter credential one", () => {
    // The concurrency suite fires 60 parallel ingests; the resilience suite fires 200.
    expect(DATA_PLANE_LIMIT).toBeGreaterThanOrEqual(1000);
    expect(CREDENTIAL_LIMIT).toBeLessThan(DATA_PLANE_LIMIT);
    expect(CREDENTIAL_LIMIT).toBeGreaterThan(0);
  });
});
