// Shared by Platform Settings' LLM provider keys (routes/agentMonitoringDashboard.ts) and
// per-model custom API keys (core/evaluate/models.ts) - neither ever round-trips a raw stored
// secret back to the frontend once set, only this masked form.
export function maskSecret(key: string): string {
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// Whether a value IS the masked form above - PUT round-trips send it back verbatim to mean
// "keep the stored secret", and writers must never store the mask itself.
export function isMaskedSecret(value: string): boolean {
  return value === "••••" || /^.{3}\.\.\..{4}$/.test(value);
}
