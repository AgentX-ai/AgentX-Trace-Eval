import { describe, expect, it } from "vitest";
import { anyValueToJs, keyValueListToRecord } from "./attributes.js";

// Every span, resource and event attribute the OTLP path reads goes through here, from both wire
// formats - a protobufjs-decoded object and a hand-written OTLP/JSON body, which do not agree on
// shape. Anything this drops silently becomes a missing model name, a missing token count, or a
// tool call the engine never sees.

describe("anyValueToJs", () => {
  it("unwraps each scalar branch", () => {
    expect(anyValueToJs({ stringValue: "gpt-4o-mini" })).toBe("gpt-4o-mini");
    expect(anyValueToJs({ boolValue: true })).toBe(true);
    expect(anyValueToJs({ doubleValue: 0.75 })).toBe(0.75);
  });

  it("accepts intValue as either a number or the string protobuf JSON uses for int64", () => {
    expect(anyValueToJs({ intValue: 120 })).toBe(120);
    expect(anyValueToJs({ intValue: "120" })).toBe(120);
  });

  it("preserves values that are legitimately falsy rather than treating them as absent", () => {
    // A zero token count is a real measurement; dropping it to undefined would read as "unknown".
    expect(anyValueToJs({ intValue: 0 })).toBe(0);
    expect(anyValueToJs({ intValue: "0" })).toBe(0);
    expect(anyValueToJs({ stringValue: "" })).toBe("");
    expect(anyValueToJs({ boolValue: false })).toBe(false);
    expect(anyValueToJs({ doubleValue: 0 })).toBe(0);
  });

  it("leaves bytes base64-encoded, since attributes end up as JSON", () => {
    expect(anyValueToJs({ bytesValue: "aGVsbG8=" })).toBe("aGVsbG8=");
  });

  it("maps arrays element by element", () => {
    expect(anyValueToJs({ arrayValue: { values: [{ stringValue: "a" }, { intValue: "2" }, { boolValue: false }] } })).toEqual(["a", 2, false]);
    expect(anyValueToJs({ arrayValue: {} })).toEqual([]);
    expect(anyValueToJs({ arrayValue: { values: [] } })).toEqual([]);
  });

  it("maps nested key-value lists into plain objects", () => {
    expect(
      anyValueToJs({
        kvlistValue: {
          values: [
            { key: "model", value: { stringValue: "gpt-4o" } },
            { key: "nested", value: { kvlistValue: { values: [{ key: "depth", value: { intValue: "2" } }] } } },
          ],
        },
      })
    ).toEqual({ model: "gpt-4o", nested: { depth: 2 } });
  });

  it("returns undefined for an absent or unrecognised value", () => {
    expect(anyValueToJs(undefined)).toBeUndefined();
    expect(anyValueToJs({})).toBeUndefined();
  });

  it("loses no precision on token counts and other realistic integers", () => {
    for (const value of ["0", "1", "120", "4096", "1000000", String(Number.MAX_SAFE_INTEGER)]) {
      expect(anyValueToJs({ intValue: value }), value).toBe(Number(value));
    }
  });

  it("documents that an int64 beyond Number's range does lose precision", () => {
    // Number() is lossy past 2^53. No attribute the mapping reads (token counts, indexes) gets
    // anywhere near it, but the behaviour is worth pinning rather than assumed exact.
    const huge = "9223372036854775807";
    expect(anyValueToJs({ intValue: huge })).toBe(9223372036854776000);
    expect(String(anyValueToJs({ intValue: huge }))).not.toBe(huge);
  });
});

describe("keyValueListToRecord", () => {
  it("builds a record from a KeyValue list", () => {
    expect(
      keyValueListToRecord([
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
      ])
    ).toEqual({ "gen_ai.request.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 120 });
  });

  it("returns an empty record for missing or empty input", () => {
    expect(keyValueListToRecord(undefined)).toEqual({});
    expect(keyValueListToRecord([])).toEqual({});
  });

  it("skips entries with no usable key instead of throwing", () => {
    expect(
      keyValueListToRecord([
        { value: { stringValue: "orphan" } },
        { key: 42 as unknown as string, value: { stringValue: "numeric key" } },
        { key: "good", value: { stringValue: "kept" } },
      ])
    ).toEqual({ good: "kept" });
  });

  it("keeps a key whose value is absent, as undefined rather than dropping the key", () => {
    expect(keyValueListToRecord([{ key: "present-but-empty" }])).toEqual({ "present-but-empty": undefined });
  });

  it("lets a later duplicate key win, matching plain object assignment", () => {
    expect(
      keyValueListToRecord([
        { key: "dup", value: { stringValue: "first" } },
        { key: "dup", value: { stringValue: "second" } },
      ])
    ).toEqual({ dup: "second" });
  });

  it("tolerates a null entry in the list", () => {
    expect(() => keyValueListToRecord([null as never, { key: "k", value: { stringValue: "v" } }])).not.toThrow();
    expect(keyValueListToRecord([null as never, { key: "k", value: { stringValue: "v" } }])).toEqual({ k: "v" });
  });
});
