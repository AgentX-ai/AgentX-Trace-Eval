import { describe, expect, it, vi } from "vitest";
import { applyJudgePromptTemplate, callJudgeJson, getProviderForModel } from "./index.js";

describe("getProviderForModel", () => {
  it("routes claude- models to anthropic", () => {
    expect(getProviderForModel("claude-3-5-sonnet-latest")).toBe("anthropic");
  });

  it("routes everything else to openai", () => {
    expect(getProviderForModel("gpt-4.1-mini")).toBe("openai");
    expect(getProviderForModel("gpt-5.5")).toBe("openai");
  });
});

describe("applyJudgePromptTemplate", () => {
  it("substitutes known variables", () => {
    const result = applyJudgePromptTemplate("Q: {input} A: {output} Expected: {expected}", {
      input: "2+2?",
      output: "4",
      expected: "4",
    });
    expect(result).toBe("Q: 2+2? A: 4 Expected: 4");
  });

  it("leaves unknown tokens as-is instead of stripping them", () => {
    const result = applyJudgePromptTemplate("Hello {name}, {input}", { input: "hi" });
    expect(result).toBe("Hello {name}, hi");
  });
});

describe("callJudgeJson", () => {
  it("calls the OpenAI client via the Responses API and parses JSON output", async () => {
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: '{"rating": 9, "justification": "close enough"}',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };

    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "gpt-4.1-mini",
      jsonSchema: { type: "object" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: client as any,
    });

    expect(client.responses.create).toHaveBeenCalledOnce();
    expect(result.payload).toEqual({ rating: 9, justification: "close enough" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("calls the Anthropic client for claude- models and strips markdown fences", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '```json\n{"rating": 3, "justification": "wrong"}\n```' }],
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
      },
    };

    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "claude-3-5-sonnet-latest",
      jsonSchema: { type: "object" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
    });

    expect(client.messages.create).toHaveBeenCalledOnce();
    expect(result.payload).toEqual({ rating: 3, justification: "wrong" });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it("returns a null payload without throwing when no client is provided", async () => {
    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "gpt-4.1-mini",
      jsonSchema: { type: "object" },
    });
    expect(result).toEqual({ payload: null, usage: null });
  });

  it("returns a null payload with parseError when the model's response isn't valid JSON", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not json at all" }],
          usage: {},
        }),
      },
    };

    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "claude-3-5-sonnet-latest",
      jsonSchema: { type: "object" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
    });

    // payload must stay null on a parse failure (see callAnthropicJson's own comment: returning
    // the raw string used to leak a char-indexed object into persisted analysis fields). The raw
    // text stays reachable for logging via error/failureReason.
    expect(result.payload).toBeNull();
    expect(result.failureReason).toBe("parseError");
    expect(result.usage).toBeNull();
  });
});
