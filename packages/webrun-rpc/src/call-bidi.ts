import { type CallPortOptions, callPort } from "./call-port.js";
import { ioSend } from "./io-send.js";

export interface CallBidiOptions extends CallPortOptions {
  /** Timeout for the outer stream (default: `Number.MAX_SAFE_INTEGER` / max int). */
  bidiTimeout?: number;
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
 * recieveIterator is force-closed via an internal cancel signal so the
 * consumer doesn't hang waiting for chunks that will never come. The outer
 * error is then re-thrown to the caller.
 */
export async function* callBidi<TIn, TOut>(
  port: MessagePort,
  input: AsyncIterable<TIn> | Iterable<TIn>,
  { options = {}, ...params }: CallBidiArgs = {},
): AsyncGenerator<TOut> {
  const channelName = `${+String(Math.random()).substring(2)}`;
  const { bidiTimeout = 2147483647 } = options;
  const promise = callPort(port, { ...params, channelName }, { ...options, timeout: bidiTimeout });

  const cancelInner = new AbortController();
  const sendIter = ioSend<TOut, TIn>(port, input, {
    ...options,
    channelName,
    cancelSignal: cancelInner.signal,
  });

  let outerError: unknown;
  promise.catch((err) => {
    outerError = err;
    cancelInner.abort();
  });

  try {
    yield* sendIter;
  } finally {
    try {
      await promise;
    } catch {
      /* surfaced via outerError */
    }
  }
  if (outerError !== undefined) throw outerError;
}
