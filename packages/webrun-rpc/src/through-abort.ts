/**
 * Wraps an async iterable so that an `AbortSignal` firing causes the wrapper
 * to return cleanly, forwarding `return()` to the underlying iterator so the
 * producer (e.g., a user-supplied generator) sees its own `finally` blocks
 * run immediately rather than waiting for the next yield.
 *
 * A `next()` still pending on the source when the signal fires is not waited
 * for: the wrapper returns at once. An async generator queues `return()`
 * behind a pending `next()`, so a producer that waits for something to send
 * (a tunnel) would otherwise keep whoever awaits this wrapper — the caller's
 * teardown, once its port died — waiting for ever (statewalker/webrun-wire#153).
 *
 * A consumer that stops early without the signal (it breaks, or throws: a
 * chunk send rejected because the port closed) returns the source too, so a
 * producer suspended at `yield` runs its `finally` (statewalker/webrun-wire#216).
 * A source that finished or threw is not returned.
 */
export async function* throughAbort<T>(
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
  // Whether the source is finished: it said `done`, or its `next()` threw.
  let sourceDone = false;
  try {
    while (true) {
      let r: IteratorResult<T>;
      try {
        r = await nextOrAbort(iter, signal);
      } catch (error) {
        sourceDone = true;
        throw error;
      }
      if (r.done) {
        sourceDone = true;
        return;
      }
      if (signal.aborted) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // On an abort `onAbort` (or the abort check above) has returned the source
    // already. Not awaited: a producer whose `finally` waits must not hold up
    // the consumer's teardown, as with an abort.
    if (!sourceDone && !signal.aborted) {
      Promise.resolve(iter.return?.(undefined as never)).catch(() => {});
    }
  }
}

/**
 * `iter.next()`, or done once `signal` fires first. The abort listener lives
 * for this one wait (one promise raced for the whole stream would keep a
 * reaction per chunk until the stream ends).
 */
function nextOrAbort<T>(iter: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  // Aborted while the consumer held the last value: a listener added now would
  // never fire, and the source may never settle `next()` after its `return()`.
  if (signal.aborted) return Promise.resolve({ done: true, value: undefined });
  // `Promise.resolve`: a sync iterator's `next()` returns its result as is.
  const next = Promise.resolve(iter.next());
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      // A source that rejects after the abort has nobody left to hear it.
      next.catch(() => {});
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    next.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
