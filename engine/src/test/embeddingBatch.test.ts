import { describe, expect, it } from "vitest";
import { embedBatched, type EmbeddingClient } from "../core/evaluate/judge.js";

// Batching turns ~120 serialized round trips into one. What makes that safe rather than merely fast
// is failure isolation: the embeddings API rejects an ENTIRE request when any single input exceeds
// the model's token limit, and the caller caches nothing from a failure and rebuilds the same batch
// next time - so a batch that fails as a unit does not lose one case, it blocks every case behind it
// forever. These pin that it splits instead.

/** A client that rejects any request containing `poison`, the way an over-long input does.
 * The thrown error carries `.status` like the real SDK's APIError - splitting keys on it:
 * only payload-shaped failures (400/413) are worth halving; transient ones are not. */
const clientRejecting = (poison: string) => {
  const calls: string[][] = [];
  const client: EmbeddingClient = {
    embeddings: {
      create: async ({ input }) => {
        calls.push(input);
        if (input.includes(poison)) {
          throw Object.assign(new Error("400 - requested too many tokens"), { status: 400 });
        }
        return { data: input.map((text, index) => ({ index, embedding: [text.length, 0] })) };
      },
    },
  };
  return { client, calls };
};

describe("embedBatched", () => {
  it("isolates the one input the API rejects and keeps the rest", async () => {
    const { client, calls } = clientRejecting("bad");

    const result = await embedBatched(client, ["a", "b", "bad", "c"]);

    expect(result.map(vector => vector === null)).toEqual([false, false, true, false]);
    // The whole batch is attempted first - splitting is the fallback, not the default.
    expect(calls[0]).toEqual(["a", "b", "bad", "c"]);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("finds the offender in a logarithmic number of requests, not a linear one", async () => {
    const { client, calls } = clientRejecting("bad");
    const texts = Array.from({ length: 32 }, (_, index) => (index === 19 ? "bad" : `t${index}`));

    const result = await embedBatched(client, texts);

    expect(result[19]).toBeNull();
    expect(result.filter(vector => vector === null)).toHaveLength(1);
    // Halving: ~2·log2(32) requests, nowhere near one per input.
    expect(calls.length).toBeLessThan(16);
  });

  it("sends exactly one request when nothing fails", async () => {
    const { client, calls } = clientRejecting("nothing-matches");

    const result = await embedBatched(client, ["a", "b", "c"]);

    expect(calls).toEqual([["a", "b", "c"]]);
    expect(result.every(vector => vector !== null)).toBe(true);
  });

  it("keeps every slot aligned with its input, including blanks", async () => {
    const { client, calls } = clientRejecting("nothing-matches");

    const result = await embedBatched(client, ["alpha", "   ", "be"]);

    expect(calls).toEqual([["alpha", "be"]]);
    expect(result).toEqual([[5, 0], null, [2, 0]]);
  });

  it("maps vectors by the response's own index rather than by position", async () => {
    const client: EmbeddingClient = {
      embeddings: {
        create: async ({ input }) => ({
          data: input.map((_, index) => ({ index, embedding: [index] })).reverse(),
        }),
      },
    };

    expect(await embedBatched(client, ["x", "y", "z"])).toEqual([[0], [1], [2]]);
  });

  it("a transient provider failure leaves the batch pending WITHOUT splitting", async () => {
    // A 429/5xx means the PROVIDER is failing - halving would fire 2^k requests at an
    // endpoint that just said stop. One request, whole batch null (pending for next time).
    let calls = 0;
    const client: EmbeddingClient = {
      embeddings: {
        create: async () => {
          calls++;
          throw Object.assign(new Error("500"), { status: 500 });
        },
      },
    };

    expect(await embedBatched(client, ["a", "b"])).toEqual([null, null]);
    expect(calls).toBe(1);
  });
});
