import { logger } from "../../log.js";
import { maskSecret } from "../shared/maskSecret.js";
import { outboundUrlProblem } from "../shared/urlGuard.js";
import { mailerConfigured, sendMail } from "../../auth/mailer.js";
import type { AlertEventKind, AlertMetric, AlertOperator, AlertSeverity } from "./alertRules.js";

// Typed alert channels: each kind renders the notification in the shape its receiver expects
// (Slack Block Kit, a Teams Adaptive Card, a PagerDuty Events v2 trigger/resolve pair, an
// email, or the raw JSON for a generic webhook) - so an ops team wires a rule to a Slack hook
// and gets a readable page, instead of parsing our payload in a middleware of their own.
//
// Delivery here is AWAITED and returns a result per channel (unlike webhooks.ts's
// fire-and-forget signal notifications): an alert rule records whether every channel accepted
// the page, because "did it actually go out?" is the first question after an incident.

export type AlertChannelKind = "slack" | "teams" | "pagerduty" | "email" | "webhook";

export const ALERT_CHANNEL_KINDS: readonly AlertChannelKind[] = ["slack", "teams", "pagerduty", "email", "webhook"];

// `target` is a URL for slack/teams/webhook, an address for email, a routing (integration)
// key for pagerduty.
export type AlertChannel = { kind: AlertChannelKind; target: string };

export type AlertNotification = {
  kind: AlertEventKind;
  status: "FIRING" | "RESOLVED" | "TEST";
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: AlertMetric;
  metricLabel: string;
  operator: AlertOperator;
  threshold: number;
  thresholdLabel: string;
  value: number | null;
  valueLabel: string;
  windowMinutes: number;
  windowLabel: string;
  agentId: string | null;
  agentName: string | null;
  condition: string;
  title: string;
  summary: string;
  at: string;
};

export type AlertDelivery = {
  kind: AlertChannelKind;
  // Never the raw target: a hook URL or routing key is the credential.
  target: string;
  ok: boolean;
  status?: number;
  error?: string;
};

const DELIVERY_TIMEOUT_MS = 8000;
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validation shared by the routes (refuse at the door) and, defensively, by delivery.
export function channelProblem(channel: AlertChannel): string | null {
  const target = channel.target.trim();
  if (!target) return "channel target is required";
  switch (channel.kind) {
    case "slack":
    case "teams":
    case "webhook": {
      const problem = outboundUrlProblem(target);
      return problem ? `${channel.kind} URL ${problem}` : null;
    }
    case "email":
      return EMAIL_RE.test(target) ? null : "email target is not a valid address";
    case "pagerduty":
      // Events API v2 integration keys are 32 characters; be lenient on length, strict on shape.
      return /^[A-Za-z0-9_-]{16,64}$/.test(target) ? null : "pagerduty target must be an Events API v2 routing key";
    default:
      return `unknown channel kind ${String((channel as { kind: string }).kind)}`;
  }
}

function displayTarget(channel: AlertChannel): string {
  if (channel.kind === "email") return channel.target;
  if (channel.kind === "pagerduty") return maskSecret(channel.target);
  try {
    const url = new URL(channel.target);
    return `${url.host}${maskSecret(url.pathname)}`;
  } catch {
    return "(invalid url)";
  }
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = { low: ":large_blue_circle:", medium: ":large_yellow_circle:", high: ":large_orange_circle:", critical: ":red_circle:" };

function slackPayload(n: AlertNotification): Record<string, unknown> {
  const marker = n.status === "RESOLVED" ? ":white_check_mark:" : SEVERITY_EMOJI[n.severity];
  return {
    text: `${n.title} - ${n.summary}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${n.status}: ${n.ruleName}`, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `${marker} ${n.summary}` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Metric*\n${n.metricLabel}` },
          { type: "mrkdwn", text: `*Current*\n${n.valueLabel}` },
          { type: "mrkdwn", text: `*Threshold*\n${n.operator === "gt" ? "above" : "below"} ${n.thresholdLabel}` },
          { type: "mrkdwn", text: `*Window*\nlast ${n.windowLabel}` },
          { type: "mrkdwn", text: `*Severity*\n${n.severity}` },
          { type: "mrkdwn", text: `*Agent*\n${n.agentName ?? n.agentId ?? "all agents"}` },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `AgentX alert rule \`${n.ruleId}\` · ${n.at}` }] },
    ],
  };
}

// Adaptive Card in the `attachments` envelope - accepted by both the classic Office 365
// incoming-webhook connector and the Workflows (Power Automate) replacement.
function teamsPayload(n: AlertNotification): Record<string, unknown> {
  const facts = [
    { title: "Metric", value: n.metricLabel },
    { title: "Current", value: n.valueLabel },
    { title: "Threshold", value: `${n.operator === "gt" ? "above" : "below"} ${n.thresholdLabel}` },
    { title: "Window", value: `last ${n.windowLabel}` },
    { title: "Severity", value: n.severity },
    { title: "Agent", value: n.agentName ?? n.agentId ?? "all agents" },
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              size: "Large",
              weight: "Bolder",
              color: n.status === "RESOLVED" ? "Good" : n.severity === "critical" || n.severity === "high" ? "Attention" : "Warning",
              text: `${n.status}: ${n.ruleName}`,
              wrap: true,
            },
            { type: "TextBlock", text: n.summary, wrap: true },
            { type: "FactSet", facts },
            { type: "TextBlock", size: "Small", isSubtle: true, text: `AgentX alert rule ${n.ruleId} · ${n.at}`, wrap: true },
          ],
        },
      },
    ],
  };
}

const PAGERDUTY_SEVERITY: Record<AlertSeverity, "info" | "warning" | "error" | "critical"> = {
  low: "info",
  medium: "warning",
  high: "error",
  critical: "critical",
};

// Events API v2: the dedup key ties the resolve to the trigger, so the incident PagerDuty
// opened on ok->firing is the one it closes on firing->ok. A test notification uses its own key
// and is resolved right after it is triggered (see deliverAlert), so the on-call sees the page
// land without a stray open incident left behind.
function pagerdutyPayload(n: AlertNotification, routingKey: string, action: "trigger" | "resolve", dedupKey: string): Record<string, unknown> {
  return {
    routing_key: routingKey,
    event_action: action,
    dedup_key: dedupKey,
    payload: {
      summary: `${n.status}: ${n.ruleName} - ${n.summary}`.slice(0, 1024),
      severity: PAGERDUTY_SEVERITY[n.severity],
      source: "agentx",
      component: n.agentName ?? n.agentId ?? "all-agents",
      group: "agentx-alert-rules",
      class: n.metric,
      timestamp: n.at,
      custom_details: {
        metric: n.metric,
        value: n.value,
        valueLabel: n.valueLabel,
        threshold: n.threshold,
        thresholdLabel: n.thresholdLabel,
        operator: n.operator,
        windowMinutes: n.windowMinutes,
        ruleId: n.ruleId,
        notification: n.kind,
      },
    },
  };
}

// The generic-webhook body: every structured field, plus a top-level `text` so a receiver
// that only reads Slack-style bodies still shows something readable.
export function webhookPayload(n: AlertNotification): Record<string, unknown> {
  return { text: `${n.title} - ${n.summary}`, event: "alert_rule", ...n };
}

function emailBody(n: AlertNotification): string {
  return [
    `${n.status}: ${n.ruleName}`,
    "",
    n.summary,
    "",
    `Metric:    ${n.metricLabel}`,
    `Current:   ${n.valueLabel}`,
    `Threshold: ${n.operator === "gt" ? "above" : "below"} ${n.thresholdLabel}`,
    `Window:    last ${n.windowLabel}`,
    `Severity:  ${n.severity}`,
    `Agent:     ${n.agentName ?? n.agentId ?? "all agents"}`,
    "",
    `AgentX alert rule ${n.ruleId} at ${n.at}`,
  ].join("\n");
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    // The URL was vetted, a redirect target was not - never follow one.
    redirect: "manual",
  });
  if (res.ok) return { ok: true, status: res.status };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
}

export async function deliverAlert(channel: AlertChannel, notification: AlertNotification): Promise<AlertDelivery> {
  const target = displayTarget(channel);
  const problem = channelProblem(channel);
  if (problem) {
    return { kind: channel.kind, target, ok: false, error: problem };
  }
  try {
    switch (channel.kind) {
      case "slack": {
        const r = await postJson(channel.target.trim(), slackPayload(notification));
        return { kind: channel.kind, target, ...r };
      }
      case "teams": {
        // A Workflows webhook answers 202 with an empty body; the classic connector answers
        // 200 with "1". Both are `ok`.
        const r = await postJson(channel.target.trim(), teamsPayload(notification));
        return { kind: channel.kind, target, ...r };
      }
      case "webhook": {
        const r = await postJson(channel.target.trim(), webhookPayload(notification));
        return { kind: channel.kind, target, ...r };
      }
      case "pagerduty": {
        const routingKey = channel.target.trim();
        if (notification.kind === "test") {
          const dedupKey = `agentx-alert-${notification.ruleId}-test-${Date.now()}`;
          const triggered = await postJson(PAGERDUTY_EVENTS_URL, pagerdutyPayload(notification, routingKey, "trigger", dedupKey));
          if (!triggered.ok) return { kind: channel.kind, target, ...triggered };
          const resolved = await postJson(PAGERDUTY_EVENTS_URL, pagerdutyPayload(notification, routingKey, "resolve", dedupKey));
          return { kind: channel.kind, target, ...resolved };
        }
        const action = notification.status === "RESOLVED" ? "resolve" : "trigger";
        const r = await postJson(PAGERDUTY_EVENTS_URL, pagerdutyPayload(notification, routingKey, action, `agentx-alert-${notification.ruleId}`));
        return { kind: channel.kind, target, ...r };
      }
      case "email": {
        if (!mailerConfigured()) {
          return {
            kind: channel.kind,
            target,
            ok: false,
            error: "No mailer configured (set AGENTX_SMTP_URL, AGENTX_RESEND_API_KEY, or AGENTX_EMAIL_DEBUG_DIR)",
          };
        }
        await sendMail({ to: channel.target.trim(), subject: notification.title, text: emailBody(notification) });
        return { kind: channel.kind, target, ok: true };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ kind: channel.kind, target, err: message }, "Alert channel delivery failed");
    return { kind: channel.kind, target, ok: false, error: message };
  }
}
