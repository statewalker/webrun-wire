/**
 * One pipe of byte messages over a transport, ready for a multiplexer to run
 * over (`@statewalker/webrun-rpc`'s `overPipe`).
 *
 * Every transport adapter (WebSocket, PeerJS, LiveKit, a signaling byte
 * channel) needs the same skeleton: a listener set, a delivery loop that one
 * faulty listener cannot stop, a life that ends once, a byte check on
 * `postMessage`, a frame ceiling, a drain wait and a close. This module owns
 * all of it, so a rule about pipes is fixed in one place; a transport supplies
 * only how to send, its buffered bytes, how to close, and calls `deliver` and
 * `end` as its own events arrive (statewalker/webrun-wire#151).
 */

/** A message listener, as on a `MessagePort`. */
export type MessagePipeListener = (event: MessageEvent) => void | Promise<void>;

/**
 * `whenDrained` resolves once the transport holds at most this many bytes:
 * the pipe can take more. Waiting for zero would make a sender that waits
 * before every frame (`overPipe`'s `frameSize`) pause once per frame.
 */
export const DEFAULT_DRAIN_LOW_WATER = 256 * 1024;

/** How often `whenDrained` looks at `bufferedAmount` when the transport has no drain event. */
export const DEFAULT_DRAIN_POLL_MS = 5;

/** What a transport supplies to `newMessagePipe`. */
export interface MessagePipeTransport {
  /** Puts one message on the transport. `bytes` is the caller's view, or a copy with `copyOnSend`. */
  send(bytes: Uint8Array): void;
  /**
   * Whether the transport can send now (a WebSocket `OPEN`, a connection
   * `open`). A post while it cannot is a no-op, as after the pipe ended: the
   * pipe's signal says why. Default: always.
   */
  canSend?(): boolean;
  /** Bytes the transport holds, sent and not yet written out. Default 0. */
  bufferedAmount?(): number;
  /**
   * Whether the transport can take more. Default: `bufferedAmount()` is at
   * most `drainLowWater`. Polled every `drainPollMs` unless `whenDrained` is
   * given.
   */
  isDrained?(): boolean;
  /**
   * The transport's own drain wait, used instead of polling. The pipe stops
   * waiting on it once the pipe ends.
   */
  whenDrained?(): Promise<void>;
  /**
   * Releases the transport. Called once, when the pipe ends: `local` is true
   * when it ended on this side (`close()`, an oversized post, a message that
   * is not bytes), false when the transport reported it (`end`). Its errors
   * are swallowed.
   */
  close?(local: boolean, reason: Error): void | Promise<void>;
  /**
   * Runs at the start of a local `close()`, before the pipe ends: a transport
   * that would discard what it still holds lets it go out first.
   */
  flush?(): Promise<void>;
}

export interface MessagePipeOptions {
  /** Prefix of the errors this pipe raises, e.g. `"webrun-streams-ws"`. */
  name: string;
  /**
   * The largest message the transport carries. A post past it ends the pipe
   * with a `RangeError` (and throws it) rather than letting the transport
   * drop the message silently. Default: no ceiling.
   */
  maxFrameBytes?: number;
  /** The payload ceiling the pipe reports, for `overPipe`'s `maxMessageSize`. */
  maxMessageSize?: number;
  /** Send a copy of each posted message: the transport queues it past the call. */
  copyOnSend?: boolean;
  /** Deliver a copy of each inbound message: the transport may reuse its buffer. */
  copyOnDeliver?: boolean;
  /** An inbound string becomes its UTF-8 bytes. Otherwise it ends the pipe, as any non-bytes. */
  textAsBytes?: boolean;
  /** Default {@link DEFAULT_DRAIN_LOW_WATER}. */
  drainLowWater?: number;
  /** Default {@link DEFAULT_DRAIN_POLL_MS}. */
  drainPollMs?: number;
}

/**
 * The pipe a multiplexer runs over: a `MessageTarget` (as
 * `@statewalker/webrun-rpc` defines it) whose messages are `Uint8Array`s, one
 * transport message each. It carries its own life (`closeSignal`) and payload
 * ceiling (`maxMessageSize`), so `overPipe(target, { codec, side })` needs
 * nothing else.
 */
export interface MessagePipeTarget {
  addEventListener(type: "message", listener: MessagePipeListener): void;
  removeEventListener(type: "message", listener: MessagePipeListener): void;
  /**
   * Sends one message. `TypeError` for anything but bytes; `RangeError`,
   * ending the pipe, past `maxFrameBytes`; a no-op once the pipe ended.
   */
  postMessage(message: unknown): void;
  /** Ends the pipe on this side and releases the transport. */
  close(): Promise<void>;
  /** The transport's buffered bytes. */
  readonly bufferedAmount: number;
  /** Resolves once the transport can take more, or the pipe ended. */
  whenDrained(): Promise<void>;
  /** Aborts when the pipe ends, with an `Error` saying how. */
  readonly closeSignal: AbortSignal;
  /** The payload ceiling, when the transport has one. */
  readonly maxMessageSize?: number;
}

/** What adapters hand back: the pipe, its life and its payload ceiling. */
export interface MessagePipe {
  target: MessagePipeTarget;
  /**
   * Aborts when the pipe ends; the same signal as `target.closeSignal`. Pass
   * it as `overPipe`'s `signal`, so a dead peer closes the multiplexer and
   * every port on it at once.
   */
  signal: AbortSignal;
  /** The payload ceiling, when the transport has one; the same as `target.maxMessageSize`. */
  maxMessageSize?: number;
}

/** The transport's side of a pipe: what `newMessagePipe` hands back to the adapter. */
export interface MessagePipeControl {
  /** The pipe, for the adapter to return. */
  pipe: MessagePipe;
  /**
   * One inbound message. Bytes (an `ArrayBuffer` or any view) reach every
   * listener as a `Uint8Array`, in order; a listener that throws or rejects
   * does not stop the others. Anything else ends the pipe with a `TypeError`:
   * dropping it would lose a multiplexer envelope and hang its call.
   */
  deliver(data: unknown): void;
  /**
   * Ends the pipe with `reason`. `local` (default false): it ended on this
   * side, a failed send say, and the transport's `close` hears so.
   */
  end(reason: Error, local?: boolean): void;
  /** Whether the pipe has ended. */
  readonly ended: boolean;
}

const encoder = new TextEncoder();

/** `data` as a `Uint8Array` view of the same bytes, or `undefined` if it is not bytes. */
export function viewBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

/** Builds the pipe over `transport`; see {@link MessagePipeTransport}. */
export function newMessagePipe(
  transport: MessagePipeTransport,
  options: MessagePipeOptions,
): MessagePipeControl {
  const {
    name,
    maxFrameBytes,
    maxMessageSize,
    copyOnSend = false,
    copyOnDeliver = false,
    textAsBytes = false,
    drainLowWater = DEFAULT_DRAIN_LOW_WATER,
    drainPollMs = DEFAULT_DRAIN_POLL_MS,
  } = options;
  const listeners = new Set<MessagePipeListener>();
  const life = new AbortController();
  const buffered = (): number => transport.bufferedAmount?.() ?? 0;
  const isDrained = (): boolean => transport.isDrained?.() ?? buffered() <= drainLowWater;

  const finish = (reason: Error, local: boolean): void => {
    if (life.signal.aborted) return;
    life.abort(reason);
    try {
      Promise.resolve(transport.close?.(local, reason)).catch(() => undefined);
    } catch {}
  };

  const deliver = (data: unknown): void => {
    if (life.signal.aborted) return;
    let bytes = viewBytes(data);
    if (bytes) {
      if (copyOnDeliver) bytes = bytes.slice();
    } else if (textAsBytes && typeof data === "string") {
      bytes = encoder.encode(data);
    } else {
      finish(
        new TypeError(
          `${name}: a message arrived as ${Object.prototype.toString.call(data)}, not bytes`,
        ),
        true,
      );
      return;
    }
    const event = new MessageEvent("message", { data: bytes });
    for (const listener of [...listeners]) {
      try {
        // One listener's fault, thrown or rejected, must not stop delivery.
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };

  const target: MessagePipeTarget = {
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
          `${name}: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
        );
      }
      if (life.signal.aborted || transport.canSend?.() === false) return; // the signal says why
      if (maxFrameBytes != null && bytes.byteLength > maxFrameBytes) {
        const err = new RangeError(
          `${name}: a ${bytes.byteLength}-byte message exceeds maxFrameBytes (${maxFrameBytes}); the transport would drop it silently`,
        );
        finish(err, true);
        throw err;
      }
      transport.send(copyOnSend ? bytes.slice() : bytes);
    },
    async close() {
      listeners.clear();
      if (life.signal.aborted) return;
      try {
        await transport.flush?.();
      } catch {}
      finish(new Error(`${name}: closed locally`), true);
    },
    get bufferedAmount() {
      return buffered();
    },
    whenDrained() {
      if (life.signal.aborted || isDrained()) return Promise.resolve();
      const signal = life.signal;
      if (transport.whenDrained) {
        const native = transport.whenDrained();
        return new Promise<void>((resolve, reject) => {
          const done = (): void => {
            signal.removeEventListener("abort", done);
            resolve();
          };
          signal.addEventListener("abort", done);
          native.then(done, (err: unknown) => {
            signal.removeEventListener("abort", done);
            if (signal.aborted) resolve();
            else reject(err);
          });
        });
      }
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (signal.aborted || isDrained()) resolve();
          // A peer that stops reading but never closes must not keep Node alive.
          else (setTimeout(check, drainPollMs) as { unref?: () => void }).unref?.();
        };
        check();
      });
    },
    get closeSignal() {
      return life.signal;
    },
    get maxMessageSize() {
      return maxMessageSize;
    },
  };

  return {
    pipe: { target, signal: life.signal, maxMessageSize },
    deliver,
    end: (reason, local = false) => finish(reason, local),
    get ended() {
      return life.signal.aborted;
    },
  };
}
