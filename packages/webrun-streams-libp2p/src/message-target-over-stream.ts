import type { Stream, StreamCloseEvent } from "@libp2p/interface";
import {
  ByteBuffer,
  closeStream,
  encodeVarint,
  normalizeChunk,
  PeerGoneError,
  readLength,
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
    /** Sends one message. Throws `TypeError` for anything but bytes. */
    postMessage(message: unknown): void;
    close(): Promise<void>;
    /** The stream's write buffer, in bytes. */
    readonly bufferedAmount: number;
    /**
     * Resolves once the stream can take more (libp2p's `drain`), or has
     * closed; at once when it can now.
     */
    whenDrained(): Promise<void>;
    /** `signal` again, on the target: `webrun-rpc`'s `getPortCloseSignal` reads it from a port. */
    readonly closeSignal: AbortSignal;
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
  // The peer may have finished, or reset the stream, before this target was attached (during
  // protocol negotiation): its events are gone then, and only the stream's state tells.
  let peerClosedWrite = stream.remoteWriteStatus === "closed";

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
  // A stream reset or closed before this target was attached (a peer refusing it during protocol
  // negotiation) fired its `close` unseen: report it now, as a dead peer.
  if (stream.status !== undefined && stream.status !== "open") life.abort(new PeerGoneError());

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
    // The buffer grows by doubling, so a large message arriving in many chunks
    // is copied a bounded number of times.
    const buf = new ByteBuffer();
    for await (const item of stream) {
      buf.push(normalizeChunk(item));
      for (;;) {
        const bytes = buf.unread();
        const header = readLength(bytes, "message");
        if (header === undefined) break; // the length is not all here yet
        if (header.value > maxMessageBytes) {
          throw new Error(
            `webrun-streams-libp2p: a ${header.value}-byte message exceeds maxMessageBytes (${maxMessageBytes})`,
          );
        }
        const stop = header.offset + header.value;
        if (bytes.byteLength < stop) break;
        const message = bytes.slice(header.offset, stop);
        buf.consume(stop);
        deliver(message);
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
      closeSignal: life.signal,
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const payload = toBytes(message);
        if (!payload) {
          throw new TypeError(
            `webrun-streams-libp2p: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
          );
        }
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

/** `message` as bytes, or `undefined` when it is not bytes */
function toBytes(message: unknown): Uint8Array | undefined {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return undefined;
}
