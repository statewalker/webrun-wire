import type { ByteChannel } from "./types.js";

type Listener = (event: MessageEvent) => void | Promise<void>;

/**
 * The payload ceiling for a channel over an `RTCDataChannel` (`PeerManager`,
 * `QrSignaling`, `PeerConnection`): 16 KiB, the message size every browser
 * pair delivers, less the 256 bytes the port stack's framing needs (spec D10).
 * For a `byteChannelFromRoom` channel pass `maxMessageSize: 12 * 1024`, as
 * `webrun-streams-livekit` uses: an older LiveKit client dropped larger
 * reliable packets silently.
 */
export const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 - 256;

/** What `messageTargetOverByteChannel` gives: a pipe of bytes, its life, and its payload ceiling. */
export interface ByteChannelMessageTarget {
  /** A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) of bytes, one channel message each. */
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    /** Sends one message; `TypeError` for anything but bytes. */
    postMessage(message: unknown): void;
    /** Closes the channel. */
    close(): Promise<void>;
  };
  /** Aborts when the channel closes. Pass it as `overPipe`'s `signal`. */
  signal: AbortSignal;
  /** Pass as `overPipe`'s `maxMessageSize`. */
  maxMessageSize: number;
}

/**
 * A `ByteChannel` this package hands back (`PeerManager`, `QrSignaling`,
 * `RoomManager`) as a pipe for `webrun-rpc`'s port stack:
 *
 * ```ts
 * const { target, signal, maxMessageSize } = messageTargetOverByteChannel(channel);
 * const { call } = await connect({
 *   mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
 * });
 * ```
 *
 * It starts reading the channel at once, so attach listeners in the same tick;
 * a message with no listener is dropped, as on a `MessagePort`. It must be the
 * channel's only reader: a second reader of `recv` would take messages from it.
 * Messages already received when the channel closes are still delivered.
 */
export function messageTargetOverByteChannel(
  channel: ByteChannel,
  options: { maxMessageSize?: number } = {},
): ByteChannelMessageTarget {
  const listeners = new Set<Listener>();
  const life = new AbortController();
  let closedHere = false;
  const end = (reason: Error): void => {
    if (!life.signal.aborted) life.abort(reason);
  };
  void channel.closed.then(() => end(new Error("webrun-streams-signaling: the channel closed")));
  void (async () => {
    for await (const bytes of channel.recv) {
      // The channel closing ends `recv` after what it already holds; only a
      // close on this side stops delivery at once.
      if (closedHere) break;
      const event = new MessageEvent("message", { data: bytes.slice() });
      for (const listener of [...listeners]) {
        try {
          Promise.resolve(listener(event)).catch(() => undefined);
        } catch {}
      }
    }
    end(new Error("webrun-streams-signaling: the channel closed"));
  })().catch((err: unknown) =>
    end(err instanceof Error ? err : new Error(String(err), { cause: err })),
  );
  return {
    signal: life.signal,
    maxMessageSize: options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const bytes =
          message instanceof Uint8Array
            ? message
            : message instanceof ArrayBuffer
              ? new Uint8Array(message)
              : ArrayBuffer.isView(message)
                ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
                : undefined;
        if (!bytes) {
          throw new TypeError(
            `webrun-streams-signaling: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
          );
        }
        if (life.signal.aborted) return; // `signal` says so
        channel.send(bytes.slice());
      },
      async close() {
        listeners.clear();
        closedHere = true;
        end(new Error("webrun-streams-signaling: closed locally"));
        try {
          channel.close();
        } catch {}
      },
    },
  };
}
