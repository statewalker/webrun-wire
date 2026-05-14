import { type IteratorChunk, recieveIterator } from "@statewalker/webrun-streams";
import { type ListenPortOptions, listenPort } from "./listen-port.js";

export interface RecieveOptions extends ListenPortOptions {
  /**
   * Optional cancel signal. When fired, the currently-active
   * `recieveIterator` is force-closed (its producer is signalled `done`
   * with an `AbortError`) so any pending `.next()` resolves immediately
   * and the consumer's iteration loop can unwind. Required to make
   * consumer-side `iter.return()` propagate through `callBidi`/`yield*`
   * without waiting on `callPort` timeouts.
   */
  signal?: AbortSignal;
}

/**
 * Async generator over async generators. Each outer yield is one inbound
 * stream reconstructed from chunk-envelopes delivered by the peer's
 * {@link send}.
 *
 * The outer generator itself never ends: break out of the outer loop when
 * you've handled the streams you care about.
 *
 * When the outer for-await is interrupted (`break`, `return`, throw), the
 * `finally` here both removes the underlying `listenPort` and closes the
 * most recently yielded `recieveIterator`. The latter is required because
 * a `listenPort` handler invocation that's already in flight (awaiting
 * `deliver(chunk)`) would otherwise hang forever — `iterator.return()`
 * triggers `drainQueue` which resolves all pending producer Promises.
 *
 * If `options.signal` is provided and fires while the consumer is awaiting
 * a chunk, the active `recieveIterator` is force-delivered an end-of-stream
 * marker so the consumer wakes up immediately rather than waiting for the
 * next inbound chunk (or `callPort` timeout).
 */
export async function* recieve<T>(
  port: MessagePort,
  options: RecieveOptions = {},
): AsyncGenerator<AsyncGenerator<T>> {
  const { signal, ...listenOptions } = options;
  let onMessage: ((chunk: IteratorChunk<T>) => Promise<boolean>) | undefined;
  let currentIter: AsyncGenerator<T> | undefined;
  let forceClose: (() => void) | undefined;

  const close = listenPort<IteratorChunk<T>, void>(
    port,
    async ({ done, value, error }) => {
      await onMessage?.({ done, value, error });
    },
    listenOptions,
  );

  const onAbort = () => {
    forceClose?.();
  };
  if (signal) {
    if (signal.aborted) {
      // Bail out immediately — close listener and yield nothing.
      close();
      return;
    }
    signal.addEventListener("abort", onAbort);
  }

  try {
    while (true) {
      currentIter = recieveIterator<T>((deliver) => {
        onMessage = deliver;
        forceClose = () => {
          void deliver({ done: true });
        };
      });
      yield currentIter;
    }
  } finally {
    close();
    signal?.removeEventListener("abort", onAbort);
    onMessage = undefined;
    forceClose = undefined;
    if (currentIter) {
      try {
        await currentIter.return?.(undefined as never);
      } catch {
        /* best effort */
      }
    }
  }
}
