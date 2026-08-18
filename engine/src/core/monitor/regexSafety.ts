// A custom monitor pattern's regex is stored over the API and then run against production text on
// every ingest. Two ways that goes wrong: it may not compile, which was swallowed at match time so
// the pattern just never fired; or it may backtrack catastrophically, which pins the single thread
// this engine runs on since JS regexes cannot be interrupted. Validating at save time turns both
// into an explainable 400. The scan below is the standard "star height > 1" heuristic, deliberately
// conservative - a false positive costs a reworded regex, a false negative costs an outage.

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

/** Flags a quantifier applied to a group that itself repeats unboundedly - `(a+)+`, `(\w*\s?)*`.
 *  Character classes and escapes are skipped so `\(` and `[+*]` don't read as structure. */
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
  // Scanned before compiling, so a pattern already judged dangerous is never handed to RegExp at
  // all - construction alone is cheap, but there is no reason to build one we are about to refuse.
  if (hasNestedQuantifier(source)) {
    return {
      ok: false,
      error:
        "This regular expression nests one unbounded repetition inside another (e.g. \"(a+)+\"), which can take exponential time on long agent output and would block the engine. Rewrite it without the nested quantifier.",
    };
  }
  try {
    // Same flags detection uses, so a flag-specific syntax error surfaces here, not at match time.
    // CodeQL flags this as regex injection (js/regex-injection) and it is accurate about the flow:
    // `source` is operator-supplied. It is also the entire point of the function - there is no
    // sanitized form of "is this regex valid?" - and the ReDoS shape that makes an injected regex
    // dangerous is rejected by hasNestedQuantifier above, before we get here. Clearing the alert
    // properly means a non-backtracking engine (RE2), which changes matching semantics; until then
    // it wants dismissing in the Security tab, not a code change.
    new RegExp(source, "i");
  } catch (err) {
    return { ok: false, error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
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
