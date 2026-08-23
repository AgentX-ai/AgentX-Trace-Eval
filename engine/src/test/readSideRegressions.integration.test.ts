import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// Regressions for deep-dive round 3's read-side bug cluster (sample-scripts/
// eval_framework_deep_dive/DEEP_DIVE_REPORT.md): the engine wrote correctly but showed less
// than the truth. Bug #2 (typo'd scorer keys stored as silent no-ops), bug #3 (OTLP/JSON
// hex ids misdecoded as base64), bug #4 (scorer-crash events invisible in the history read).

let engine: TestEngine;
let key: string;

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "read-side" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("bug #2: template-scorer keys are validated", () => {
  it("rejects unknown keys with the known list, and never stores the typo", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      ...postJson({ enabledBuiltinPatterns: ["pii-in-respose"] }), // the classic typo
      method: "PUT",
      apiKey: key,
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: string; knownKeys: string[] };
    expect(body.error).toContain("pii-in-respose");
    expect(body.knownKeys).toContain("pii-in-response");

    const settings = await engine.json("/api/v1/agent-monitoring/settings", { apiKey: key });
    expect(JSON.stringify(settings.body)).not.toContain("pii-in-respose");
  });

  it("still accepts valid keys", async () => {
    const res = await engine.json("/api/v1/agent-monitoring/settings/monitoring-defaults", {
      ...postJson({ enabledBuiltinPatterns: ["pii-in-response", "secrets-in-response"] }),
      method: "PUT",
      apiKey: key,
    });
    expect(res.status).toBe(200);
  });
});

describe("bug #3: OTLP/JSON accepts both id encodings", () => {
  const exportBody = (traceId: string, rootId: string, childId: string) => ({
    resourceSpans: [{
      scopeSpans: [{
        spans: [
          { traceId, spanId: rootId, name: "otlp-root", kind: 1,
            startTimeUnixNano: String(Date.now() * 1e6 - 5e7), endTimeUnixNano: String(Date.now() * 1e6) },
          { traceId, spanId: childId, parentSpanId: rootId, name: "otlp-child", kind: 1,
            startTimeUnixNano: String(Date.now() * 1e6 - 4e7), endTimeUnixNano: String(Date.now() * 1e6 - 1e7) },
        ],
      }],
    }],
  });

  it("hex ids (the OTLP/JSON spec encoding) round-trip under their real session id", async () => {
    const traceHex = "0af7651916cd43dd8448eb211c80319c";
    const res = await engine.json("/api/v1/otel/v1/traces", {
      ...postJson(exportBody(traceHex, "b7ad6b7169203331", "00f067aa0ba902b7")),
      apiKey: key,
    });
    expect(res.status).toBe(200);
    const spans = await engine.json(`/api/v1/ingest/sessions/${traceHex}/spans`, { apiKey: key });
    const rows = (spans.body as { spans: { spanId: string; parentSpanId: string | null }[] }).spans;
    expect(rows.length).toBe(2);
    expect(rows.some(s => s.parentSpanId === "b7ad6b7169203331")).toBe(true);
  });

  it("base64 ids (protobuf-object JSON) still round-trip to the same hex rendering", async () => {
    const bytes = Buffer.from("1af7651916cd43dd8448eb211c80319d", "hex");
    const root = Buffer.from("c7ad6b7169203331", "hex");
    const child = Buffer.from("10f067aa0ba902b7", "hex");
    const res = await engine.json("/api/v1/otel/v1/traces", {
      ...postJson(exportBody(bytes.toString("base64"), root.toString("base64"), child.toString("base64"))),
      apiKey: key,
    });
    expect(res.status).toBe(200);
    const spans = await engine.json(`/api/v1/ingest/sessions/${bytes.toString("hex")}/spans`, { apiKey: key });
    expect((spans.body as { spans: unknown[] }).spans.length).toBe(2);
  });
});

describe("bug #4: a crashing scorer is visible in its own history", () => {
  it("surfaces the failure event with the error as justification, raising no false signal", async () => {
    const created = await engine.json("/api/v1/agent-monitoring/custom-evaluators", {
      ...postJson({
        name: "Crasher",
        kind: "code",
        language: "python",
        sampleRate: 1,
        alertBelow: 0.5,
        script: "async def handler(input, output, expected, metadata, trace):\n    raise ValueError('kaboom')\n",
      }),
      apiKey: key,
    });
    expect(created.status).toBe(201);
    const scorerId = (created.body as { evaluator: { _id: string } }).evaluator._id;

    const ingested = await engine.json("/api/v1/ingest/traces", {
      ...postJson({ name: "crash-probe", input: "q", output: "a" }),
      apiKey: key,
    });
    expect(ingested.status).toBe(200);

    // The scorer runs in the post-response monitor pass; poll briefly.
    let events: { matched: boolean | null; justification: string | null }[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await engine.json(
        `/api/v1/agent-monitoring/custom-evaluators/${scorerId}/events?window=24h`,
        { apiKey: key }
      );
      events = (res.body as { events: typeof events }).events;
      if (events.length > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.matched).toBeNull();
    expect(events[0]!.justification).toContain("kaboom");

    const signals = await engine.json("/api/v1/agent-monitoring/signals?limit=50", { apiKey: key });
    const custom = ((signals.body as { signals: { patternKey: string }[] }).signals ?? []).filter(s =>
      s.patternKey?.startsWith("custom-eval:")
    );
    expect(custom.length).toBe(0);
  });
});
