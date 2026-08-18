import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startEngine, type TestEngine } from "./server.js";

// Custom Evaluators hand the verdict to an HTTP endpoint the operator controls, called on every
// ingested trace from the detached post-response work. That makes someone else's server part of
// this engine's ingest path: whatever it does - 500, garbage, silence - must stay their problem.

let engine: TestEngine;
let server: http.Server;
let base: string;
const calls: { path: string; body: string }[] = [];

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      calls.push({ path, body });
      if (path === "/matches") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches: true, reason: "policy breach", score: 0.9 }));
        return;
      }
      if (path === "/no-match") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches: false }));
        return;
      }
      if (path === "/garbage") {
        res.writeHead(200, { "content-type": "application/json" }).end("this is not json");
        return;
      }
      if (path === "/wrong-shape") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ verdict: "yes" }));
        return;
      }
      if (path === "/boom") {
        res.writeHead(500).end("server error");
        return;
      }
      if (path === "/hang") {
        return; // never answers
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
  await new Promise<void>(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

// sampleRate is passed explicitly on purpose - see the "defaults to sampling a tenth" test below
// for why leaving it out would make every assertion here a coin flip.
async function createEvaluator(name: string, path: string, extra: Record<string, unknown> = {}) {
  const res = await engine.json(
    "/api/v1/agent-monitoring/custom-evaluators",
    post({ name, url: `${base}${path}`, severity: "high", sampleRate: 1, ...extra })
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const evaluator = (res.body as { evaluator: { _id?: string; id?: string } }).evaluator;
  return evaluator._id ?? (evaluator as { id: string }).id;
}

async function deleteEvaluator(id: string) {
  await engine.json(`/api/v1/agent-monitoring/custom-evaluators/${id}`, { method: "DELETE" });
}

describe("custom evaluator dry run", () => {
  it("reports a working endpoint with its verdict and latency", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: `${base}/matches` }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, response: { matches: true, reason: "policy breach", score: 0.9 } });
  });

  it("reports a non-2xx endpoint as not ok rather than erroring the route", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: `${base}/boom` }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false });
    expect(JSON.stringify(res.body)).toContain("500");
  });

  it("reports an endpoint returning non-JSON as not ok", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: `${base}/garbage` }));
    expect(res.body).toMatchObject({ ok: false });
  });

  it("reports an endpoint missing the matches field as not ok, naming the field", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: `${base}/wrong-shape` }));
    expect(res.body).toMatchObject({ ok: false });
    expect(JSON.stringify(res.body)).toContain("matches");
  });

  it("reports an unreachable endpoint as not ok", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: "http://127.0.0.1:1/nope" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("gives up on a hanging endpoint instead of holding the request open forever", async () => {
    const started = Date.now();
    const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url: `${base}/hang` }));
    expect(res.body).toMatchObject({ ok: false });
    // The documented budget is 8s.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it("rejects a url that isn't http(s)", async () => {
    for (const url of ["file:///etc/passwd", "not-a-url", "", null, 42]) {
      const res = await engine.json("/api/v1/agent-monitoring/custom-evaluators/dry-run", post({ url }));
      expect(res.status, String(url)).toBe(400);
    }
  });
});

describe("custom evaluators on the ingest path", () => {
  it("raises a signal carrying the endpoint's reason when it matches", async () => {
    const id = await createEvaluator("policy-check", "/matches");
    try {
      await engine.json("/api/v1/ingest/traces", post({ name: "ce-agent", input: "q", output: "a fine answer" }));

      const deadline = Date.now() + 15_000;
      let found: unknown;
      while (Date.now() < deadline && !found) {
        const signals = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
        found = ((signals.body as { signals?: { summary?: string }[] }).signals ?? []).find(s =>
          (s.summary ?? "").includes("policy breach")
        );
        if (!found) await new Promise(r => setTimeout(r, 200));
      }
      expect(found, "no signal was raised from the evaluator's verdict").toBeTruthy();

      // And the endpoint actually received the trace it was judging.
      const call = calls.filter(c => c.path === "/matches").pop();
      expect(call).toBeTruthy();
      expect(JSON.parse(call!.body)).toMatchObject({ evaluatorName: "policy-check", trace: { output: "a fine answer" } });
    } finally {
      await deleteEvaluator(id);
    }
  }, 60_000);

  it("raises nothing when the endpoint says no", async () => {
    const id = await createEvaluator("quiet-check", "/no-match");
    try {
      const before = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
      const beforeCount = ((before.body as { signals?: unknown[] }).signals ?? []).length;
      await engine.json("/api/v1/ingest/traces", post({ name: "ce-quiet-agent", input: "q", output: "a fine answer" }));
      await new Promise(r => setTimeout(r, 1_500));
      const after = await engine.json("/api/v1/agent-monitoring/signals?limit=100");
      expect(((after.body as { signals?: unknown[] }).signals ?? []).length).toBe(beforeCount);
    } finally {
      await deleteEvaluator(id);
    }
  }, 60_000);

  const hostile: [string, string][] = [
    ["returns 500", "/boom"],
    ["returns non-JSON", "/garbage"],
    ["omits the matches field", "/wrong-shape"],
    ["never responds", "/hang"],
    ["is unreachable", "__unreachable__"],
  ];

  for (const [label, path] of hostile) {
    it(`keeps ingesting when the evaluator endpoint ${label}`, async () => {
      const url = path === "__unreachable__" ? "http://127.0.0.1:1/nope" : `${base}${path}`;
      const created = await engine.json(
        "/api/v1/agent-monitoring/custom-evaluators",
        post({ name: `hostile-${path.replace(/\W/g, "")}`, url, severity: "high", sampleRate: 1 })
      );
      expect(created.status).toBe(201);
      const evaluator = (created.body as { evaluator: { _id?: string; id?: string } }).evaluator;
      const id = evaluator._id ?? (evaluator as { id: string }).id;

      try {
        const started = Date.now();
        const res = await engine.json("/api/v1/ingest/traces", post({ name: "ce-hostile-agent", input: "q", output: "a" }));
        expect(res.status).toBe(200);
        // Ingest responds before the evaluator is even called - a dead endpoint must never be in
        // the caller's critical path.
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        await deleteEvaluator(id);
      }
    }, 60_000);
  }

  it("defaults to sampling a tenth of traffic when no sampleRate is given", async () => {
    // Pinned because it is surprising and easy to hit: a Custom Evaluator created without an
    // explicit sampleRate skips ~90% of traces, so an operator wiring up their endpoint and
    // sending a handful of test traces will most likely see nothing happen at all.
    //
    // The 0.1 comes from monitor_online_evaluators, which customEvaluators.ts was modeled on, and
    // there the number is justified in the schema comment: "Every check here is a real LLM call
    // against the user's own API key". A Custom Evaluator calls the operator's OWN endpoint - no
    // per-call billing - and Patterns, the other free, user-configured check, default to 1.
    const created = await engine.json(
      "/api/v1/agent-monitoring/custom-evaluators",
      post({ name: "default-sample-rate", url: `${base}/no-match`, severity: "high" })
    );
    expect(created.status).toBe(201);
    const evaluator = (created.body as { evaluator: { _id?: string; id?: string; sampleRate: number } }).evaluator;
    expect(evaluator.sampleRate).toBe(0.1);
    await deleteEvaluator(evaluator._id ?? (evaluator as { id: string }).id);
  });

  it("rejects a sample rate that would silently disable the evaluator", async () => {
    // routing.ts reads <= 0, and any non-number, as "never run". Accepting these produced an
    // evaluator the dashboard shows as enabled that never fires - so the boundary rejects them.
    for (const sampleRate of [-1, 42, "half", null, NaN]) {
      const res = await engine.json(
        "/api/v1/agent-monitoring/custom-evaluators",
        post({ name: `bad-rate-${String(sampleRate)}`, url: `${base}/no-match`, sampleRate })
      );
      expect(res.status, `sampleRate=${String(sampleRate)} was accepted`).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/between 0 and 1/);
    }
  });

  it("applies the same check to patterns and online evaluators on both routers", async () => {
    const bodies: [string, unknown][] = [
      ["/api/v1/agent-monitoring/patterns", { name: "p", detectorKind: "contains", includeTerms: ["x"], sampleRate: -1 }],
      ["/api/v1/monitor/patterns", { name: "p2", detectorKind: "contains", includeTerms: ["x"], sampleRate: "half" }],
      ["/api/v1/agent-monitoring/online-evaluators", { name: "oe", sampleRate: 5 }],
      ["/api/v1/monitor/online-evaluators", { name: "oe2", sampleRate: -0.5 }],
    ];
    for (const [path, body] of bodies) {
      const res = await engine.json(path, post(body));
      expect(res.status, `${path} accepted an out-of-range sampleRate`).toBe(400);
    }
  });

  it("still accepts a legal sample rate", async () => {
    const res = await engine.json(
      "/api/v1/agent-monitoring/custom-evaluators",
      post({ name: "legal-rate", url: `${base}/no-match`, sampleRate: 0.25 })
    );
    expect(res.status).toBe(201);
    const evaluator = (res.body as { evaluator: { _id?: string; id?: string; sampleRate: number } }).evaluator;
    expect(evaluator.sampleRate).toBe(0.25);
    await deleteEvaluator(evaluator._id ?? (evaluator as { id: string }).id);
  });

  it("is still alive and unpolluted by unhandled rejections after all of that", async () => {
    // The hanging endpoint's 8s deadline fires well after its ingest returned; give it room to
    // land so a rejection would have surfaced by now.
    await new Promise(r => setTimeout(r, 10_000));
    expect(engine.alive(), engine.log().slice(-3000)).toBe(true);
    expect(engine.log()).not.toContain("Unhandled promise rejection");
    expect((await engine.json("/health", { apiKey: null })).status).toBe(200);
  }, 30_000);
});
