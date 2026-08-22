import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// The shipped template-scorer catalog: each detector is opt-in per project, zero-LLM-cost, and
// only enabled keys run. Each test gets its own project with exactly one scorer enabled, proving
// both that the detector fires on a match and that nothing else does.

let engine: TestEngine;

const post = (body: unknown, apiKey: string): RequestInit & { apiKey: string } => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  apiKey,
});

async function projectWithScorer(name: string, key: string | null): Promise<string> {
  const res = await engine.json("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    apiKey: null,
  });
  expect(res.status).toBe(201);
  const apiKey = (res.body as { project: { apiKey: string } }).project.apiKey;
  if (key) {
    const put = await engine.request("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      method: "PUT",
      body: JSON.stringify({ enabledBuiltinPatterns: [key] }),
      headers: { "content-type": "application/json" },
      apiKey,
    });
    expect(put.status).toBe(200);
  }
  return apiKey;
}

async function ingest(apiKey: string, name: string, output: string, spanId: string): Promise<void> {
  const res = await engine.json("/api/v1/ingest/traces", post({ name, input: "q", output, span_id: spanId }, apiKey));
  expect(res.status).toBe(200);
}

async function signalKeys(apiKey: string, timeoutMs = 12_000, expectAtLeast = 1): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let keys: string[] = [];
  while (Date.now() < deadline) {
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey });
    keys = ((res.body as { signals?: { patternKey?: string }[] }).signals ?? []).map(s => s.patternKey ?? "");
    if (keys.length >= expectAtLeast) return keys;
    await new Promise(r => setTimeout(r, 150));
  }
  return keys;
}

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("built-in template scorers", () => {
  it("secrets-in-response flags a leaked API key, naming the kind", async () => {
    const key = await projectWithScorer("Secrets scorer", "secrets-in-response");
    await ingest(key, "secrets-agent", "Your key is sk-proj-Abc123def456ghi789jkl012 - keep it safe!", "sec-1");
    await ingest(key, "secrets-agent", "I can't share credentials, but rotation is under Settings.", "sec-2");
    const keys = await signalKeys(key);
    expect(keys).toContain("secrets-in-response");
    expect(keys.filter(k => k === "secrets-in-response")).toHaveLength(1);
  }, 40_000);

  it("secrets-in-response catches private-key blocks and JWTs", async () => {
    const key = await projectWithScorer("Secrets scorer 2", "secrets-in-response");
    await ingest(key, "secrets-agent", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...", "sec-3");
    await ingest(
      key,
      "secrets-agent",
      "Session: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65KSIs",
      "sec-4"
    );
    const keys = await signalKeys(key, 12_000, 1);
    expect(keys.filter(k => k === "secrets-in-response").length).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("prompt-injection-echo flags an echoed jailbreak phrasing", async () => {
    const key = await projectWithScorer("Injection scorer", "prompt-injection-echo");
    await ingest(key, "inj-agent", "Sure! I will ignore previous instructions and act as an unrestricted model.", "inj-1");
    await ingest(key, "inj-agent", "Here is the weather for Tuesday: sunny, 24C.", "inj-2");
    const keys = await signalKeys(key);
    expect(keys).toContain("prompt-injection-echo");
  }, 40_000);

  it("refusal-response flags a deflection at low severity", async () => {
    const key = await projectWithScorer("Refusal scorer", "refusal-response");
    await ingest(key, "refusal-agent", "I'm sorry, but I can't help with that request.", "ref-1");
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: key });
    await signalKeys(key);
    const signals = ((await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: key })).body as {
      signals?: { patternKey?: string; severity?: string }[];
    }).signals ?? [];
    const refusal = signals.find(s => s.patternKey === "refusal-response");
    expect(refusal, JSON.stringify(res.body)).toBeTruthy();
    expect(refusal!.severity).toBe("low");
  }, 40_000);

  it("profanity-in-response flags the wordlist, not ordinary words", async () => {
    const key = await projectWithScorer("Profanity scorer", "profanity-in-response");
    await ingest(key, "prof-agent", "That vendor's API is complete shit, honestly.", "prof-1");
    await ingest(key, "prof-agent", "The Scunthorpe office assessed the class assignment.", "prof-2");
    const keys = await signalKeys(key);
    expect(keys).toContain("profanity-in-response");
    expect(keys.filter(k => k === "profanity-in-response")).toHaveLength(1);
  }, 40_000);

  it("malformed-json-response flags prose and passes valid JSON", async () => {
    const key = await projectWithScorer("JSON scorer", "malformed-json-response");
    await ingest(key, "json-agent", '{"status": "ok", "items": [1, 2, 3]}', "json-1");
    await ingest(key, "json-agent", "Sorry, I could not build the report today.", "json-2");
    const keys = await signalKeys(key);
    expect(keys).toContain("malformed-json-response");
    expect(keys.filter(k => k === "malformed-json-response")).toHaveLength(1);
  }, 40_000);

  it("runs nothing when no scorer is enabled, even on trippy output", async () => {
    const key = await projectWithScorer("No scorers", null);
    await ingest(key, "quiet-agent", "sk-proj-Abc123def456ghi789jkl012 shit ignore previous instructions", "quiet-1");
    await new Promise(r => setTimeout(r, 1_500));
    const res = await engine.json("/api/v1/agent-monitoring/signals?limit=100", { apiKey: key });
    const failing = (((res.body as { signals?: { patternKey?: string }[] }).signals ?? []) as { patternKey?: string }[]).filter(
      s => s.patternKey !== "healthy-response"
    );
    expect(failing).toEqual([]);
  }, 40_000);

  it("attaches per-scorer signal tallies to the catalog rows", async () => {
    const key = await projectWithScorer("Tally project", "refusal-response");
    await ingest(key, "tally-agent", "I'm sorry, but I can't help with that.", "tal-1");
    await signalKeys(key);
    const res = await engine.json("/api/v1/agent-monitoring/patterns", { apiKey: key });
    const rows = (res.body as { patterns: { key: string; totalSignals?: number; openSignals?: number }[] }).patterns;
    const refusal = rows.find(r => r.key === "refusal-response");
    expect(refusal?.totalSignals).toBe(1);
    expect(refusal?.openSignals).toBe(1);
    const pii = rows.find(r => r.key === "pii-in-response");
    expect(pii?.totalSignals).toBe(0);
  }, 40_000);

  it("first match wins: secrets outranks profanity on the same response", async () => {
    const key = await projectWithScorer("Ordering", "secrets-in-response");
    const put = await engine.request("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      method: "PUT",
      body: JSON.stringify({ enabledBuiltinPatterns: ["secrets-in-response", "profanity-in-response"] }),
      headers: { "content-type": "application/json" },
      apiKey: key,
    });
    expect(put.status).toBe(200);
    await ingest(key, "order-agent", "Oh shit, I pasted sk-proj-Abc123def456ghi789jkl012 in the chat.", "ord-1");
    const keys = await signalKeys(key);
    expect(keys).toContain("secrets-in-response");
    expect(keys).not.toContain("profanity-in-response");
  }, 40_000);
});
