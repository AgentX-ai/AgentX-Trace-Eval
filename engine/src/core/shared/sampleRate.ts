// Sampling rate for the checks that support throttling - monitor patterns, online evaluators and
// custom evaluators. core/monitor/routing.ts's passesSampleRate reads it as: >= 1 always runs,
// <= 0 never runs, anything between is a coin flip.
//
// That reading is why an unvalidated value is worse than it looks. `sampleRate: -1` and
// `sampleRate: "half"` were both accepted and stored verbatim, and both mean the check NEVER
// RUNS - while the dashboard keeps showing it as enabled. A silently dead evaluator is the single
// hardest failure to notice in a monitoring product, so the boundary rejects the value instead.
// Same shape as core/shared/severity.ts's validator, applied by the same router-level middleware.
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
