// Shared by Platform Settings' LLM provider keys (routes/agentMonitoringDashboard.ts) and
// per-model custom API keys (core/evaluate/models.ts) — neither ever round-trips a raw stored
// secret back to the frontend once set, only this masked form.
export function maskSecret(key: string): string {
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}
