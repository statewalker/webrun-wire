import { deserialize, serialize } from "./msgpack-core.js";

/**
 * Encode each value as a length-prefixed msgpack frame.
 * Frame format: [4-byte big-endian length][msgpack bytes]
 *
 * The input may be synchronous (an array, a generator) or asynchronous.
 */
export async function* encodeMsgpack<T>(
  input: Iterable<T> | AsyncIterable<T>,
): AsyncGenerator<Uint8Array> {
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
 * The default ceiling on one frame's payload length, in bytes (64 MiB, the same as
 * `webrun-rpc`'s `DEFAULT_MAX_REASSEMBLED_BYTES`).
 */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Options for {@link decodeMsgpack} and {@link decodeFloat32Arrays}. */
export interface DecodeMsgpackOptions {
  /**
   * The largest payload length a frame header may announce, in bytes. A header above it throws
   * a `RangeError` as soon as it is read, before any of the payload is buffered.
   * Defaults to {@link DEFAULT_MAX_FRAME_BYTES}.
   */
  maxFrameBytes?: number;
}

/**
 * Decode length-prefixed msgpack frames, reassembling across chunk boundaries.
 *
 * The input may be synchronous (an array of chunks) or asynchronous. A frame whose header
 * announces more than `maxFrameBytes` throws a `RangeError`.
 */
export function decodeMsgpack<T>(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DecodeMsgpackOptions = {},
): AsyncGenerator<T> {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!(maxFrameBytes >= 0)) {
    throw new RangeError(`maxFrameBytes must be a non-negative number, got ${maxFrameBytes}`);
  }
  return decodeFrames<T>(input, maxFrameBytes);
}

async function* decodeFrames<T>(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  maxFrameBytes: number,
): AsyncGenerator<T> {
  // Chunks are kept as a list with a byte total and copied out once per complete frame, so
  // reassembly is linear in the bytes received whatever the chunk size.
  const chunks: Uint8Array[] = [];
  let total = 0;
  let frameLen = -1; // -1 while the next header is not read yet

  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let offset = 0;
    let used = 0;
    while (offset < n) {
      const c = chunks[used] as Uint8Array;
      const need = n - offset;
      if (c.length <= need) {
        out.set(c, offset);
        offset += c.length;
        used++;
      } else {
        out.set(c.subarray(0, need), offset);
        chunks[used] = c.subarray(need);
        offset = n;
      }
    }
    chunks.splice(0, used);
    total -= n;
    return out;
  };

  for await (const chunk of input) {
    if (chunk.length === 0) continue;
    chunks.push(chunk);
    total += chunk.length;

    while (true) {
      if (frameLen < 0) {
        if (total < 4) break;
        const head = take(4);
        frameLen = new DataView(head.buffer).getUint32(0, false);
        if (frameLen > maxFrameBytes) {
          throw new RangeError(
            `decodeMsgpack: frame of ${frameLen} bytes exceeds maxFrameBytes (${maxFrameBytes})`,
          );
        }
      }
      if (total < frameLen) break;
      const payload = take(frameLen);
      frameLen = -1;
      yield deserialize(payload) as T;
    }
  }
}

/**
 * Encode each Float32Array as a msgpack frame.
 * The Float32Array is converted to a Uint8Array view (zero-copy) before encoding as msgpack bin.
 *
 * The input may be synchronous (an array, a generator) or asynchronous.
 */
export async function* encodeFloat32Arrays(
  input: Iterable<Float32Array> | AsyncIterable<Float32Array>,
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
 *
 * The input may be synchronous (an array of chunks) or asynchronous.
 */
export async function* decodeFloat32Arrays(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options: DecodeMsgpackOptions = {},
): AsyncGenerator<Float32Array> {
  for await (const item of decodeMsgpack<Uint8Array>(input, options)) {
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
