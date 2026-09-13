// Converts a decoded OTLP AnyValue into a plain JS value, and a KeyValue[] list into a Record.
// Shared by every span/resource/event attribute list, and by both wire formats - but the two
// don't actually agree on shape: protobufjs's toObject({oneofs:true}) (protoTypes.ts) adds a
// virtual `value` discriminator field naming which branch is set, but that's a protobufjs
// convenience, not part of OTLP itself - a genuine OTLP/JSON body from a real exporter has only
// the actual `stringValue`/`intValue`/etc. field set, no discriminator at all. Checking each
// field's presence directly (rather than switching on the discriminator) works for both.

type WireAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: WireAnyValue[] };
  kvlistValue?: { values?: WireKeyValue[] };
  bytesValue?: string;
};

type WireKeyValue = { key?: string; value?: WireAnyValue };

// Depth cap: OTLP AnyValue nests arbitrarily (arrayValue/kvlistValue), and a hostile or buggy
// exporter nesting a few thousand levels overflowed the stack OUTSIDE the decode try/catch -
// a 500 the exporter treats as retryable, redelivering the same poison forever. 32 levels is
// far past any real attribute; beyond it the value flattens to undefined (dropped key).
const MAX_ANY_VALUE_DEPTH = 32;

export function anyValueToJs(av: WireAnyValue | undefined, depth = 0): unknown {
  if (!av || depth > MAX_ANY_VALUE_DEPTH) {
    return undefined;
  }
  if (av.stringValue !== undefined) {
    return av.stringValue;
  }
  if (av.boolValue !== undefined) {
    return av.boolValue;
  }
  if (av.intValue !== undefined) {
    return Number(av.intValue);
  }
  if (av.doubleValue !== undefined) {
    return av.doubleValue;
  }
  if (av.bytesValue !== undefined) {
    // Left base64-encoded rather than decoded to a Buffer: attribute values land in AgentX's
    // `metadata`/mapped fields as JSON, which can't hold raw bytes anyway.
    return av.bytesValue;
  }
  if (av.arrayValue !== undefined) {
    return (av.arrayValue.values ?? []).map(v => anyValueToJs(v, depth + 1));
  }
  if (av.kvlistValue !== undefined) {
    return keyValueListToRecord(av.kvlistValue.values ?? [], depth + 1);
  }
  return undefined;
}

export function keyValueListToRecord(kvs: WireKeyValue[] | undefined, depth = 0): Record<string, unknown> {
  // Null prototype: attribute keys are caller-controlled wire data, and on a plain object a key
  // named "__proto__" would not become an own property - it would silently rewire the record's
  // prototype (or be dropped), shadowing every later lookup. With no prototype at all, every
  // key is just a key.
  const out: Record<string, unknown> = Object.create(null);
  for (const kv of kvs ?? []) {
    if (typeof kv?.key === "string") {
      out[kv.key] = anyValueToJs(kv.value, depth);
    }
  }
  return out;
}
