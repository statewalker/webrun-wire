import {
  type MessagePipe,
  type MessagePipeTarget,
  newMessagePipe,
} from "@statewalker/webrun-streams";
import type { ByteChannel } from "./types.js";

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
export interface ByteChannelMessageTarget extends MessagePipe {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) of bytes, one
   * channel message each. `bufferedAmount` is the channel's (0 where it cannot
   * tell); `whenDrained` is the channel's, or resolves at once over a channel
   * without one.
   */
  target: MessagePipeTarget;
  /** Aborts when the channel closes. Pass it as `overPipe`'s `signal`. */
  signal: AbortSignal;
  /** Pass as `overPipe`'s `maxMessageSize`. */
  maxMessageSize: number;
}

/** How long a closed channel's `recv` may take to hand over what it still holds before the pipe ends. */
const CLOSE_DRAIN_MS = 50;

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
  options: { maxMessageSize?: number; maxFrameBytes?: number } = {},
): ByteChannelMessageTarget {
  const control = newMessagePipe(
    {
      send: (bytes) => channel.send(bytes),
      bufferedAmount: () => channel.bufferedAmount ?? 0,
      ...(channel.whenDrained
        ? {
            isDrained: () => false,
            whenDrained: () => channel.whenDrained?.() ?? Promise.resolve(),
          }
        : { isDrained: () => true }),
      close: (local) => {
        if (!local) return;
        try {
          channel.close();
        } catch {}
      },
    },
    {
      name: "webrun-streams-signaling",
      maxMessageSize: options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
      maxFrameBytes: options.maxFrameBytes,
      // The channel may queue what is sent, and reuse what it hands out.
      copyOnSend: true,
      copyOnDeliver: true,
    },
  );
  const closedMessage = "webrun-streams-signaling: the channel closed";
  const reading = (async () => {
    for await (const bytes of channel.recv) {
      // The channel closing ends `recv` after what it already holds; only a
      // close on this side stops delivery at once.
      if (control.ended) break;
      control.deliver(bytes);
    }
  })();
  reading.then(
    () => control.end(new Error(closedMessage)),
    // A `recv` that fails leaves the channel open: end as local, which closes it.
    (err: unknown) =>
      control.end(err instanceof Error ? err : new Error(String(err), { cause: err }), true),
  );
  // What `recv` still holds when the channel closes is delivered first; a
  // channel whose `recv` never ends still ends the pipe, shortly after.
  void channel.closed.then(() => {
    if (control.ended) return;
    const timer = setTimeout(() => control.end(new Error(closedMessage)), CLOSE_DRAIN_MS) as {
      unref?: () => void;
    };
    timer.unref?.();
  });
  return control.pipe as ByteChannelMessageTarget;
}
