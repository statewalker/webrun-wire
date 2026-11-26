import { type CallPortOptions, callPort } from "./call-port.js";
import { ioSend } from "./io-send.js";
import type { MessageTarget } from "./message-target.js";

export interface CallBidiOptions extends CallPortOptions {
  /**
   * Deadline in ms for each chunk call of the stream (default: none, see
   * `SendOptions.timeout`). The outer call uses `bidiTimeout` instead.
   */
  timeout?: number;
  /** Timeout for the outer stream (default: `Number.MAX_SAFE_INTEGER` / max int). */
  bidiTimeout?: number;
  /**
   * Close `port` once the stream is over: it ended, the handler failed, or
   * the consumer stopped early (default: `false`, the caller owns the port).
   * For a port opened on a mux for this one call (`mux.openPort(meta)`), so
   * the mux does not keep it after the subscription ends. Leave it off for a
   * port that carries other calls.
   */
  closePort?: boolean;
}

export interface CallBidiArgs {
  options?: CallBidiOptions;
  [key: string]: unknown;
}

/**
 * Initiates a full-duplex stream call: ships `input` values to the peer and
 * yields the values returned by `listenBidi`'s handler.
 *
 * Internally allocates a fresh sub-channel name, announces it to the peer
 * via `callPort`, and then runs {@link ioSend} on that sub-channel.
 *
 * If the outer `callPort` rejects (e.g., the peer's handler threw and
 * `listenPort` surfaced the error as `response:error`), the inner `ioSend`'s
 * receiveIterator is force-closed via an internal cancel signal so the
 * consumer doesn't hang waiting for chunks that will never come. The outer
 * error is then re-thrown to the caller.
 *
 * The caller owns `port`: `callBidi` leaves it open unless
 * `options.closePort` is set (statewalker/webrun-wire#217).
 */
export async function* callBidi<TIn, TOut>(
  port: MessageTarget,
  input: AsyncIterable<TIn> | Iterable<TIn>,
  { options = {}, ...params }: CallBidiArgs = {},
): AsyncGenerator<TOut> {
  const channelName = `${+String(Math.random()).substring(2)}`;
  const { bidiTimeout = 2147483647, closePort = false } = options;
  const promise = callPort(port, { ...params, channelName }, { ...options, timeout: bidiTimeout });

  const cancelInner = new AbortController();
  const sendIter = ioSend<TOut, TIn>(port, input, {
    ...options,
    channelName,
    cancelSignal: cancelInner.signal,
  });

  let outerError: unknown;
  promise.then(
    // The peer's handler has finished, and our consumer has already taken
    // its last chunk (its reply comes after ours to that chunk). Whatever
    // input the handler did not read nobody will answer: stop sending it.
    () => cancelInner.abort(),
    (err) => {
      outerError = err;
      cancelInner.abort();
    },
  );

  try {
    yield* sendIter;
  } finally {
    try {
      await promise;
    } catch {
      /* surfaced via outerError */
    }
    if (closePort) {
      try {
        await port.close?.();
      } catch {
        /* the port is gone either way; the stream's own outcome wins */
      }
    }
  }
  if (outerError !== undefined) throw outerError;
}
