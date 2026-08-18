// Custom monitor patterns let an operator store a regular expression that the engine then runs
// against production text on every ingest (core/monitor/conditions.ts's evaluateDetector). Two
// things go wrong with a regex arriving over an API:
//
// 1. It may not compile. Today that is swallowed at match time and the pattern simply never
//    fires - the operator gets a saved pattern, a green dashboard row, and silence forever.
// 2. It may compile and backtrack catastrophically. `(a+)+$` against ~40 'a's followed by a 'b'
//    takes exponential time, and because JS regexes cannot be interrupted, that pins the single
//    thread this engine runs on: no route responds, no health check answers, for every project on
//    the box. The matched text is agent output, which end users influence, so the length needed
//    to trigger it is not under the operator's control.
//
// Validating at save time turns both into an immediate, explainable 400. The nested-quantifier
// scan below is the standard "star height > 1" heuristic: it is deliberately conservative (it can
// reject a pattern that would have been fine) because the cost of a false positive is an operator
// rewording a regex, and the cost of a false negative is an outage.

export type RegexValidation = { ok: true } | { ok: false; error: string };

const UNBOUNDED_QUANTIFIERS = new Set(["*", "+"]);

// True for a quantifier that permits an unbounded (or merely large) number of repeats, which is
// what makes nesting explosive. `{2}` and `{1,3}` are bounded and safe to nest.
function unboundedQuantifierAt(source: string, index: number): boolean {
  const char = source[index];
  if (char === undefined) {
    return false;
  }
  if (UNBOUNDED_QUANTIFIERS.has(char)) {
    return true;
  }
  if (char !== "{") {
    return false;
  }
  const close = source.indexOf("}", index);
  if (close === -1) {
    return false;
  }
  const body = source.slice(index + 1, close);
  const match = /^(\d+)(,(\d*))?$/.exec(body);
  if (!match) {
    return false;
  }
  // `{n,}` is unbounded; `{n,m}` and `{n}` are bounded, but a large m is explosive all the same.
  const openEnded = match[2] !== undefined && !match[3];
  const upper = match[3] ? Number(match[3]) : Number(match[1]);
  return openEnded || upper > 100;
}

/**
 * Flags a quantifier applied to a group that itself contains an unbounded quantifier - `(a+)+`,
 * `(\w*\s?)*`, `(?:x+){2,}` and friends. Character classes and escaped characters are skipped so
 * `\(`, `[+*]` and `\+` don't read as structure.
 */
export function hasNestedQuantifier(source: string): boolean {
  // One entry per open group: whether an unbounded quantifier has been seen inside it so far.
  const groupStack: boolean[] = [];
  let inCharClass = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (inCharClass) {
      if (char === "]") {
        inCharClass = false;
      }
      continue;
    }
    if (char === "[") {
      inCharClass = true;
      continue;
    }
    if (char === "(") {
      groupStack.push(false);
      continue;
    }
    if (char === ")") {
      const innerHadUnbounded = groupStack.pop() ?? false;
      // A quantifier immediately after the closing paren applies to the whole group.
      const quantified = unboundedQuantifierAt(source, i + 1);
      if (innerHadUnbounded && quantified) {
        return true;
      }
      // The group's own quantifier still counts as unbounded repetition inside its parent.
      if ((innerHadUnbounded || quantified) && groupStack.length > 0) {
        groupStack[groupStack.length - 1] = true;
      }
      continue;
    }
    if (unboundedQuantifierAt(source, i) && groupStack.length > 0) {
      groupStack[groupStack.length - 1] = true;
    }
  }
  return false;
}

export function validateUserRegex(source: string): RegexValidation {
  try {
    // Compiled with the same flags detection uses, so a flag-specific syntax error surfaces here
    // rather than at match time.
    new RegExp(source, "i");
  } catch (err) {
    return { ok: false, error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (hasNestedQuantifier(source)) {
    return {
      ok: false,
      error:
        "This regular expression nests one unbounded repetition inside another (e.g. \"(a+)+\"), which can take exponential time on long agent output and would block the engine. Rewrite it without the nested quantifier.",
    };
  }
  return { ok: true };
}

/** Every regex condition in a pattern's condition list, validated together. */
export function validateConditionRegexes(conditions: { detector?: string; value?: string }[]): RegexValidation {
  for (const condition of conditions) {
    if (condition.detector !== "regex" || typeof condition.value !== "string" || !condition.value.trim()) {
      continue;
    }
    const result = validateUserRegex(condition.value.trim());
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
