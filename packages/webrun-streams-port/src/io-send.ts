import { postCancelChannel } from "./cancel-channel.js";
import type { ListenPortOptions } from "./listen-port.js";
import { type RecieveOptions, recieve } from "./recieve.js";
import { send } from "./send.js";

export interface IoSendOptions extends ListenPortOptions {
  /**
   * Optional cancel signal threaded into `recieve` so the consumer can force
   * an in-flight `input.next()` to resolve immediately (otherwise an
   * AsyncGenerator's `.return()` queues behind the pending `.next()` and
   * never preempts a hanging await). Used by `callBidi` to abort the inner
   * stream when the outer call rejects.
   */
  cancelSignal?: AbortSignal;
}

/**
 * Client half of a full-duplex exchange over a `MessagePort`.
 *
 * Concurrently reads one inbound stream from the peer and writes `output`
 * to it. Yields each value received from the peer. Completes once both
 * directions finish. Pairs with {@link ioHandle}.
 *
 * If the consumer breaks out of the `for await` (via `iter.return()` or
 * loop `break`), `ioSend` posts a `cancel-channel` message on the same
 * sub-channel so the peer can abort its `send` immediately rather than
 * waiting for `callPort` timeouts to fire.
 */
export async function* ioSend<T, U = T>(
  port: MessagePort,
  output: AsyncIterable<U> | Iterable<U>,
  options: IoSendOptions = {},
): AsyncGenerator<T> {
  const { cancelSignal, ...recieveOptions } = options;
  const channelName = recieveOptions.channelName ?? "";
  let inputEndedNormally = false;
  const sendAbort = new AbortController();

  // When the outer cancel fires, also abort the outbound `send` so any
  // in-flight `callPort` (e.g., the trailing `{done:true}` whose ack the
  // peer will never produce after closing its listener) short-circuits
  // instead of hanging on its own timeout.
  if (cancelSignal) {
    if (cancelSignal.aborted) sendAbort.abort();
    else cancelSignal.addEventListener("abort", () => sendAbort.abort(), { once: true });
  }

  // Combine outer cancel signal with recieve's force-close mechanism.
  const recieveOpts: RecieveOptions = { ...recieveOptions, signal: cancelSignal };

  for await (const input of recieve<T>(port, recieveOpts)) {
    const sendPromise = send<U>(port, output, { ...recieveOptions, signal: sendAbort.signal });
    try {
      yield* input;
      inputEndedNormally = true;
    } finally {
      if (!inputEndedNormally) {
        postCancelChannel(port, channelName);
        sendAbort.abort();
      }
      try {
        await sendPromise;
      } catch {
        /* swallow — consumer is done either way */
      }
    }
    break;
  }
}
