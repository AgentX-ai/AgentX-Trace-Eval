// The one severity vocabulary every signal-raising surface shares (patterns, online evaluators,
// custom evaluators, signal triage edits). The dashboard's pickers already restrict to these
// four; this validator closes the REST gap where any string used to be accepted and produced
// signals the severity chips and filters don't know how to render.
export const VALID_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof VALID_SEVERITIES)[number];

export function isValidSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (VALID_SEVERITIES as readonly string[]).includes(value);
}

// For route handlers: undefined passes through (the core layer applies its default), a valid
// string passes, anything else returns an error message for a 400.
export function validateSeverityParam(value: unknown): { ok: true; severity: Severity | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, severity: undefined };
  if (isValidSeverity(value)) return { ok: true, severity: value };
  return { ok: false, error: `severity must be one of: ${VALID_SEVERITIES.join(", ")}` };
}
