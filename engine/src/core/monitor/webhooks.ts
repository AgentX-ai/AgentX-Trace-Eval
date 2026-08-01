// LangSmith-style "webhook automation" equivalent: monitor_profiles.channels was persisted from
// the start (dashboard's per-agent settings dialog) but self-host never had any notification
// delivery — nothing interpreted it. No new schema: a channel entry of the form `webhook:<url>`
// is treated as a delivery target, everything else in `channels` (there's no other kind on
// self-host yet) is left alone.

export function extractWebhookUrls(channels: string[] | null | undefined): string[] {
  return (channels ?? [])
    .filter((c): c is string => typeof c === "string" && c.startsWith("webhook:"))
    .map(c => c.slice("webhook:".length).trim())
    .filter(url => url.length > 0);
}

export type WebhookSignal = {
  summary: string;
  severity: string;
  patternKey: string;
  agentId: string | null;
  rootCause?: string | null;
};

// Fire-and-forget, non-blocking: a webhook target being slow or down must never delay trace
// ingest. No retry queue (self-host has none) — a failed delivery is logged and dropped, matching
// this engine's general shrug-and-log posture toward best-effort side effects (e.g. suggestion
// endpoints' failure path) rather than introducing durability machinery for a notification.
export function notifyWebhooks(urls: string[], signal: WebhookSignal): void {
  if (urls.length === 0) {
    return;
  }
  // Slack's incoming-webhook format only requires a top-level `text` string and ignores unknown
  // fields, so pointing `channels` at a Slack webhook URL works with zero extra glue; anything
  // else gets the same JSON body with the full structured fields to parse itself.
  const payload = {
    text: `[AgentX Monitor] ${signal.severity.toUpperCase()}: ${signal.summary}`,
    severity: signal.severity,
    patternKey: signal.patternKey,
    agentId: signal.agentId,
    rootCause: signal.rootCause ?? null,
    summary: signal.summary,
  };
  for (const url of urls) {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(err => {
      console.error(`Monitor webhook delivery failed (${url}):`, err instanceof Error ? err.message : err);
    });
  }
}
