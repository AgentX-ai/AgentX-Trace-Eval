import { describe, expect, it } from "vitest";
import { runCodeScorer, type CodeScorerConfig } from "./codeScorer.js";

// Dataset-defined scorers are arbitrary JS supplied over the API and executed in-process. The
// contract runs.ts relies on is absolute: runCodeScorer must ALWAYS resolve, never reject and
// never hang, or one bad scorer takes the judge rating and similarity scores of every item in the
// batch down with it.

const scorer = (code: string): CodeScorerConfig => ({ id: "s1", name: "test-scorer", code, enabled: true });
const args = { input: "what is 2+2?", output: "4", expected: "4" };

describe("runCodeScorer", () => {
  it("accepts a bare numeric return", async () => {
    expect(await runCodeScorer(scorer("return output === expected ? 1 : 0;"), args)).toEqual({ name: "test-scorer", score: 1 });
  });

  it("accepts a { score, reasoning } return", async () => {
    expect(await runCodeScorer(scorer('return { score: 0.5, reasoning: "partial" };'), args)).toEqual({
      name: "test-scorer",
      score: 0.5,
      reasoning: "partial",
    });
  });

  it("exposes input, output, expected and toolCalls to the scorer", async () => {
    const result = await runCodeScorer(
      scorer("return { score: 1, reasoning: [input, output, expected, JSON.stringify(toolCalls)].join('|') };"),
      { ...args, toolCalls: [{ name: "lookup" }] }
    );
    expect(result.reasoning).toBe('what is 2+2?|4|4|[{"name":"lookup"}]');
  });

  it("reports a syntax error instead of throwing", async () => {
    const result = await runCodeScorer(scorer("return ("), args);
    expect(result.score).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("reports a thrown error instead of throwing", async () => {
    const result = await runCodeScorer(scorer('throw new Error("scorer exploded");'), args);
    expect(result.score).toBeNull();
    // Stringified rather than unwrapped via .message: an Error constructed inside the vm context
    // comes from that realm's Error constructor, so `instanceof Error` is false out here.
    expect(result.error).toContain("scorer exploded");
  });

  it("rejects a non-finite score", async () => {
    expect((await runCodeScorer(scorer("return 1/0;"), args)).error).toMatch(/non-finite/);
    expect((await runCodeScorer(scorer("return NaN;"), args)).error).toMatch(/non-finite/);
  });

  it("rejects a return shape it cannot score", async () => {
    for (const code of ["return 'ten';", "return null;", "return;", "return { reasoning: 'no score' };", "return [1];"]) {
      const result = await runCodeScorer(scorer(code), args);
      expect(result.score, code).toBeNull();
      expect(result.error, code).toBeTruthy();
    }
  });

  it("bounds an infinite loop with the timeout rather than hanging the engine", async () => {
    const started = Date.now();
    const result = await runCodeScorer(scorer("while (true) {}"), args);
    const elapsed = Date.now() - started;
    expect(result.score).toBeNull();
    expect(result.error).toBeTruthy();
    // The documented budget is 3s; allow generous slack for a loaded CI box but not an unbounded wait.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it("binds no require/process/fetch/module into the scorer's own scope", async () => {
    // Worth pinning so a future change doesn't casually widen the context - but note this is the
    // shallow check only. node:vm is not a security boundary and the scorer can still reach this
    // realm through any object's prototype chain; see runCodeScorer's own comment.
    for (const global of ["require", "process", "fetch", "globalThis.process", "module"]) {
      const result = await runCodeScorer(scorer(`return typeof ${global} === "undefined" ? 1 : 0;`), args);
      expect(result.score, `${global} was bound directly into the context`).toBe(1);
    }
  });

  it("resolves rather than rejecting for every failure mode, which runs.ts depends on", async () => {
    const codes = ["while(true){}", "throw new Error('x')", "return (", "return undefined", "await 1"];
    const results = await Promise.all(codes.map(code => runCodeScorer(scorer(code), args)));
    expect(results).toHaveLength(codes.length);
    for (const result of results) {
      expect(result.name).toBe("test-scorer");
    }
  }, 30_000);
});
