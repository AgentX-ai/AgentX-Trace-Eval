import { logger } from "../../log.js";
import { maskSecret } from "../shared/maskSecret.js";
import { outboundUrlProblem } from "../shared/urlGuard.js";
// LangSmith-style "webhook automation" equivalent: monitor_profiles.channels was persisted from
// the start (dashboard's per-agent settings dialog) but self-host never had any notification
// delivery - nothing interpreted it. No new schema: a channel entry of the form `webhook:<url>`
// is treated as a delivery target, everything else in `channels` (there's no other kind on
// self-host yet) is left alone.
//
// Runtime egress guard (channels are stored free-form, so write-time validation alone can't
// cover them): the shared outboundUrlProblem check - http(s) only, never a cloud metadata
// endpoint, private targets gated only on multi-tenant. See core/shared/urlGuard.ts for the
// full posture.


const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
};

export function extractWebhookUrls(channels: string[] | null | undefined): string[] {
  return (channels ?? [])
    .filter((c): c is string => typeof c === "string" && c.startsWith("webhook:"))
    .map(c => c.slice("webhook:".length).trim())
    .filter(url => url.length > 0 && outboundUrlProblem(url) === null);
}

export type WebhookSignal = {
  summary: string;
  severity: string;
  patternKey: string;
  agentId: string | null;
  rootCause?: string | null;
};

// Matches customEvaluators.ts's own budget. Without a deadline a target that accepts the
// connection and never answers holds a socket for undici's multi-minute default, and signals
// arrive as fast as traffic does.
const WEBHOOK_TIMEOUT_MS = 8000;

// Fire-and-forget, non-blocking: a webhook target being slow or down must never delay trace
// ingest. No retry queue (self-host has none) - a failed delivery is logged and dropped, matching
// this engine's general shrug-and-log posture toward best-effort side effects (e.g. suggestion
// endpoints' failure path) rather than introducing durability machinery for a notification.
export function notifyWebhooks(urls: string[], signal: WebhookSignal): void {
  // Slack's incoming-webhook format only requires a top-level `text` string and ignores unknown
  // fields, so pointing `channels` at a Slack webhook URL works with zero extra glue; anything
  // else gets the same JSON body with the full structured fields to parse itself.
  postWebhooks(urls, {
    text: `[AgentX Monitor] ${signal.severity.toUpperCase()}: ${signal.summary}`,
    severity: signal.severity,
    patternKey: signal.patternKey,
    agentId: signal.agentId,
    rootCause: signal.rootCause ?? null,
    summary: signal.summary,
  });
}

// A stored bad target skips on every signal it would have received - warned once per URL per
// process, not once per skip.
const warnedBlockedUrls = new Set<string>();

// The delivery primitive both callers share: signal notifications above, and automation rules'
// webhook action (core/monitor/rules.ts), which sends its own rule-shaped payload.
export function postWebhooks(urls: string[], payload: Record<string, unknown>): void {
  if (urls.length === 0) {
    return;
  }
  for (const url of urls) {
    // Re-vetted at send time: extractWebhookUrls guards profile channels, but rules.ts hands its
    // webhook-action URL straight in, and a URL stored before a posture change (e.g. flipping a
    // deployment to multi-tenant) outlives its write-time check.
    const problem = outboundUrlProblem(url);
    if (problem) {
      if (!warnedBlockedUrls.has(url)) {
        warnedBlockedUrls.add(url);
        logger.warn(`Monitor webhook target skipped (${url}): ${problem}`);
      }
      continue;
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      // The URL was vetted, a redirect target was not - never follow one (it could bounce the
      // POST to a metadata endpoint the guard just refused).
      redirect: "manual",
    })
      .then(res => {
        // fetch only rejects on transport failure, so a 404 from a mistyped Slack URL was
        // indistinguishable from a delivered notification.
        if (!res.ok) {
          // The URL IS the credential for Slack/Teams-style incoming hooks - log the host
          // and a masked tail, never the whole thing, or every failing delivery exfiltrates
          // it into the log stream.
          logger.error(
            { host: safeHost(url), url: maskSecret(url), status: res.status },
            "Monitor webhook delivery failed"
          );
        }
      })
      .catch(err => {
        logger.error(
          { err: err instanceof Error ? err.message : err, host: safeHost(url), url: maskSecret(url) },
          "Monitor webhook delivery failed"
        );
      });
  }
}
