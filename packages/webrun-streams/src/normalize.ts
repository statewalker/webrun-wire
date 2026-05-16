const utf8 = new TextEncoder();

export type ByteLike = Uint8Array | ArrayBuffer | ArrayBufferView | Blob | string;

/**
 * Coerce common byte-like inputs into a `Uint8Array`. Strings encode as UTF-8.
 * Blobs return a `Promise<Uint8Array>`; every other input returns synchronously.
 * Throws `TypeError` for anything else.
 */
export function normalizeToUint8Array(data: ByteLike): Uint8Array | Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  if (typeof data === "string") return utf8.encode(data);
  throw new TypeError(
    `normalizeToUint8Array: unsupported input ${describe(data)}; expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, or string`,
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t !== "object") return t;
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "object";
}
