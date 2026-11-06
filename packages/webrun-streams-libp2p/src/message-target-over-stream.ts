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
     * closed; at once when it can now. A multiplexer with `frameSize` waits
     * on it between frames.
     */
    whenDrained(): Promise<void>;
  };
  /**
   * Aborts when the stream is over. The reason is a {@link PeerGoneError}
   * when the connection died, or an `Error` when the peer closed the stream.
   * Pass it as `multiplexPort`'s / `overPipe`'s `signal`, so a dead peer
   * closes the multiplexer and every port on it at once.
   */
  signal: AbortSignal;
}

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
 * as on a `MessagePort`. `postMessage` hands the frame to `stream.send()` and
 * does not wait for room; libp2p buffers up to the stream's
 * `maxWriteBufferLength`, past which it resets the stream. A sender that must
 * wait — `multiplexPort` with `frameSize` — awaits `whenDrained()`.
 */
export function messageTargetOverStream(stream: Stream): StreamMessageTarget {
  const listeners = new Set<Listener>();
  const life = new AbortController();
  let peerClosedWrite = false;

  const onRemoteCloseWrite = (): void => {
    peerClosedWrite = true;
    life.abort(new Error("webrun-streams-libp2p: the peer closed the stream"));
    void closeStream(stream);
  };
  const onClose = (evt: StreamCloseEvent): void => {
    stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    life.abort(
      peerClosedWrite && evt.error == null
        ? new Error("webrun-streams-libp2p: the stream was closed")
        : new PeerGoneError(evt.error),
    );
  };
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  stream.addEventListener("close", onClose, { once: true });

  const deliver = (data: Uint8Array): void => {
    const event = new MessageEvent("message", { data });
    for (const listener of [...listeners]) {
      try {
        void listener(event);
      } catch {
        // One listener's fault must not stop the read loop.
      }
    }
  };

  void (async () => {
    let buf = new Uint8Array(0);
    for await (const item of stream) {
      const incoming = normalizeChunk(item);
      const merged = new Uint8Array(buf.byteLength + incoming.byteLength);
      merged.set(buf, 0);
      merged.set(incoming, buf.byteLength);
      buf = merged;
      for (;;) {
        let header: { value: number; offset: number };
        try {
          header = decodeVarint(buf, 0);
        } catch {
          break; // the length is not all here yet
        }
        const end = header.offset + header.value;
        if (buf.byteLength < end) break;
        deliver(buf.slice(header.offset, end));
        buf = buf.subarray(end);
      }
    }
  })().catch(() => {
    // A reset ends the loop with an error; `close` reports it through `signal`.
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
