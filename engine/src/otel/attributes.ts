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

export function anyValueToJs(av: WireAnyValue | undefined): unknown {
  if (!av) {
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
    return (av.arrayValue.values ?? []).map(anyValueToJs);
  }
  if (av.kvlistValue !== undefined) {
    return keyValueListToRecord(av.kvlistValue.values ?? []);
  }
  return undefined;
}

export function keyValueListToRecord(kvs: WireKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs ?? []) {
    if (typeof kv?.key === "string") {
      out[kv.key] = anyValueToJs(kv.value);
    }
  }
  return out;
}
