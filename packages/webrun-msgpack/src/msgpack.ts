import msgpack from "@ygoe/msgpack";

const { serialize, deserialize } = msgpack;

/**
 * Encode each value as a length-prefixed msgpack frame.
 * Frame format: [4-byte big-endian length][msgpack bytes]
 */
export async function* encodeMsgpack<T>(input: AsyncIterable<T>): AsyncGenerator<Uint8Array> {
  for await (const item of input) {
    const payload = serialize(item);
    const frame = new Uint8Array(4 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, payload.length, false);
    frame.set(payload, 4);
    yield frame;
  }
}

/**
 * Decode length-prefixed msgpack frames, reassembling across chunk boundaries.
 */
export async function* decodeMsgpack<T>(input: AsyncIterable<Uint8Array>): AsyncGenerator<T> {
  let buffer: Uint8Array = new Uint8Array(0);

  for await (const chunk of input) {
    buffer = concat(buffer, chunk);

    while (buffer.length >= 4) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const frameLen = view.getUint32(0, false);
      if (buffer.length < 4 + frameLen) break;

      const payload = buffer.subarray(4, 4 + frameLen);
      buffer = buffer.subarray(4 + frameLen);
      yield deserialize(Uint8Array.from(payload)) as T;
    }
  }
}

/**
 * Encode each Float32Array as a msgpack frame.
 * The Float32Array is converted to a Uint8Array view (zero-copy) before encoding as msgpack bin.
 */
export async function* encodeFloat32Arrays(
  input: AsyncIterable<Float32Array>,
): AsyncGenerator<Uint8Array> {
  for await (const arr of input) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const payload = serialize(bytes);
    const frame = new Uint8Array(4 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, payload.length, false);
    frame.set(payload, 4);
    yield frame;
  }
}

/**
 * Decode msgpack frames back to Float32Array.
 * Each frame contains a msgpack bin value (Uint8Array), reinterpreted as Float32Array.
 */
export async function* decodeFloat32Arrays(
  input: AsyncIterable<Uint8Array>,
): AsyncGenerator<Float32Array> {
  for await (const item of decodeMsgpack<Uint8Array>(wrapIterable(input))) {
    const aligned = alignBuffer(item);
    yield new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  }
}

function alignBuffer(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return aligned;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

async function* wrapIterable<T>(input: AsyncIterable<T>): AsyncGenerator<T> {
  yield* input;
}
