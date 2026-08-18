import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// A custom pattern's regex is operator-supplied, but the TEXT it runs against is agent output -
// which end users influence. A regex that backtracks catastrophically therefore turns a long
// user-shaped response into an engine-wide freeze: JS regexes cannot be interrupted, and this
// process has one thread. These tests drive the real HTTP surface to prove the pattern never
// gets stored, and that a trace that would have triggered it is still served normally.

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const regexPattern = (name: string, regex: string) => ({
  name,
  detectorKind: "regex",
  regex,
  severity: "high",
  matchTarget: ["response"],
});

describe("custom monitor patterns", () => {
  it("stores a well-formed regex pattern", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/patterns", post(regexPattern("apology", "\\bsorry\\b")));
    expect(created.status).toBe(201);
    const list = await engine.json("/api/v1/agent-monitoring/patterns");
    expect(JSON.stringify(list.body)).toContain("apology");
  });

  it("rejects a regex that does not compile instead of saving a pattern that can never fire", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/patterns", post(regexPattern("broken", "([unclosed")));
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toMatch(/Invalid regular expression/);
  });

  it("rejects a catastrophically backtracking regex", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/patterns", post(regexPattern("redos", "(a+)+$")));
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toMatch(/exponential/);
  });

  it("rejects it on the SDK-facing route too, not just the dashboard one", async () => {
    const created = await engine.json("/api/v1/monitor/patterns", post(regexPattern("redos-sdk", "(\\w+\\s?)*$")));
    expect(created.status).toBe(400);
  });

  it("rejects it on update as well as create", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/patterns", post(regexPattern("editable", "safe")));
    expect(created.status).toBe(201);
    const patternId = (created.body as { pattern: { _id?: string; id?: string } }).pattern._id ??
      (created.body as { pattern: { id: string } }).pattern.id;

    const updated = await engine.json(`/api/v1/agent-monitoring/patterns/${patternId}`, {
      ...post(regexPattern("editable", "(x+x+)+y")),
      method: "PUT",
    });
    expect(updated.status).toBe(400);
  });

  it("keeps serving traffic when a trace carries text that would have triggered backtracking", async () => {
    // The input that pairs with `(a+)+$` to blow up. With the pattern rejected there is nothing
    // to backtrack, so this must complete promptly rather than pinning the process.
    const started = Date.now();
    const ingested = await engine.json(
      "/api/v1/ingest/traces",
      post({ name: "redos-bait", input: "hi", output: `${"a".repeat(400)}b` })
    );
    expect(ingested.status).toBe(200);

    const health = await engine.json("/health", { apiKey: null });
    expect(health.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(engine.alive()).toBe(true);
  }, 30_000);
});
