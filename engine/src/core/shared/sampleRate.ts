// core/monitor/routing.ts reads a sample rate as: >= 1 always runs, <= 0 never runs, between is a
// coin flip. So `-1` and the string "half" were both accepted, stored verbatim, and meant the check
// NEVER RUNS while the dashboard showed it as enabled. Same shape as severity.ts's validator,
// applied by the same router-level middleware.
export function isValidSampleRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// For route handlers: undefined passes through (the core layer applies its own default), a valid
// number passes, anything else returns an error message for a 400.
export function validateSampleRateParam(
  value: unknown
): { ok: true; sampleRate: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, sampleRate: undefined };
  if (isValidSampleRate(value)) return { ok: true, sampleRate: value };
  return { ok: false, error: "sampleRate must be a number between 0 and 1" };
}
