import { sendIterator } from "@statewalker/webrun-streams";
import { type CallPortOptions, callPort } from "./call-port.js";

export interface SendOptions extends CallPortOptions {
  /**
   * Optional cancellation signal. When fired, `send` aborts cleanly:
   *   - the current iteration is interrupted (by calling `return()` on the
   *     underlying iterator, releasing any pending work in the producer);
   *   - no further `callPort` round-trips are issued;
   *   - the final `{done: true}` marker is **not** sent (the peer told us
   *     it's gone — there's no one to receive it).
   *
   * `send` resolves normally on abort; the caller can distinguish abort
   * from normal completion by checking `options.signal.aborted` after.
   */
  signal?: AbortSignal;
}

/**
 * Send every value produced by `output` to `port`, one `callPort` round-trip
 * per chunk. Resolves once the peer has acknowledged the final `{ done: true }`
 * envelope, or once `options.signal` aborts (whichever comes first).
 */
export async function send<T>(
  port: MessagePort,
  output: AsyncIterable<T> | Iterable<T>,
  options: SendOptions = {},
): Promise<void> {
  const { signal, ...callOptions } = options;
  if (!signal) {
    await sendIterator<T>(async ({ done, value, error }) => {
      await callPort(port, { done, value, error }, callOptions);
    }, output);
    return;
  }

  const stream = throughAbort(output, signal);
  let abortedBeforeDone = false;
  try {
    await sendIterator<T>(async ({ done, value, error }) => {
      if (signal.aborted) {
        // Skip everything — including the final {done:true}. The peer
        // initiated the cancel and isn't listening anymore.
        abortedBeforeDone = true;
        return;
      }
      // Pass the signal so an in-flight callPort short-circuits when abort
      // fires — otherwise it would hang on the per-chunk timeout.
      await callPort(port, { done, value, error }, { ...callOptions, signal });
    }, stream);
  } catch (err) {
    // If we aborted, the chunkSender may have surfaced a callPort error from
    // the very last in-flight round-trip. Swallow it — abort is the expected
    // outcome here.
    if (signal.aborted || abortedBeforeDone) return;
    throw err;
  }
}

/**
 * Wraps an async iterable so that an `AbortSignal` firing causes the wrapper
 * to return cleanly, forwarding `return()` to the underlying iterator so the
 * producer (e.g., a user-supplied generator) sees its own `finally` blocks
 * run immediately rather than waiting for the next yield.
 */
async function* throughAbort<T>(
  input: AsyncIterable<T> | Iterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iter = (input as AsyncIterable<T>)[Symbol.asyncIterator]
    ? (input as AsyncIterable<T>)[Symbol.asyncIterator]()
    : ((input as Iterable<T>)[Symbol.iterator]() as unknown as AsyncIterator<T>);
  const onAbort = () => {
    void iter.return?.(undefined as never);
  };
  if (signal.aborted) {
    void iter.return?.(undefined as never);
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const r = await iter.next();
      if (r.done) return;
      if (signal.aborted) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
