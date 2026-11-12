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
 * A stream that fails on its own fails the `next()` that reads the failure; every later one is
 * done, as on a generator that threw.
 *
 * The stream is cancelled at most once, and never once it was read to its end or failed on its
 * own. The cancel is started, not awaited: a tee branch's cancel settles only once the other
 * branch is cancelled too, which a branch nobody reads (`response.clone()`) never is. A cancel
 * that fails is ignored. `return()` before the first `next()` cancels too — where a generator in
 * suspended start would ignore it.
 *
 * The reader's lock is released however the iteration ends, as a generator's `finally` would:
 * read to its end, failed, or torn down. On a teardown it is released right after the cancel is
 * started — the cancel closes the stream at once, answering the read in flight with done, so no
 * read is pending any more when the lock goes (`releaseLock()` with a read pending rejects that
 * read, in some runtimes). Should a read still be pending and be rejected by the release, the
 * `next()` that waits on it answers from the teardown all the same.
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
    release();
  };
  const release = () => {
    try {
      reader?.releaseLock();
    } catch {
      /* a runtime that refuses to release with a read pending: the lock goes with the reader */
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
        finish({}); // thrown once, here; later calls are done
        release();
        throw error;
      }
      if (over) return answer(); // torn down while this read waited
      if (result.done) {
        finish({});
        release();
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
