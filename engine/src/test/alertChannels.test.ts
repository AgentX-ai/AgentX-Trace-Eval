import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverAlert, channelProblem, type AlertNotification } from "../core/monitor/alertChannels.js";

// The PagerDuty channel talks to the real Events API, which the integration suite cannot hit -
// pinned here with fetch intercepted: trigger/resolve follow the rule's lifecycle under one
// dedup key, a TEST page triggers and then resolves itself, and a refused delivery is reported
// (never thrown). Channel validation is pinned alongside.

const notification = (over: Partial<AlertNotification> = {}): AlertNotification => ({
  kind: "triggered",
  status: "FIRING",
  ruleId: "rule-1",
  ruleName: "Latency page",
  severity: "high",
  metric: "p95LatencyMs",
  metricLabel: "p95 latency",
  operator: "gt",
  threshold: 2000,
  thresholdLabel: "2000 ms",
  value: 3100,
  valueLabel: "3100 ms",
  windowMinutes: 15,
  windowLabel: "15m",
  agentId: "agent-1",
  agentName: "Support bot",
  condition: "p95 latency above 2000 ms over the last 15m for agent Support bot",
  title: "[AgentX Alert] FIRING: Latency page",
  summary: "p95 latency above 2000 ms over the last 15m for agent Support bot - currently 3100 ms.",
  at: "2026-09-15T19:05:12.140Z",
  ...over,
});

type Sent = { url: string; body: Record<string, unknown> };

function interceptFetch(status = 202): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(status >= 400 ? "nope" : "", { status });
    })
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PagerDuty channel", () => {
  const channel = { kind: "pagerduty" as const, target: "R0123456789abcdef0123456789abcdef" };

  it("triggers on firing and resolves on recovery under the rule's dedup key", async () => {
    const sent = interceptFetch();
    const fired = await deliverAlert(channel, notification());
    expect(fired).toMatchObject({ kind: "pagerduty", ok: true, status: 202 });
    expect(fired.target).not.toContain("R0123456789abcdef");
    const resolved = await deliverAlert(channel, notification({ kind: "resolved", status: "RESOLVED" }));
    expect(resolved.ok).toBe(true);
    expect(sent.map(s => s.body.event_action)).toEqual(["trigger", "resolve"]);
    expect(sent.map(s => s.body.dedup_key)).toEqual(["agentx-alert-rule-1", "agentx-alert-rule-1"]);
    expect(sent[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    const payload = sent[0]!.body.payload as Record<string, unknown>;
    expect(payload.severity).toBe("error");
    expect(payload.component).toBe("Support bot");
    expect(sent[0]!.body.routing_key).toBe(channel.target);
  });

  it("a TEST page triggers and then resolves itself, on its own dedup key", async () => {
    const sent = interceptFetch();
    const result = await deliverAlert(channel, notification({ kind: "test", status: "TEST" }));
    expect(result.ok).toBe(true);
    expect(sent.map(s => s.body.event_action)).toEqual(["trigger", "resolve"]);
    expect(sent[0]!.body.dedup_key).toBe(sent[1]!.body.dedup_key);
    expect(String(sent[0]!.body.dedup_key)).toMatch(/^agentx-alert-rule-1-test-/);
  });

  it("reports a refused event instead of throwing", async () => {
    interceptFetch(400);
    const result = await deliverAlert(channel, notification());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("HTTP 400");
  });
});

describe("Slack / Teams / webhook payload shapes", () => {
  it("renders each receiver's native shape from one notification", async () => {
    const sent = interceptFetch(200);
    await deliverAlert({ kind: "slack", target: "https://hooks.slack.com/services/T/B/x" }, notification());
    await deliverAlert({ kind: "teams", target: "https://example.webhook.office.com/hook" }, notification({ kind: "resolved", status: "RESOLVED" }));
    await deliverAlert({ kind: "webhook", target: "https://ops.example.com/agentx" }, notification());
    const [slack, teams, webhook] = sent.map(s => s.body);
    expect(String(slack!.text)).toContain("FIRING: Latency page");
    expect((slack!.blocks as unknown[]).length).toBeGreaterThan(2);
    expect(teams!.type).toBe("message");
    const card = (teams!.attachments as { content: { body: { color?: string }[] } }[])[0]!.content;
    expect(card.body[0]!.color).toBe("Good");
    expect(webhook!.event).toBe("alert_rule");
    expect(webhook!.agentName).toBe("Support bot");
    expect(webhook!.value).toBe(3100);
  });
});

describe("channelProblem", () => {
  it("refuses targets that could never deliver", () => {
    expect(channelProblem({ kind: "email", target: "nope" })).toContain("email");
    expect(channelProblem({ kind: "pagerduty", target: "short" })).toContain("routing key");
    expect(channelProblem({ kind: "slack", target: "ftp://hooks" })).toContain("URL");
    expect(channelProblem({ kind: "webhook", target: "http://169.254.169.254/latest" })).not.toBeNull();
    expect(channelProblem({ kind: "email", target: "oncall@example.com" })).toBeNull();
    expect(channelProblem({ kind: "pagerduty", target: "R0123456789abcdef0123456789abcdef" })).toBeNull();
  });
});
