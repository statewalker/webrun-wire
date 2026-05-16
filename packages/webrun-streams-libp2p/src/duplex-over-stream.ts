import type { Stream } from "@libp2p/interface";
import { deserializeError, serializeError } from "@statewalker/webrun-streams";

const TYPE_DATA = 0x00;
const TYPE_ERROR = 0x02;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Options for {@link duplexOverStream}. The `onPeerInputEnd` hook is the seam
 * that lets the server side close its input queue as soon as the peer's source
 * exhausts — without it, the server-side `serve` would deadlock waiting for the
 * outbound pump to finish, which itself waits for the handler, which waits for
 * inputQueue.done.
 */
export interface DuplexOverStreamOptions {
  /**
   * Fired when the peer's source ends (peer closed write, sent an ERROR frame,
   * or the stream itself was torn down). Idempotent. The optional `err`
   * argument carries the deserialized error from an ERROR frame, if any.
   */
  onPeerInputEnd?(err?: Error): void;
  /**
   * Fired only when the peer's source ended naturally — i.e., consumer did not
   * `.return()` mid-stream. Connect/serve uses this to decide whether to
   * gracefully close vs forcibly abort the underlying stream on teardown.
   */
  onSourceCompleted?(): void;
}

/**
 * Drive one `Duplex` over one libp2p `Stream` using a small in-band framing
 * protocol:
 *
 *     [1-byte type][varint length][payload bytes]
 *
 * Types are `DATA` (0x00, body bytes) and `ERROR` (0x02, followed by a
 * JSON-serialised `Error`). Normal end-of-input is signalled by libp2p's
 * `closeWrite()`. The frame layer exists so we can preserve `Error` fidelity
 * across the wire (yamux's native stream reset only carries "stream reset").
 */
export async function* duplexOverStream(
  stream: Stream,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  opts: DuplexOverStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  let peerEndedCalled = false;
  const firePeerInputEnd = (err?: Error): void => {
    if (peerEndedCalled) return;
    peerEndedCalled = true;
    opts.onPeerInputEnd?.(err);
  };

  const outboundSource = framedOutbound(input);
  const outbound = (async () => {
    try {
      await (stream as unknown as { sink(s: AsyncIterable<Uint8Array>): Promise<void> }).sink(
        outboundSource,
      );
      await stream.closeWrite();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        stream.abort(e);
      } catch {
        /* ignore */
      }
    } finally {
      // Always return the framed-outbound generator so its `input` (often a
      // handler async generator) sees `.return()` and runs its finally —
      // otherwise an unbounded handler keeps running after the transport dies.
      try {
        await outboundSource.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
  })();

  let sourceCompleted = false;
  try {
    for await (const frame of parseFrames(stream.source)) {
      if (frame.type === TYPE_DATA) {
        yield frame.payload;
      } else if (frame.type === TYPE_ERROR) {
        const err = decodeError(frame.payload);
        firePeerInputEnd(err);
        throw err;
      }
    }
    sourceCompleted = true;
    firePeerInputEnd();
    opts.onSourceCompleted?.();
  } finally {
    firePeerInputEnd();
    // If the consumer aborted before the source completed, force the outbound
    // generator to return so `await outbound` doesn't hang on a still-pumping
    // handler. On natural source completion we DO NOT cut outbound short —
    // peer closing write doesn't entitle us to silence our own writes.
    if (!sourceCompleted) {
      try {
        await outboundSource.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
    await outbound;
  }
}

async function* framedOutbound(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of toAsyncIterable(input)) {
      yield frameData(chunk);
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    yield frameError(e);
  }
}

async function* parseFrames(
  source: AsyncIterable<unknown>,
): AsyncGenerator<{ type: number; payload: Uint8Array }> {
  let buf = new Uint8Array(0);
  for await (const item of source) {
    const incoming = normalizeChunk(item);
    if (incoming.byteLength === 0) continue;
    if (buf.byteLength === 0) {
      buf = new Uint8Array(incoming);
    } else {
      const merged = new Uint8Array(buf.byteLength + incoming.byteLength);
      merged.set(buf, 0);
      merged.set(incoming, buf.byteLength);
      buf = merged;
    }
    while (buf.byteLength > 0) {
      if (buf.byteLength < 2) break; // need at least type + 1 varint byte
      const type = buf[0];
      let lenInfo: { value: number; offset: number };
      try {
        lenInfo = decodeVarint(buf, 1);
      } catch {
        break; // varint truncated, need more bytes
      }
      const total = lenInfo.offset + lenInfo.value;
      if (buf.byteLength < total) break;
      const payload = new Uint8Array(buf.subarray(lenInfo.offset, total));
      yield { type, payload };
      buf = buf.byteLength === total ? new Uint8Array(0) : new Uint8Array(buf.subarray(total));
    }
  }
}

function normalizeChunk(item: unknown): Uint8Array {
  if (item instanceof Uint8Array) return item;
  const asList = item as { subarray?: () => Uint8Array };
  if (typeof asList.subarray === "function") {
    return new Uint8Array(asList.subarray());
  }
  return new Uint8Array(0);
}

function frameData(payload: Uint8Array): Uint8Array {
  const lenEnc = encodeVarint(payload.byteLength);
  const out = new Uint8Array(1 + lenEnc.byteLength + payload.byteLength);
  out[0] = TYPE_DATA;
  out.set(lenEnc, 1);
  out.set(payload, 1 + lenEnc.byteLength);
  return out;
}

function frameError(err: Error): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(serializeError(err)));
  const lenEnc = encodeVarint(payload.byteLength);
  const out = new Uint8Array(1 + lenEnc.byteLength + payload.byteLength);
  out[0] = TYPE_ERROR;
  out.set(lenEnc, 1);
  out.set(payload, 1 + lenEnc.byteLength);
  return out;
}

function decodeError(payload: Uint8Array): Error {
  if (payload.byteLength === 0) return new Error("unknown stream error");
  try {
    return deserializeError(JSON.parse(textDecoder.decode(payload)));
  } catch {
    return new Error(textDecoder.decode(payload));
  }
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`encodeVarint: ${value} is not a non-negative integer`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function decodeVarint(buf: Uint8Array, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, offset: i };
    shift += 7;
    if (shift > 28) throw new Error("decodeVarint: too long");
  }
  throw new Error("decodeVarint: truncated");
}

function toAsyncIterable(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if ((input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]) {
    return input as AsyncIterable<Uint8Array>;
  }
  const it = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(it.next()),
      };
    },
  };
}
