/**
 * `stream` as an async iterator, written by hand rather than as a generator so that `return()`
 * and `throw()` reach the stream at once.
 *
 * On an async generator both are queued behind a `next()` in flight, and a `next()` waiting on
 * a stream with no chunk pending (an SSE stream between events, a long poll) is answered only by
 * the next chunk, which may be never: the stream's `cancel()` — what releases its producer's
 * timers, subscriptions, cursors — would wait as long. Here they cancel the stream themselves,
 * which settles the read in flight:
 *
 *  - `return()` cancels it; the `next()` in flight, and every later one, is done.
 *  - `throw(error)` cancels it with `error` and rejects with `error`, as a generator that does
 *    not catch it would; the `next()` in flight is done.
 *  - `signal`, when it aborts, cancels it with the signal's reason, and the `next()` in flight —
 *    and every later one — fails with that reason rather than ending: a body cut short must not
 *    read as complete (a chunked encoder would write its terminator). The listener is added by
 *    the first `next()` and removed however the iteration ends, so an iterator nobody reads
 *    leaves nothing on a long-lived signal.
 *
 * The stream is cancelled at most once, and never once it was read to its end or failed on its
 * own. The cancel is started, not awaited: a tee branch's cancel settles only once the other
 * branch is cancelled too, which a branch nobody reads (`response.clone()`) never is. A cancel
 * that fails is ignored. `return()` before the first `next()` cancels too — where a generator in
 * suspended start would ignore it.
 */
export function readerIterator(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  /** Set once the iteration is over, however: later `next()` calls answer from it. */
  let over: { failure?: { reason: unknown } } | undefined;
  const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

  const finish = (state: { failure?: { reason: unknown } }) => {
    over ??= state;
    signal?.removeEventListener("abort", onAbort);
  };
  const cancel = (reason: unknown, state: { failure?: { reason: unknown } }) => {
    if (over) return;
    finish(state);
    try {
      void (reader ? reader.cancel(reason) : stream.cancel(reason)).catch(() => {});
    } catch {
      /* a stream locked elsewhere: not ours to cancel */
    }
  };
  function onAbort() {
    const reason = signal?.reason;
    cancel(reason, { failure: { reason } });
  }
  const answer = (): IteratorResult<Uint8Array> => {
    if (over?.failure) throw over.failure.reason;
    return DONE;
  };

  const it: AsyncIterableIterator<Uint8Array> = {
    async next() {
      if (over) return answer();
      if (!reader) {
        reader = stream.getReader();
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        if (over) return answer();
      }
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (over) return answer();
        finish({ failure: { reason: error } });
        throw error;
      }
      if (over) return answer(); // torn down while this read waited
      if (result.done) {
        finish({});
        reader.releaseLock();
        return DONE;
      }
      return { done: false, value: result.value };
    },
    async return() {
      cancel(undefined, {});
      return DONE;
    },
    async throw(error?: unknown) {
      cancel(error, {});
      throw error;
    },
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return it;
}
