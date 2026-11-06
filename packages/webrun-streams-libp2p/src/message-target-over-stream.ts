import type { Stream, StreamCloseEvent } from "@libp2p/interface";
import {
  closeStream,
  decodeVarint,
  encodeVarint,
  normalizeChunk,
  PeerGoneError,
} from "./duplex-over-stream.js";

type Listener = (event: MessageEvent) => void | Promise<void>;

/** What `messageTargetOverStream` gives: a byte pipe, and its life. */
export interface StreamMessageTarget {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one length-prefixed frame each.
   */
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    postMessage(message: unknown): void;
    close(): Promise<void>;
    /** The stream's write buffer, in bytes. */
    readonly bufferedAmount: number;
    /**
     * Resolves once the stream can take more (libp2p's `drain`), or has
     * closed; at once when it can now.
     */
    whenDrained(): Promise<void>;
  };
  /**
   * Aborts when the stream is over, after every message the peer sent has
   * been delivered. The reason is a {@link PeerGoneError} when the stream
   * ended without the peer finishing it, or an `Error` when the peer closed
   * it or sent bytes that are not this framing.
   * Pass it as `multiplexPort`'s / `overPipe`'s `signal`, so a dead peer
   * closes the multiplexer and every port on it at once.
   */
  signal: AbortSignal;
}

/** Options for {@link messageTargetOverStream}. */
export interface MessageTargetOverStreamOptions {
  /**
   * The largest message accepted, in bytes. A length prefix past it — or one
   * that is not a valid varint — means the peer is not speaking this framing,
   * so the stream is aborted rather than buffered without bound. Default
   * {@link DEFAULT_MAX_MESSAGE_BYTES}.
   */
  maxMessageBytes?: number;
}

/** 64 MiB: room for a large unframed message, short of exhausting memory. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * One libp2p stream as a pipe of messages, for a multiplexer to run over:
 *
 * ```ts
 * const { target, signal } = messageTargetOverStream(stream);
 * const mux = multiplexPort(target, { codec: msgpackCodec, signal });
 * ```
 *
 * Frames are `[varint length][bytes]`. Reading starts at once, so attach the
 * `message` listener in the same tick: a message with no listener is dropped,
 * as on a `MessagePort`. Every message the peer sent before closing is
 * delivered before `signal` aborts. `postMessage` hands the frame to
 * `stream.send()` and does not wait for room; libp2p buffers up to the
 * stream's `maxWriteBufferLength`, past which it resets the stream. A sender
 * that must wait awaits `whenDrained()`.
 */
export function messageTargetOverStream(
  stream: Stream,
  { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES }: MessageTargetOverStreamOptions = {},
): StreamMessageTarget {
  const listeners = new Set<Listener>();
  const life = new AbortController();
  let peerClosedWrite = false;

  const onRemoteCloseWrite = (): void => {
    // The read loop may still hold the peer's last messages; it aborts
    // `signal` once it has delivered them.
    peerClosedWrite = true;
  };
  const onClose = (evt: StreamCloseEvent): void => {
    stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    if (peerClosedWrite && evt.error == null) return; // the read loop ends it
    life.abort(new PeerGoneError(evt.error));
  };
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  stream.addEventListener("close", onClose, { once: true });

  const deliver = (data: Uint8Array): void => {
    const event = new MessageEvent("message", { data });
    for (const listener of [...listeners]) {
      try {
        // One listener's fault — thrown or rejected — must not stop the read loop.
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };

  void (async () => {
    // Unread bytes are `buf[start, end)`; the buffer grows by doubling, so a
    // large message arriving in many chunks is copied a bounded number of times.
    let buf = new Uint8Array(0);
    let start = 0;
    let end = 0;
    for await (const item of stream) {
      const incoming = normalizeChunk(item);
      if (end + incoming.byteLength > buf.byteLength) {
        const size = end - start + incoming.byteLength;
        const next = new Uint8Array(Math.max(size, buf.byteLength * 2));
        next.set(buf.subarray(start, end), 0);
        buf = next;
        end -= start;
        start = 0;
      }
      buf.set(incoming, end);
      end += incoming.byteLength;
      for (;;) {
        const header = readLength(buf.subarray(start, end));
        if (header === undefined) break; // the length is not all here yet
        if (header.value > maxMessageBytes) {
          throw new Error(
            `webrun-streams-libp2p: a ${header.value}-byte message exceeds maxMessageBytes (${maxMessageBytes})`,
          );
        }
        const stop = start + header.offset + header.value;
        if (end < stop) break;
        deliver(buf.slice(start + header.offset, stop));
        start = stop;
      }
    }
    if (peerClosedWrite) {
      life.abort(new Error("webrun-streams-libp2p: the peer closed the stream"));
      await closeStream(stream);
    }
  })().catch((err: unknown) => {
    // A reset ends the loop with an error, which `close` reports through
    // `signal`; a malformed frame is reported here.
    life.abort(err);
    try {
      stream.abort(err instanceof Error ? err : new Error(String(err)));
    } catch {}
  });
  return {
    signal: life.signal,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const payload = normalizeChunk(message);
        const header = encodeVarint(payload.byteLength);
        const frame = new Uint8Array(header.byteLength + payload.byteLength);
        frame.set(header, 0);
        frame.set(payload, header.byteLength);
        try {
          stream.send(frame);
        } catch {
          // The stream is closed for writing; `signal` says so.
        }
      },
      async close() {
        listeners.clear();
        await closeStream(stream);
      },
      get bufferedAmount() {
        return stream.writeBufferLength;
      },
      whenDrained() {
        if (!stream.writableNeedsDrain || life.signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const done = (): void => {
            stream.removeEventListener("drain", done);
            stream.removeEventListener("close", done);
            resolve();
          };
          stream.addEventListener("drain", done);
          stream.addEventListener("close", done);
        });
      },
    },
  };
}

/** The length prefix of `bytes`, or `undefined` while it is incomplete; throws when malformed. */
function readLength(bytes: Uint8Array): { value: number; offset: number } | undefined {
  try {
    return decodeVarint(bytes, 0);
  } catch (err) {
    if (bytes.byteLength < 5) return undefined;
    throw new Error("webrun-streams-libp2p: a malformed message length", { cause: err });
  }
}
