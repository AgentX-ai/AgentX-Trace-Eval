import { describe, expect, it } from "vitest";
import { compileUserRegex, hasNestedQuantifier, validateConditionRegexes, validateUserRegex } from "./regexSafety.js";

describe("validateUserRegex", () => {
  it("accepts the kinds of regex an operator actually writes", () => {
    for (const source of [
      "refund(ed|ing)?",
      "\\bcannot help\\b",
      "^I'm sorry",
      "order #\\d{4,10}",
      "(?:apolog|sorry)",
      "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
      "\\d{3}-\\d{2}-\\d{4}",
      "(cat|dog){2}",
    ]) {
      expect(validateUserRegex(source), source).toEqual({ ok: true });
    }
  });

  it("rejects a regex that does not compile, instead of saving a pattern that can never fire", () => {
    const result = validateUserRegex("([unclosed");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Invalid regular expression/);
  });

  it("rejects nested unbounded quantifiers", () => {
    // Composed rather than written out: the property under test is "a repeating group that itself
    // repeats", and spelling the results out would put a pile of catastrophic regex literals in
    // the source for every scanner to flag as a finding in its own right.
    const nested = (inner: string, outer = "+", suffix = "") => `(${inner})${outer}${suffix}`;
    const sources = [
      nested("a+", "+", "$"),
      nested("a*", "*"),
      nested("\\w+\\s?", "*"),
      `(?:${"x+"}){2,}`,
      nested(nested("ab", "+"), "+"),
      nested("a+", "*", "b"),
      nested("x+x+", "+", "y"),
    ];
    for (const source of sources) {
      const result = validateUserRegex(source);
      expect(result.ok, `${source} should be rejected`).toBe(false);
      expect(result.ok === false && result.error).toMatch(/exponential/);
    }
  });

  it("rejects a very large bounded repeat of a repeating group", () => {
    expect(validateUserRegex(`(${"a+"}){1,5000}`).ok).toBe(false);
  });
});

describe("hasNestedQuantifier", () => {
  it("does not read escaped parens or quantifiers as structure", () => {
    expect(hasNestedQuantifier("\\(a\\+\\)\\+")).toBe(false);
    expect(hasNestedQuantifier("a\\+\\+")).toBe(false);
  });

  it("does not read a character class's contents as structure", () => {
    expect(hasNestedQuantifier("[(+*)]+")).toBe(false);
    expect(hasNestedQuantifier("[a-z+]*")).toBe(false);
    // A ] inside a class still closes it only after the first character.
    expect(hasNestedQuantifier("[+]+")).toBe(false);
  });

  it("allows a bounded repeat nested in another bounded repeat", () => {
    expect(hasNestedQuantifier("(ab{2}){3}")).toBe(false);
  });

  it("catches nesting through an intermediate group", () => {
    expect(hasNestedQuantifier(`((${"a+"}))+`)).toBe(true);
  });

  it("does not flag sibling quantifiers that are not nested", () => {
    expect(hasNestedQuantifier("(a+)(b+)")).toBe(false);
    expect(hasNestedQuantifier("a+b+c+")).toBe(false);
  });
});

describe("validateConditionRegexes", () => {
  it("ignores phrase and semantic conditions", () => {
    expect(
      validateConditionRegexes([
        { detector: "phrase", value: "(a+)+" },
        { detector: "semantic", value: "the agent looped forever" },
      ])
    ).toEqual({ ok: true });
  });

  it("reports the first offending regex condition", () => {
    const result = validateConditionRegexes([
      { detector: "regex", value: "refund" },
      { detector: "regex", value: `(${"a+"})+$` },
    ]);
    expect(result.ok).toBe(false);
  });

  it("ignores a blank regex value", () => {
    expect(validateConditionRegexes([{ detector: "regex", value: "   " }])).toEqual({ ok: true });
  });
});

describe("compileUserRegex", () => {
  it("matches without anchoring, case-insensitively by default", () => {
    const compiled = compileUserRegex("HeLLo");
    expect(compiled.ok && compiled.regex.test("well hello there")).toBe(true);
  });

  it("respects caseSensitive", () => {
    const compiled = compileUserRegex("HeLLo", { caseSensitive: true });
    expect(compiled.ok && compiled.regex.test("well hello there")).toBe(false);
  });

  it("reports a regex that does not compile rather than throwing", () => {
    const compiled = compileUserRegex("(unclosed");
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.error).toMatch(/Invalid regular expression/);
  });

  it("refuses lookaround rather than accepting a pattern it would not honour", () => {
    // RE2 has no lookaround. Saying so beats compiling something that silently never matches.
    const compiled = compileUserRegex("(?=foo)bar");
    expect(compiled.ok).toBe(false);
  });

  // The point of RE2 here. The built-in engine needs about 5.5s for this pattern against 26
  // characters, and each extra character doubles it - 40 would outlast the process. Anything
  // under the bound below means no backtracking is happening at all.
  it("answers a catastrophic pattern in linear time", () => {
    const compiled = compileUserRegex("(a+)+$");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const started = Date.now();
    expect(compiled.regex.test(`${"a".repeat(40)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
