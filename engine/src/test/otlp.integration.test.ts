import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type TestEngine } from "./server.js";

// OTLP is the one ingestion path where the request body is written by third-party software the
// operator doesn't control (any OTel SDK, the Collector, a hand-rolled exporter). It is also
// mounted on a shared process: whatever a malformed export does here, it does to every other
// tenant of the same engine.

let engine: TestEngine;

beforeAll(async () => {
  engine = await startEngine();
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

function exportRequest(span: Record<string, unknown>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeSpans: [{ scope: { name: "opentelemetry.instrumentation.openai" }, spans: [span] }],
      },
    ],
  };
}

function goodSpan(overrides: Record<string, unknown> = {}) {
  return {
    traceId: b64("0123456789abcdef0123456789abcdef"),
    spanId: b64("0123456789abcdef"),
    name: "chat gpt-4o-mini",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001500000000",
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "35" } },
      { key: "input.value", value: { stringValue: "what is the return policy?" } },
      { key: "output.value", value: { stringValue: "30 days, unopened." } },
    ],
    ...overrides,
  };
}

async function postOtlp(body: unknown) {
  return engine.json("/api/v1/otel/v1/traces", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/otel/v1/traces", () => {
  it("ingests a well-formed OTLP/JSON export", async () => {
    const res = await postOtlp(exportRequest(goodSpan()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("rejects an export whose content type is neither of the two OTLP formats", async () => {
    // The body is a perfectly good export; only the header is wrong. This used to answer 200 with
    // an empty partial-success body while dropping every span, so a misconfigured exporter (or a
    // proxy rewriting the header) produced an empty Observe tab and no error anywhere.
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "application/octet-stream"]) {
      const res = await engine.json("/api/v1/otel/v1/traces", {
        method: "POST",
        body: JSON.stringify(exportRequest(goodSpan({ spanId: b64("dead0000beef0000") }))),
        headers: { "content-type": contentType },
      });
      expect(res.status, contentType).toBe(415);
      expect(JSON.stringify(res.body)).toContain("application/x-protobuf");
    }
  });

  it("rejects an export sent with no content type at all", async () => {
    const res = await engine.request("/api/v1/otel/v1/traces", {
      method: "POST",
      body: JSON.stringify(exportRequest(goodSpan())),
    });
    // fetch supplies text/plain for a string body when no header is set, which is equally wrong.
    expect(res.status).toBe(415);
    await res.text();
  });

  it("accepts application/json with a charset parameter", async () => {
    const res = await engine.json("/api/v1/otel/v1/traces", {
      method: "POST",
      body: JSON.stringify(exportRequest(goodSpan({ spanId: b64("2222222222222222") }))),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(res.status).toBe(200);
  });

  it("does not silently drop a well-formed export", async () => {
    // The counterpart to the 415 above: a correctly typed export really does land, so the check
    // above cannot be satisfied by rejecting everything.
    const spanId = b64("3333333333333333");
    const res = await postOtlp(exportRequest(goodSpan({ spanId, name: "content-type-check" })));
    expect(res.status).toBe(200);

    const listed = await engine.json("/api/v1/ingest/traces?limit=100");
    expect(JSON.stringify(listed.body)).toContain("content-type-check");
  });

  it("rejects a body that isn't an object with 400, not 500", async () => {
    const res = await engine.json("/api/v1/otel/v1/traces", {
      method: "POST",
      body: JSON.stringify("nope"),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty protobuf body with 400", async () => {
    const res = await engine.json("/api/v1/otel/v1/traces", {
      method: "POST",
      body: "",
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an undecodable protobuf body with 400", async () => {
    const res = await engine.json("/api/v1/otel/v1/traces", {
      method: "POST",
      body: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(res.status).toBe(400);
  });

  // --- malformed spans: an exporter bug must not become an engine outage ---

  const malformed: [string, Record<string, unknown>][] = [
    ["a non-numeric timestamp", { startTimeUnixNano: "not-a-number" }],
    ["an exponential-notation timestamp", { startTimeUnixNano: "1.7e18" }],
    ["a fractional numeric timestamp", { endTimeUnixNano: 1700000000000.5 }],
    ["a null timestamp", { startTimeUnixNano: null, endTimeUnixNano: null }],
    ["a boolean where a timestamp belongs", { startTimeUnixNano: true }],
    ["an object where a name belongs", { name: { not: "a string" } }],
    ["attributes that aren't a list", { attributes: "gen_ai.request.model=gpt-4o" }],
  ];

  for (const [label, overrides] of malformed) {
    it(`answers a span with ${label} instead of failing the request`, async () => {
      const res = await postOtlp(exportRequest(goodSpan(overrides)));
      expect(res.status).toBeLessThan(500);
    });
  }

  it("survives every malformed export above - the process must still be running", async () => {
    expect(engine.alive(), `engine died (exit ${engine.exitCode()}):\n${engine.log()}`).toBe(true);
  });

  it("still serves healthy traffic after the malformed exports", async () => {
    const health = await engine.json("/health", { apiKey: null });
    expect(health.status).toBe(200);
    const res = await postOtlp(exportRequest(goodSpan({ spanId: b64("1111111111111111") })));
    expect(res.status).toBe(200);
  });

  it("requires an API key", async () => {
    const res = await postOtlp(exportRequest(goodSpan()));
    expect(res.status).toBe(200);
    const unauthed = await engine.request("/api/v1/otel/v1/traces", {
      method: "POST",
      apiKey: null,
      body: JSON.stringify(exportRequest(goodSpan())),
      headers: { "content-type": "application/json" },
    });
    expect(unauthed.status).toBe(401);
  });
});
