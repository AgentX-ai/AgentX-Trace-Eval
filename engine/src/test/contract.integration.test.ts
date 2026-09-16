import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";
import {
  agentsListSchema,
  alertEventsResponseSchema,
  alertRulesResponseSchema,
  exportManifestSchema,
  insightsCoverageResponseSchema,
  insightsProbeBatchResponseSchema,
  insightsProbeResponseSchema,
  judgeScorersResponseSchema,
  monitoringDefaultsPutResponseSchema,
  monitorMetricsResponseSchema,
  settingsResponseSchema,
  signalsResponseSchema,
  tracesPageSchema,
  WIRE_CONTRACT,
} from "../contract/wire.js";

// The wire contract, enforced: every covered endpoint's LIVE response must parse against its
// schema in src/contract/wire.ts. The schemas are .strict(), so a field the engine starts
// sending without updating the contract fails HERE, in the same commit - instead of drifting
// away from the frontend's hand-written types and the SDK's models until something breaks.

let engine: TestEngine;
let key: string;

const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
  engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });

beforeAll(async () => {
  engine = await startEngine();
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: "contract" }), apiKey: null });
  key = (created.body as { project: { apiKey: string } }).project.apiKey;

  // Seed enough real data that the schemas exercise their populated branches, not just empties:
  // a trace with cache tokens + tool calls (metrics cost splits, trace list fields), a
  // secrets-in-response detection (signals with occurrences), and the seeded judge templates
  // are already present for judge-scorers.
  const put = (body: unknown) => ({
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  await api(
    "/agent-monitoring/settings/monitoring-defaults",
    put({ enabledBuiltinPatterns: ["secrets-in-response"], topicsSampleRate: 0.5 })
  );
  await api("/ingest/traces", postJson({
    name: "contract-agent",
    input: "what's my key?",
    output: "here you go: sk-proj-Abc123def456ghi789jkl012",
    model: "gpt-4o-mini",
    latencyMs: 420,
    inputTokens: 400,
    outputTokens: 80,
    cacheReadTokens: 100,
    toolCalls: [{ name: "lookup", success: true }],
    // Mixed case on purpose: ingest folds it, and the metrics assertions below prove the
    // populated byFramework branch (not just empty records) satisfies the contract.
    framework: "LangChain",
    span_id: "ct-1",
  }));
  // Wait for the async detection to raise the signal so the signals schema sees a real row.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const res = await api("/agent-monitoring/signals?limit=10");
    if (((res.body as { signals?: unknown[] }).signals ?? []).length > 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
}, 90_000);

afterAll(async () => {
  await engine?.stop();
});

describe("wire contract", () => {
  it("GET /agent-monitoring/metrics matches the contract", async () => {
    const res = await api("/agent-monitoring/metrics?window=24h");
    expect(res.status).toBe(200);
    const parsed = monitorMetricsResponseSchema.parse(res.body);
    expect(parsed.totals.traces).toBeGreaterThan(0);
    expect(parsed.totals.costCached).toBeGreaterThan(0);
    // Platform attribution: normalized at ingest ("LangChain" -> "langchain"), ranked, faceted.
    expect(parsed.frameworks.find(f => f.name === "langchain")?.count).toBeGreaterThan(0);
    expect(parsed.facets.frameworks).toContain("langchain");
  });

  it("GET /agent-monitoring/settings and the defaults PUT match the contract", async () => {
    const settings = await api("/agent-monitoring/settings");
    expect(settings.status).toBe(200);
    settingsResponseSchema.parse(settings.body);
    const put = await api("/agent-monitoring/settings/monitoring-defaults", {
      method: "PUT",
      body: JSON.stringify({ retentionDays: 7 }),
      headers: { "content-type": "application/json" },
    });
    expect(put.status).toBe(200);
    const parsed = monitoringDefaultsPutResponseSchema.parse(put.body);
    expect(parsed.monitoringDefaults.topicsSampleRate).toBe(0.5);
  });

  it("GET /ingest/traces matches the contract", async () => {
    const res = await api("/ingest/traces?limit=10");
    expect(res.status).toBe(200);
    const parsed = tracesPageSchema.parse(res.body);
    expect(parsed.traces.length).toBeGreaterThan(0);
    expect(parsed.traces[0]!.model).toBe("gpt-4o-mini");
  });

  it("GET /agent-monitoring/signals matches the contract, occurrences included", async () => {
    const res = await api("/agent-monitoring/signals?limit=10");
    expect(res.status).toBe(200);
    const parsed = signalsResponseSchema.parse(res.body);
    expect(parsed.signals.length).toBeGreaterThan(0);
  });

  it("GET /agent-monitoring/judge-scorers matches the contract (seeded templates)", async () => {
    const res = await api("/agent-monitoring/judge-scorers");
    expect(res.status).toBe(200);
    const parsed = judgeScorersResponseSchema.parse(res.body);
    expect(parsed.judgeScorers.length).toBeGreaterThan(0);
  });

  it("GET /insights/coverage matches the contract with no classified traffic", async () => {
    // Topics is opt-in and sampled, so an install with nothing classified yet is the COMMON
    // first view of this screen - it has to be a clean, parseable empty state rather than a 500.
    const res = await api("/insights/coverage?window=7d");
    expect(res.status).toBe(200);
    const parsed = insightsCoverageResponseSchema.parse(res.body);
    expect(parsed.insufficientData).toBe(true);
    expect(parsed.topics).toEqual([]);
  });

  it("POST /insights/probe matches the contract and validates its body", async () => {
    const res = await api("/insights/probe", postJson({ query: "how do I reset my password" }));
    expect(res.status).toBe(200);
    const parsed = insightsProbeResponseSchema.parse(res.body);
    // No dataset case is anywhere near it and production has never been classified, so the only
    // honest answer is the one that does not manufacture a gap.
    expect(parsed.verdict).toBe("untested-and-unasked");
    expect(parsed.explanation).toContain("not a gap");

    const empty = await api("/insights/probe", postJson({ query: "   " }));
    expect(empty.status).toBe(400);
  });

  it("POST /insights/probe/batch matches the contract", async () => {
    const res = await api("/insights/probe/batch", postJson({ queries: ["close my account", "refund status"] }));
    expect(res.status).toBe(200);
    const parsed = insightsProbeBatchResponseSchema.parse(res.body);
    expect(parsed.rollup.total).toBe(2);
    expect(parsed.results).toHaveLength(2);

    const none = await api("/insights/probe/batch", postJson({ queries: [] }));
    expect(none.status).toBe(400);
  });

  it("GET /agents matches the contract after a registration", async () => {
    const created = await api("/agents", postJson({ name: "contract-registered-agent" }));
    expect(created.status).toBe(201);
    const res = await api("/agents");
    expect(res.status).toBe(200);
    const parsed = agentsListSchema.parse(res.body);
    expect(parsed.agents.some(agent => agent.name === "contract-registered-agent")).toBe(true);
  });

  it("GET /agent-monitoring/alert-rules and its events match the contract after a test page", async () => {
    const created = await api(
      "/agent-monitoring/alert-rules",
      postJson({
        name: "contract latency",
        metric: "p95LatencyMs",
        operator: "gt",
        threshold: 2000,
        windowMinutes: 15,
        // A mailer is never configured here, so the delivery is recorded as a refusal - which
        // is exactly the populated `error` branch the schema has to admit.
        channels: [{ kind: "email", target: "oncall@example.com" }],
      })
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { rule: { _id: string } }).rule._id;
    const sent = await api(`/agent-monitoring/alert-rules/${id}/test`, postJson({}));
    expect(sent.status).toBe(200);

    const list = await api("/agent-monitoring/alert-rules");
    expect(list.status).toBe(200);
    const rules = alertRulesResponseSchema.parse(list.body);
    expect(rules.rules.some(r => r._id === id && r.lastValueLabel.length > 0)).toBe(true);
    expect(rules.summary.total).toBe(rules.rules.length);

    const events = await api(`/agent-monitoring/alert-rules/${id}/events`);
    expect(events.status).toBe(200);
    const parsed = alertEventsResponseSchema.parse(events.body);
    expect(parsed.events[0]).toMatchObject({ kind: "test", ruleId: id });
    expect(parsed.events[0]!.deliveries[0]).toMatchObject({ kind: "email", ok: false });
  });

  it("GET /export matches the contract and lists every entity", async () => {
    const res = await api("/export");
    expect(res.status).toBe(200);
    const parsed = exportManifestSchema.parse(res.body);
    // The manifest is the export surface's own registry - a new entity missing here is exactly
    // the docs-vs-engine drift this contract exists to catch.
    expect(parsed.entities.map(e => e.entity)).toContain("evaluation-analyses");
    expect(parsed.entities.map(e => e.entity)).toContain("traces");
  });

  it("GET /openapi.json publishes every contract entry in OpenAPI path templating", async () => {
    const res = await engine.json("/api/v1/openapi.json", { apiKey: null });
    expect(res.status).toBe(200);
    const doc = res.body as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const entry of WIRE_CONTRACT) {
      // {id}, never :id - generators treat Express syntax as a literal segment (guaranteed 404
      // clients), and each templated segment must be declared as a required path parameter.
      const oasPath = `/api/v1${entry.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
      expect(doc.paths[oasPath], entry.path).toBeDefined();
      expect(doc.components.schemas[entry.name], entry.name).toBeDefined();
      const wantedParams = [...entry.path.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]);
      if (wantedParams.length > 0) {
        const op = doc.paths[oasPath]![entry.method]!;
        expect((op.parameters ?? []).map(param => param.name).sort(), entry.path).toEqual([...wantedParams].sort());
      }
    }
  });

  it("every contracted route is actually mounted (no tautological coverage)", async () => {
    // The document is derived from WIRE_CONTRACT, so asserting the document alone proves
    // nothing. This drives each path live with placeholder ids: any status is fine EXCEPT
    // Express's route-less 404 shape - a renamed handler must fail here, not in a consumer.
    for (const entry of WIRE_CONTRACT) {
      const livePath = `/api/v1${entry.path.replace(/:([A-Za-z0-9_]+)/g, "probe-missing")}`;
      const init =
        entry.method === "post"
          ? { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } }
          : entry.method === "put"
            ? { method: "PUT", body: JSON.stringify({}), headers: { "content-type": "application/json" } }
            : undefined;
      const res = await engine.json(livePath, { apiKey: key, ...(init ?? {}) });
      const body = res.body as { message?: string; error?: string } | null;
      // A resource-level 404 ({error: "... not found"}) proves the route IS mounted; only the
      // global handler's route-less shape ({statusCode, message}) means the path went nowhere.
      const routeMissing = Boolean(
        res.status === 404 && !body?.error && (body?.message === "Not found" || body?.message?.startsWith("Cannot "))
      );
      expect(routeMissing, `${entry.method.toUpperCase()} ${entry.path} -> ${res.status} ${JSON.stringify(body).slice(0, 120)}`).toBe(false);
    }
  });
});
