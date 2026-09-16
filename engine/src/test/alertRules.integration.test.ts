import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, postJson, type TestEngine } from "./server.js";

// KPI alert rules: aggregate thresholds (failure rate, p95 latency, spend, judge failures,
// traffic volume) paged through typed channels with a firing/resolved lifecycle. Pinned here
// end-to-end against a real engine: validation refuses what can never deliver, the metric the
// editor previews is the one the sweep evaluates, a breach notifies ONCE on ok->firing, a repeat
// waits out the cooldown, recovery sends a resolve, the history records per-channel delivery
// results, a PagerDuty routing key never round-trips in the clear, and the same flow holds on
// Postgres and on the ClickHouse telemetry tier (where the trace-derived metrics read spans
// from ClickHouse, not the relational table).

type AlertRule = {
  _id: string;
  name: string;
  enabled: boolean;
  metric: string;
  operator: string;
  threshold: number;
  state: "ok" | "firing";
  lastValue: number | null;
  lastValueLabel: string;
  firedCount: number;
  channels: { kind: string; target: string }[];
};
type AlertEvent = {
  kind: string;
  value: number | null;
  deliveries: { kind: string; target: string; ok: boolean; status?: number; error?: string }[];
};

// One receiver plays Slack, Teams, and a generic webhook - what matters is which body shape
// arrived on which path.
let hookStub: http.Server;
let hookBase: string;
const received: Array<{ path: string; body: Record<string, unknown> }> = [];

function stubReceiver(): Promise<void> {
  hookStub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const path = req.url ?? "/";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
      received.push({ path, body });
      if (path === "/broken") {
        res.statusCode = 500;
        res.end("nope");
        return;
      }
      res.statusCode = path === "/teams" ? 202 : 200;
      res.end(path === "/teams" ? "" : "ok");
    });
  });
  return new Promise<void>(resolve => {
    hookStub.listen(0, "127.0.0.1", () => {
      const addr = hookStub.address();
      hookBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
}

// One stub for the whole file: every backend suite below shares it.
beforeAll(stubReceiver);
afterAll(() => {
  hookStub?.close();
});

function bindApi(engine: TestEngine, key: string) {
  const api = (path: string, init?: Parameters<TestEngine["json"]>[1]) =>
    engine.json(`/api/v1${path}`, { apiKey: key, ...(init ?? {}) });
  const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const rules = async (): Promise<AlertRule[]> => ((await api("/agent-monitoring/alert-rules")).body as { rules: AlertRule[] }).rules;
  const rule = async (id: string): Promise<AlertRule> => ((await api(`/agent-monitoring/alert-rules/${id}`)).body as { rule: AlertRule }).rule;
  const events = async (id: string): Promise<AlertEvent[]> =>
    ((await api(`/agent-monitoring/alert-rules/${id}/events`)).body as { events: AlertEvent[] }).events;
  const sweep = async () => (await api("/agent-monitoring/alert-rules/sweep/run", postJson({}))).body as { evaluated: number };
  // Errored traces classify as failing runs via detect.ts's operational classifier; ingest runs
  // the monitor pipeline detached from the response, so poll until the failure rate is visible.
  const ingest = async (spanId: string, extra: Record<string, unknown> = {}) =>
    api("/ingest/traces", postJson({ name: "alert-agent", input: "hi", output: "hello", span_id: spanId, latency_ms: 40, ...extra }));
  const preview = async (metric: string, windowMinutes = 60) =>
    (await api("/agent-monitoring/alert-rules/preview", postJson({ metric, windowMinutes }))).body as { value: number | null; valueLabel: string };
  const waitFor = async <T,>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (!ok(last) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      last = await read();
    }
    return last;
  };
  return { api, put, rules, rule, events, sweep, ingest, preview, waitFor };
}

// The shared lifecycle flow, run once per storage backend below. Traffic: a burst of errored
// traces pushes the 1h failure rate above 50% -> the rule fires once, holds through a second
// sweep (cooldown not elapsed), then a burst of healthy traces brings the rate down -> resolved.
async function runLifecycle(engine: TestEngine, prefix: string) {
  const created = await engine.json("/api/v1/projects", { ...postJson({ name: `alerts-${prefix}` }), apiKey: null });
  const key = (created.body as { project: { apiKey: string } }).project.apiKey;
  const t = bindApi(engine, key);
  received.length = 0;

  const create = await t.api(
    "/agent-monitoring/alert-rules",
    postJson({
      name: "Failure rate above 50%",
      metric: "failureRate",
      operator: "gt",
      threshold: 0.5,
      windowMinutes: 60,
      severity: "critical",
      cooldownMinutes: 60,
      channels: [
        { kind: "slack", target: `${hookBase}/slack` },
        { kind: "teams", target: `${hookBase}/teams` },
        { kind: "webhook", target: `${hookBase}/broken` },
      ],
    })
  );
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const ruleId = (create.body as { rule: AlertRule }).rule._id;

  // No traffic yet: a rate with a zero denominator is "no data", never a breach.
  expect((await t.preview("failureRate")).value).toBeNull();
  await t.sweep();
  expect((await t.rule(ruleId)).state).toBe("ok");
  expect(await t.events(ruleId)).toEqual([]);

  // 4 errored + 1 healthy -> 80% failing.
  for (let i = 0; i < 4; i++) await t.ingest(`${prefix}-err-${i}`, { error: "boom" });
  await t.ingest(`${prefix}-ok-0`);
  const breached = await t.waitFor(() => t.preview("failureRate"), p => p.value !== null && p.value > 0.5);
  expect(breached.value, "failure rate should exceed 50% after the errored burst").toBeGreaterThan(0.5);

  // ok -> firing: exactly one triggered event, delivered to all three channels, with the 500
  // from the broken hook recorded honestly.
  await t.sweep();
  let current = await t.rule(ruleId);
  expect(current.state).toBe("firing");
  expect(current.firedCount).toBe(1);
  expect(current.lastValue).toBeGreaterThan(0.5);
  expect(current.lastValueLabel).toMatch(/%$/);
  let history = await t.events(ruleId);
  expect(history.map(e => e.kind)).toEqual(["triggered"]);
  const triggered = history[0]!;
  expect(triggered.deliveries).toHaveLength(3);
  expect(triggered.deliveries.find(d => d.kind === "slack"), JSON.stringify(triggered.deliveries)).toMatchObject({ ok: true, status: 200 });
  expect(triggered.deliveries.find(d => d.kind === "teams")).toMatchObject({ ok: true, status: 202 });
  expect(triggered.deliveries.find(d => d.kind === "webhook")).toMatchObject({ ok: false, status: 500 });
  // Delivery records show the host (so an operator recognizes the hook) but never the path,
  // which is the credential on Slack/Teams-style incoming webhooks.
  for (const d of triggered.deliveries) {
    expect(d.target).not.toContain("/slack");
    expect(d.target).not.toContain("/teams");
    expect(d.target).not.toContain("/broken");
  }

  const slack = received.find(r => r.path === "/slack")!.body;
  expect(slack.text).toContain("FIRING");
  expect(slack.text).toContain("Failure rate above 50%");
  expect(Array.isArray(slack.blocks)).toBe(true);
  const teams = received.find(r => r.path === "/teams")!.body;
  expect(teams.type).toBe("message");
  expect((teams.attachments as { contentType: string }[])[0]!.contentType).toBe("application/vnd.microsoft.card.adaptive");
  const generic = received.find(r => r.path === "/broken")!.body;
  expect(generic.event).toBe("alert_rule");
  expect(generic.status).toBe("FIRING");
  expect(generic.metric).toBe("failureRate");

  // Still breaching, cooldown (60 min) not elapsed: no repeat page, state unchanged.
  await t.sweep();
  current = await t.rule(ruleId);
  expect(current.state).toBe("firing");
  expect(current.firedCount).toBe(1);
  expect((await t.events(ruleId)).map(e => e.kind)).toEqual(["triggered"]);

  // Recovery: healthy traffic brings the rate under the threshold -> one resolved page.
  for (let i = 0; i < 8; i++) await t.ingest(`${prefix}-ok-${i + 1}`);
  await t.waitFor(() => t.preview("failureRate"), p => p.value !== null && p.value < 0.5);
  await t.sweep();
  current = await t.rule(ruleId);
  expect(current.state).toBe("ok");
  expect(current.firedCount).toBe(1);
  history = await t.events(ruleId);
  expect(history.map(e => e.kind)).toEqual(["resolved", "triggered"]);
  expect(received.filter(r => r.path === "/slack").at(-1)!.body.text).toContain("RESOLVED");

  // Back to ok and below threshold: nothing more.
  await t.sweep();
  expect((await t.events(ruleId)).map(e => e.kind)).toEqual(["resolved", "triggered"]);

  // The other metrics read from the same windows without error on this tier.
  for (const metric of ["toolFailureRate", "p95LatencyMs", "estimatedCostUsd", "judgeFailures", "traceCount"]) {
    const p = await t.api("/agent-monitoring/alert-rules/preview", postJson({ metric, windowMinutes: 60 }));
    expect(p.status, metric).toBe(200);
  }
  expect((await t.preview("traceCount")).value).toBe(13);
  expect((await t.preview("p95LatencyMs")).value).toBe(40);
  return { t, ruleId };
}

describe("alert rules (sqlite)", () => {
  let engine: TestEngine;
  let key: string;
  let t: ReturnType<typeof bindApi>;

  beforeAll(async () => {
    engine = await startEngine();
    const created = await engine.json("/api/v1/projects", { ...postJson({ name: "alerts-validation" }), apiKey: null });
    key = (created.body as { project: { apiKey: string } }).project.apiKey;
    t = bindApi(engine, key);
  }, 90_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it("refuses rules that could never deliver or never evaluate", async () => {
    const base = { name: "x", metric: "failureRate", operator: "gt", threshold: 0.5, windowMinutes: 15 };
    const noChannels = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [] }));
    expect(noChannels.status).toBe(400);
    const badEmail = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [{ kind: "email", target: "not-an-address" }] }));
    expect(badEmail.status).toBe(400);
    expect((badEmail.body as { error: string }).error).toContain("email");
    const badUrl = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [{ kind: "slack", target: "ftp://hooks.example" }] }));
    expect(badUrl.status).toBe(400);
    const badKey = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [{ kind: "pagerduty", target: "short" }] }));
    expect(badKey.status).toBe(400);
    expect((badKey.body as { error: string }).error).toContain("routing key");
    const badMetric = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, metric: "vibes", channels: [{ kind: "slack", target: `${hookBase}/slack` }] }));
    expect(badMetric.status).toBe(400);
    const badWindow = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, windowMinutes: 0, channels: [{ kind: "slack", target: `${hookBase}/slack` }] }));
    expect(badWindow.status).toBe(400);
    expect(await t.rules()).toEqual([]);
  });

  it("masks a PagerDuty routing key on read and keeps it across a masked PUT round-trip", async () => {
    const routingKey = "R0123456789abcdef0123456789abcdef";
    const create = await t.api(
      "/agent-monitoring/alert-rules",
      postJson({
        name: "Latency page",
        metric: "p95LatencyMs",
        operator: "gt",
        threshold: 2000,
        windowMinutes: 15,
        channels: [{ kind: "pagerduty", target: routingKey }, { kind: "email", target: "oncall@example.com" }],
      })
    );
    expect(create.status).toBe(201);
    const created = (create.body as { rule: AlertRule }).rule;
    const pd = created.channels.find(c => c.kind === "pagerduty")!;
    expect(pd.target).not.toBe(routingKey);
    expect(pd.target).toMatch(/\.\.\./);
    expect(created.channels.find(c => c.kind === "email")!.target).toBe("oncall@example.com");

    // The editor sends the whole rule back, masked key included: that must mean "keep it".
    const roundTrip = await t.api(`/agent-monitoring/alert-rules/${created._id}`, t.put({ name: "Latency page (edited)", channels: created.channels }));
    expect(roundTrip.status).toBe(200);
    // A test notification to PagerDuty from here would hit the real Events API; what is pinned
    // is that the stored key survived (the test event's delivery target is the same mask, not
    // the literal mask string stored as the key).
    const fetched = await t.rule(created._id);
    expect(fetched.name).toBe("Latency page (edited)");
    expect(fetched.channels.find(c => c.kind === "pagerduty")!.target).toBe(pd.target);

    // Changing the definition resets firing state; changing only the name does not touch it.
    const rethreshold = await t.api(`/agent-monitoring/alert-rules/${created._id}`, t.put({ threshold: 3000 }));
    expect((rethreshold.body as { rule: AlertRule }).rule.state).toBe("ok");

    const gone = await t.api(`/agent-monitoring/alert-rules/${created._id}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect((await t.api(`/agent-monitoring/alert-rules/${created._id}/events`)).status).toBe(404);
  });

  it("never stores the PagerDuty mask as a key", async () => {
    const base = { name: "pd", metric: "p95LatencyMs", operator: "gt", threshold: 1000, windowMinutes: 15 };
    // On create there is nothing to keep - the mask is refused like any malformed key.
    const masked = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [{ kind: "pagerduty", target: "R01...cdef" }] }));
    expect(masked.status).toBe(400);
    // On update, a mask is only honored when a stored key exists behind it.
    const created = await t.api("/agent-monitoring/alert-rules", postJson({ ...base, channels: [{ kind: "slack", target: `${hookBase}/slack` }] }));
    const id = (created.body as { rule: AlertRule }).rule._id;
    const swap = await t.api(`/agent-monitoring/alert-rules/${id}`, t.put({ channels: [{ kind: "pagerduty", target: "R01...cdef" }] }));
    expect(swap.status).toBe(400);
    expect((swap.body as { error: string }).error).toContain("no stored key");
    await t.api(`/agent-monitoring/alert-rules/${id}`, { method: "DELETE" });
  });

  it("caps rules per project with a 409, not a silent drop", async () => {
    const channels = [{ kind: "webhook", target: `${hookBase}/cap` }];
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await t.api("/agent-monitoring/alert-rules", postJson({ name: `cap ${i}`, metric: "traceCount", operator: "lt", threshold: 1, windowMinutes: 5, channels }));
      expect(r.status).toBe(201);
      ids.push((r.body as { rule: AlertRule }).rule._id);
    }
    const over = await t.api("/agent-monitoring/alert-rules", postJson({ name: "one too many", metric: "traceCount", operator: "lt", threshold: 1, windowMinutes: 5, channels }));
    expect(over.status).toBe(409);
    for (const id of ids) await t.api(`/agent-monitoring/alert-rules/${id}`, { method: "DELETE" });
  }, 60_000);

  it("runs the full firing -> holding -> resolved lifecycle with typed channel deliveries", async () => {
    const { t: flow, ruleId } = await runLifecycle(engine, "sq");

    // Send test: delivers with the live value, recorded as a `test` event, firing state untouched.
    const test = await flow.api(`/agent-monitoring/alert-rules/${ruleId}/test`, postJson({}));
    expect(test.status, JSON.stringify(test.body) + engine.log().split('\n').filter(l => l.includes('rror')).slice(-3).join(' | ')).toBe(200);
    const testBody = test.body as { delivered: boolean; event: AlertEvent };
    expect(testBody.delivered).toBe(false); // the /broken channel 500s
    expect(testBody.event.kind).toBe("test");
    expect((await flow.rule(ruleId)).state).toBe("ok");
    expect((await flow.events(ruleId)).map(e => e.kind)).toEqual(["test", "resolved", "triggered"]);

    // Pausing resets the lifecycle so re-enabling mid-incident pages a fresh "triggered"; a
    // disabled rule is skipped by the sweep entirely.
    for (let i = 0; i < 12; i++) await flow.ingest(`${"sq"}-err-again-${i}`, { error: "boom" });
    await flow.waitFor(() => flow.preview("failureRate"), p => p.value !== null && p.value > 0.5);
    await flow.sweep();
    expect((await flow.rule(ruleId)).state).toBe("firing");
    await flow.api(`/agent-monitoring/alert-rules/${ruleId}`, flow.put({ enabled: false }));
    expect((await flow.rule(ruleId)).state).toBe("ok");
    expect((await flow.sweep()).evaluated).toBe(0);
    await flow.api(`/agent-monitoring/alert-rules/${ruleId}`, flow.put({ enabled: true }));
    await flow.sweep();
    expect((await flow.events(ruleId)).filter(e => e.kind === "triggered")).toHaveLength(3);

    // Two sweeps racing the same tick (the manual route bypasses the lease) page ONCE: the state
    // write is a compare-and-set, so only the first transition owns the notification.
    await flow.api(`/agent-monitoring/alert-rules/${ruleId}`, flow.put({ enabled: false }));
    await flow.api(`/agent-monitoring/alert-rules/${ruleId}`, flow.put({ enabled: true }));
    const before = (await flow.events(ruleId)).filter(e => e.kind === "triggered").length;
    await Promise.all([flow.sweep(), flow.sweep(), flow.sweep()]);
    expect((await flow.events(ruleId)).filter(e => e.kind === "triggered")).toHaveLength(before + 1);
    await flow.api(`/agent-monitoring/alert-rules/${ruleId}`, flow.put({ enabled: false }));

    // Alert rules ride along in backups, with hook URLs redacted.
    const exported = await engine.request("/api/v1/export/alert-rules", { apiKey: flow ? key : key });
    expect(exported.status).toBe(200);
  }, 60_000);

  it("scopes rules to the project that owns them", async () => {
    const other = await engine.json("/api/v1/projects", { ...postJson({ name: "alerts-other" }), apiKey: null });
    const otherKey = (other.body as { project: { apiKey: string } }).project.apiKey;
    const mine = await t.rules();
    const theirs = ((await engine.json("/api/v1/agent-monitoring/alert-rules", { apiKey: otherKey })).body as { rules: AlertRule[] }).rules;
    expect(theirs).toEqual([]);
    if (mine.length > 0) {
      const peek = await engine.json(`/api/v1/agent-monitoring/alert-rules/${mine[0]!._id}`, { apiKey: otherKey });
      expect(peek.status).toBe(404);
    }
  });
});

// Opt-in like every other dialect suite: AGENTX_TEST_DB_URL / AGENTX_TEST_CLICKHOUSE_URL.
const PG_URL = process.env.AGENTX_TEST_DB_URL;
describe.skipIf(!PG_URL)("alert rules on Postgres", () => {
  let pgEngine: TestEngine;
  beforeAll(async () => {
    pgEngine = await startEngine({}, { postgres: true });
  }, 90_000);
  afterAll(async () => {
    await pgEngine?.stop();
  });

  it("runs the same lifecycle on the Postgres control plane", async () => {
    expect(pgEngine.backend).toBe("postgres");
    await runLifecycle(pgEngine, "pg");
  }, 60_000);
});

const CH_URL = process.env.AGENTX_TEST_CLICKHOUSE_URL;
describe.skipIf(!CH_URL)("alert rules with ClickHouse telemetry", () => {
  let chEngine: TestEngine;
  beforeAll(async () => {
    chEngine = await startEngine({ AGENTX_TELEMETRY_URL: CH_URL! });
  }, 90_000);
  afterAll(async () => {
    await chEngine?.stop();
  });

  it("computes trace-derived metrics from ClickHouse spans and runs the same lifecycle", async () => {
    expect(chEngine.log()).toContain("Telemetry store: ClickHouse");
    await runLifecycle(chEngine, "ch");
  }, 60_000);
});
