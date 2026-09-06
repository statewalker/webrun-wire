/**
 * Wraps an async iterable so that an `AbortSignal` firing causes the wrapper
 * to return cleanly, forwarding `return()` to the underlying iterator so the
 * producer (e.g., a user-supplied generator) sees its own `finally` blocks
 * run immediately rather than waiting for the next yield.
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
