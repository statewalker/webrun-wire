import { type IteratorChunk, receiveIterator } from "@statewalker/webrun-streams";
import { type ListenPortOptions, listenPort } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";

export interface ReceiveOptions extends ListenPortOptions {
  /**
   * Optional cancel signal. When fired, the currently-active
   * `receiveIterator` is force-closed (its producer is signalled `done`
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
 * most recently yielded `receiveIterator`. The latter is required because
 * a `listenPort` handler invocation that's already in flight (awaiting
 * `deliver(chunk)`) would otherwise hang forever — `iterator.return()`
 * triggers `drainQueue` which resolves all pending producer Promises.
 *
 * If `options.signal` is provided and fires while the consumer is awaiting
 * a chunk, the active `receiveIterator` is force-delivered an end-of-stream
 * marker so the consumer wakes up immediately rather than waiting for the
 * next inbound chunk (or `callPort` timeout).
 */
export async function* receive<T>(
  port: MessageTarget,
  options: ReceiveOptions = {},
): AsyncGenerator<AsyncGenerator<T>> {
  const { signal, ...listenOptions } = options;
  type Deliver = (chunk: IteratorChunk<T>) => Promise<boolean>;
  let onMessage: Deliver | undefined;
  let currentIter: AsyncGenerator<T> | undefined;
  let forceClose: (() => void) | undefined;
  let finished = false;
  // `receiveIterator`'s installer runs lazily, on the consumer's first
  // `.next()`. A chunk that arrives before that must wait for it: replying
  // first would acknowledge a chunk nobody took (the same race
  // `duplexOverPort` closes with its own `ready()`).
  const waiting: Array<() => void> = [];
  const ready = (): Promise<void> =>
    onMessage || finished ? Promise.resolve() : new Promise<void>((r) => waiting.push(r));
  const wake = () => {
    for (const r of waiting.splice(0)) r();
  };

  const close = listenPort<IteratorChunk<T>, void>(
    port,
    async ({ done, value, error }) => {
      await ready();
      const deliver = onMessage;
      if (!deliver) throw new Error("receive: the receiving side is closed");
      // The stream this chunk ends is over: a chunk after it belongs to the
      // next stream, and waits for that stream's consumer.
      if (done || error) onMessage = undefined;
      await deliver({ done, value, error });
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
      currentIter = receiveIterator<T>((deliver) => {
        forceClose = () => {
          void deliver({ done: true });
        };
        if (signal?.aborted) {
          // The signal fired before this installer ran: end at once instead
          // of waiting for a chunk the peer will not send.
          forceClose();
          return;
        }
        onMessage = deliver;
        wake();
      });
      yield currentIter;
    }
  } finally {
    close();
    signal?.removeEventListener("abort", onAbort);
    onMessage = undefined;
    finished = true;
    wake();
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
