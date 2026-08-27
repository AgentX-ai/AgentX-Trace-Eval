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
  it("substitutes {context} for RAG-style prompts", () => {
    const result = applyJudgePromptTemplate("Ctx: {context} Q: {input}", {
      context: "chunk one\nchunk two",
      input: "what is covered?",
    });
    expect(result).toBe("Ctx: chunk one\nchunk two Q: what is covered?");
  });

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

  it("retries once on invalid JSON, then returns parseError with payload still null", async () => {
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

    // One automatic retry, with the failure spelled out in the second message.
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const secondMessage = client.messages.create.mock.calls[1]![0].messages[0].content as string;
    expect(secondMessage).toContain("not valid JSON");
    // payload must stay null on a parse failure (see callAnthropicJson's own comment: returning
    // the raw string used to leak a char-indexed object into persisted analysis fields). The raw
    // text stays reachable for logging via error/failureReason.
    expect(result.payload).toBeNull();
    expect(result.failureReason).toBe("parseError");
    expect(result.retried).toBe(true);
    expect(result.usage).toBeNull();
  });

  it("recovers a verdict when the retry parses, summing usage across both attempts", async () => {
    const client = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ content: [{ type: "text", text: "garbage" }], usage: { input_tokens: 10, output_tokens: 2 } })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: '{"rating": 7, "justification": "ok"}' }],
            usage: { input_tokens: 12, output_tokens: 6 },
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

    expect(result.payload).toEqual({ rating: 7, justification: "ok" });
    expect(result.retried).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 8 });
  });

  it("does not retry when the client is missing (a second call would fail identically)", async () => {
    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "claude-3-5-sonnet-latest",
      jsonSchema: { type: "object" },
    });
    expect(result.payload).toBeNull();
    expect(result.retried).toBeUndefined();
  });

  it("uses strict json_schema output and honors maxTokens on the OpenAI path when strictSchema is set", async () => {
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: '{"rating": 8, "justification": "solid"}',
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
      },
    };

    const schema = {
      type: "object",
      properties: { rating: { type: "number" }, justification: { type: "string" } },
      required: ["rating", "justification"],
    };
    const result = await callJudgeJson({
      userMessage: "grade this",
      model: "gpt-4.1-mini",
      jsonSchema: schema,
      maxTokens: 900,
      strictSchema: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: client as any,
    });

    expect(result.payload).toEqual({ rating: 8, justification: "solid" });
    const call = client.responses.create.mock.calls[0]![0];
    expect(call.max_output_tokens).toBe(900);
    expect(call.text.format.type).toBe("json_schema");
    expect(call.text.format.strict).toBe(true);
    // additionalProperties stamped in for strict mode; required left exactly as authored.
    expect(call.text.format.schema.additionalProperties).toBe(false);
    expect(call.text.format.schema.required).toEqual(["rating", "justification"]);
    // With the decoder enforcing the schema, it is no longer pasted into the prompt.
    expect(call.input).not.toContain("JSON schema");
  });

  it("gives reasoning models max_output_tokens headroom instead of the literal budget", async () => {
    const client = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: '{"rating": 5, "justification": "mid"}',
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
      },
    };

    await callJudgeJson({
      userMessage: "grade this",
      model: "gpt-5.6-luna",
      jsonSchema: { type: "object" },
      maxTokens: 1200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: client as any,
    });

    const call = client.responses.create.mock.calls[0]![0];
    expect(call.max_output_tokens).toBe(8192);
    expect(call.temperature).toBeUndefined();
  });
});
