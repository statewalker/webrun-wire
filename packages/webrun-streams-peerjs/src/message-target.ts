import type { DataConnection } from "peerjs";

type Listener = (event: MessageEvent) => void | Promise<void>;

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

/** How often `whenDrained` looks: neither PeerJS's queue nor `bufferedAmount` reports emptying. */
const DRAIN_POLL_MS = 5;
/**
 * `whenDrained` resolves once PeerJS's own queue is empty and the data
 * channel's `bufferedAmount` is at most this: the channel can take more.
 * Waiting for zero would pause a sender that waits before every frame.
 */
export const DRAIN_LOW_WATER = 256 * 1024;
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
export interface PeerJsMessageTarget {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one data channel message each.
   */
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    /** Sends one message. `TypeError` for non-bytes; `RangeError`, ending the pipe, past `maxFrameBytes`. */
    postMessage(message: unknown): void;
    /** Closes the connection. */
    close(): Promise<void>;
    /** The data channel's `bufferedAmount`. */
    readonly bufferedAmount: number;
    /** Resolves once PeerJS's own queue is empty and `bufferedAmount` is at most {@link DRAIN_LOW_WATER}, or the pipe ended. */
    whenDrained(): Promise<void>;
  };
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
  const listeners = new Set<Listener>();
  const life = new AbortController();
  const internals = conn as unknown as {
    bufferSize?: number;
    dataChannel?: { bufferedAmount?: number };
  };

  const onData = (data: unknown): void => {
    if (life.signal.aborted) return;
    const bytes = copyBytes(data);
    if (!bytes) {
      // Dropping it would lose a multiplexer envelope and hang its call: fail loudly.
      end(
        new TypeError(
          `webrun-streams-peerjs: a message arrived as ${Object.prototype.toString.call(data)}, not bytes`,
        ),
      );
      closeConn();
      return;
    }
    const event = new MessageEvent("message", { data: bytes });
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };
  const end = (reason: Error): void => {
    if (life.signal.aborted) return;
    conn.off("data", onData);
    conn.off("close", onClose);
    conn.off("error", onError);
    life.abort(reason);
  };
  const onClose = (): void => end(new Error("webrun-streams-peerjs: the connection closed"));
  const onError = (err: unknown): void =>
    end(
      new Error(
        `webrun-streams-peerjs: the connection failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      ),
    );
  conn.on("data", onData);
  conn.on("close", onClose);
  conn.on("error", onError);
  const closeConn = (): void => {
    try {
      conn.close();
    } catch {}
  };

  return {
    signal: life.signal,
    maxMessageSize,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const bytes = viewBytes(message);
        if (!bytes) {
          throw new TypeError(
            `webrun-streams-peerjs: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
          );
        }
        if (life.signal.aborted || !conn.open) return; // `signal` says so
        if (bytes.byteLength > maxFrameBytes) {
          const err = new RangeError(
            `webrun-streams-peerjs: a ${bytes.byteLength}-byte message exceeds maxFrameBytes (${maxFrameBytes}); the data channel would drop it silently`,
          );
          end(err);
          closeConn();
          throw err;
        }
        // A copy: PeerJS may queue the message past its own buffer threshold.
        conn.send(bytes.slice());
      },
      async close() {
        listeners.clear();
        // `conn.close()` tears the peer connection down at once, discarding what
        // PeerJS and the data channel still hold — the multiplexer's last close
        // envelopes among it. Let that go out first, for at most CLOSE_FLUSH_MS.
        const deadline = Date.now() + CLOSE_FLUSH_MS;
        while (
          !life.signal.aborted &&
          Date.now() < deadline &&
          ((internals.bufferSize ?? 0) > 0 || (internals.dataChannel?.bufferedAmount ?? 0) > 0)
        ) {
          await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
        }
        end(new Error("webrun-streams-peerjs: closed locally"));
        closeConn();
      },
      get bufferedAmount() {
        return internals.dataChannel?.bufferedAmount ?? 0;
      },
      whenDrained() {
        return new Promise<void>((resolve) => {
          const check = (): void => {
            const idle =
              !(internals.bufferSize ?? 0) &&
              (internals.dataChannel?.bufferedAmount ?? 0) <= DRAIN_LOW_WATER;
            if (life.signal.aborted || idle) resolve();
            else (setTimeout(check, DRAIN_POLL_MS) as { unref?: () => void }).unref?.();
          };
          check();
        });
      },
    },
  };
}

function viewBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

/** A copy: PeerJS may reuse the buffer it hands out. */
function copyBytes(data: unknown): Uint8Array | undefined {
  const view = viewBytes(data);
  return view ? view.slice() : undefined;
}
