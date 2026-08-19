import { describe, expect, it } from "vitest";
import { checkArgs, parseToolDefinition } from "./proposalValidation.js";

const withPattern = (pattern: string) =>
  parseToolDefinition(
    JSON.stringify({
      name: "lookup",
      description: "d",
      parameters: { type: "object", properties: { code: { type: "string", pattern } }, required: ["code"] },
    })
  )!;

describe("checkArgs pattern validation", () => {
  it("accepts an argument that matches the definition's pattern", () => {
    expect(checkArgs(withPattern("^[A-Z]{3}$"), { code: "ABC" })).toEqual([]);
  });

  it("reports one that does not", () => {
    const problems = checkArgs(withPattern("^[A-Z]{3}$"), { code: "abc" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("should match pattern");
  });

  it("keeps JSON Schema's case-sensitive semantics", () => {
    expect(checkArgs(withPattern("^ABC$"), { code: "abc" })).toHaveLength(1);
  });

  // `pattern` rides in on an operator-supplied tool definition, so it is exactly as untrusted as a
  // monitor regex. Under the built-in engine this call would not return for hours.
  it("does not hang on a catastrophic pattern in the definition", () => {
    const started = Date.now();
    checkArgs(withPattern("(a+)+$"), { code: `${"a".repeat(40)}!` });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("skips a pattern that cannot compile rather than failing the argument", () => {
    expect(checkArgs(withPattern("(unclosed"), { code: "anything" })).toEqual([]);
  });
});
