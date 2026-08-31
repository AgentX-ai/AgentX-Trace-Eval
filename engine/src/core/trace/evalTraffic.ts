
// Offline evaluation runs produce real traces - that is what makes trajectory matching and
// retrieval-context extraction work - but they are not production traffic, and a nightly
// 200-case eval must not read as Monday's production health. The SDK stamps those traces
// source = "eval-run" at ingest; this module is the one place that says what that means:
//
//   - monitor surfaces (KPIs, span metrics, sessions, model comparison, live-traces default
//     view) EXCLUDE eval traffic, via productionTracesOnly below
//   - cost INCLUDES it, split out, because eval judge/agent spend is real money and hiding it
//     would be its own kind of lie
//   - per-trace features (open a trace from a run result, trajectory, retrieval context) are
//     untouched - they address traces by id, not by aggregation
//
// The vocabulary is deliberately one value. "playground" or "synthetic" can join later; until
// something produces them, an enum of one is honest.
export const EVAL_RUN_SOURCE = "eval-run";

// Parse what a producer stated. Unknown words become null (production) rather than being stored
// as a fact nobody defined - the same posture as normalizeSpanKind.
export function normalizeTraceSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim().toLowerCase() === EVAL_RUN_SOURCE ? EVAL_RUN_SOURCE : null;
}

