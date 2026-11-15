import {
  DEFAULT_DRAIN_LOW_WATER,
  DEFAULT_DRAIN_POLL_MS,
  type MessagePipe,
  type MessagePipeTarget,
  newMessagePipe,
} from "@statewalker/webrun-streams";
import type { DataConnection } from "peerjs";

/**
 * The largest message a raw `DataConnection` delivers between any two
 * browsers: PeerJS records Firefox-to-Chrome messages "cut off after 16384
 * bytes", and `-webrtc` chunks to the same 16 KiB. Chromium to Chromium
 * carries up to 256 KiB, and one byte past that is measured to arrive as
 * nothing at all, with no error on either side and the connection closed
 * (`tests/message-ceiling.test.ts`). Raise it with `maxFrameBytes` only for
 * peers known to allow more.
 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024;

/**
 * The margin spec D10 asks for: the port stack's framing adds up to 134 bytes
 * (measured 123-128) on top of each payload, so payloads stay 256 below the
 * frame limit.
 */
const FRAMING_MARGIN = 256;

/** `DEFAULT_MAX_FRAME_BYTES` less the framing margin: what to give `overPipe`. */
export const DEFAULT_MAX_MESSAGE_SIZE = DEFAULT_MAX_FRAME_BYTES - FRAMING_MARGIN;

/**
 * `whenDrained` resolves once PeerJS's own queue is empty and the data
 * channel's `bufferedAmount` is at most this: the channel can take more.
 * Waiting for zero would pause a sender that waits before every frame.
 */
export const DRAIN_LOW_WATER = DEFAULT_DRAIN_LOW_WATER;
/** How long `close()` waits for queued messages to be written out. */
const CLOSE_FLUSH_MS = 5000;

export interface MessageTargetOverPeerJsOptions {
  /**
   * The largest message the connection carries. A post past it ends the pipe
   * with a `RangeError` rather than letting the data channel drop it
   * silently. Default {@link DEFAULT_MAX_FRAME_BYTES}.
   */
  maxFrameBytes?: number;
  /** The payload ceiling to report. Default `maxFrameBytes` less 256. */
  maxMessageSize?: number;
}

/** What `messageTargetOverPeerJs` gives: a pipe of bytes, its life, and its payload ceiling. */
export interface PeerJsMessageTarget extends MessagePipe {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one data channel message each. A post past
   * `maxFrameBytes` throws `RangeError` and ends the pipe; `bufferedAmount` is
   * the data channel's; `whenDrained` waits for PeerJS's own queue to empty
   * and `bufferedAmount` to reach {@link DRAIN_LOW_WATER}.
   */
  target: MessagePipeTarget;
  /**
   * Aborts when the connection closes or fails, or a post exceeds
   * `maxFrameBytes`. Pass it as `overPipe`'s `signal`.
   */
  signal: AbortSignal;
  /** Pass as `overPipe`'s `maxMessageSize`, so bodies are chunked under the frame limit. */
  maxMessageSize: number;
}

/**
 * One open PeerJS `DataConnection` as a pipe of messages, for a multiplexer to
 * run over:
 *
 * ```ts
 * const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
 * const { call } = await connect({
 *   mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
 * });
 * ```
 *
 * The connection must be open, use `serialization: "raw"` (PeerJS hands each
 * message to the data channel unchanged) and be `reliable` (ordered); anything
 * else throws. Inbound messages arrive
 * as `Uint8Array` copies. Anything else (a `Blob`, a string) ends the pipe
 * with a `TypeError`: dropping it would lose an envelope and hang its call.
 */
export function messageTargetOverPeerJs(
  conn: DataConnection,
  options: MessageTargetOverPeerJsOptions = {},
): PeerJsMessageTarget {
  const serialization = (conn as unknown as { serialization?: string }).serialization;
  if (serialization !== "raw") {
    throw new TypeError(
      `messageTargetOverPeerJs: DataConnection serialization is '${serialization}', expected 'raw'`,
    );
  }
  // PeerJS's default `reliable: false` means `ordered: false`: envelopes would
  // arrive out of order and corrupt every stream without an error.
  if ((conn as unknown as { reliable?: boolean }).reliable !== true) {
    throw new TypeError(
      "messageTargetOverPeerJs: DataConnection must be opened with `reliable: true` (ordered delivery)",
    );
  }
  // Not yet open, posts would be dropped; already closed, `close` has fired and
  // the signal would never abort. Either way calls would hang.
  if (!conn.open) {
    throw new Error(
      "messageTargetOverPeerJs: DataConnection is not open; wait for its `open` event",
    );
  }
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxMessageSize = options.maxMessageSize ?? maxFrameBytes - FRAMING_MARGIN;
  const internals = conn as unknown as {
    bufferSize?: number;
    dataChannel?: { bufferedAmount?: number };
  };
  const held = (): boolean =>
    (internals.bufferSize ?? 0) > 0 || (internals.dataChannel?.bufferedAmount ?? 0) > 0;

  const onData = (data: unknown): void => control.deliver(data);
  const onClose = (): void =>
    control.end(new Error("webrun-streams-peerjs: the connection closed"));
  // Ended as local: an error is not always followed by `close`, and the
  // connection must still be released, or the peer never learns the pipe is gone.
  const onError = (err: unknown): void =>
    control.end(
      new Error(
        `webrun-streams-peerjs: the connection failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      ),
      true,
    );
  const control = newMessagePipe(
    {
      send: (bytes) => conn.send(bytes),
      canSend: () => conn.open,
      bufferedAmount: () => internals.dataChannel?.bufferedAmount ?? 0,
      isDrained: () =>
        !(internals.bufferSize ?? 0) &&
        (internals.dataChannel?.bufferedAmount ?? 0) <= DRAIN_LOW_WATER,
      // `conn.close()` tears the peer connection down at once, discarding what
      // PeerJS and the data channel still hold — the multiplexer's last close
      // envelopes among it. Let that go out first, for at most CLOSE_FLUSH_MS.
      flush: async () => {
        const deadline = Date.now() + CLOSE_FLUSH_MS;
        while (!control.ended && Date.now() < deadline && held()) {
          await new Promise((resolve) => setTimeout(resolve, DEFAULT_DRAIN_POLL_MS));
        }
      },
      close: (local) => {
        conn.off("data", onData);
        conn.off("close", onClose);
        conn.off("error", onError);
        if (local) {
          try {
            conn.close();
          } catch {}
        }
      },
    },
    {
      name: "webrun-streams-peerjs",
      maxFrameBytes,
      maxMessageSize,
      // PeerJS may queue a sent message past its own buffer threshold, and
      // reuse the buffer it hands out.
      copyOnSend: true,
      copyOnDeliver: true,
    },
  );
  conn.on("data", onData);
  conn.on("close", onClose);
  conn.on("error", onError);
  return control.pipe as PeerJsMessageTarget;
}
