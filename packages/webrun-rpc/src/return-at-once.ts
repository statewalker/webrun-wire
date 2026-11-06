/**
 * `gen`, except that `return()` and `throw()` take effect at once.
 *
 * On an async generator both are queued behind a `next()` that is still
 * pending: a consumer that gives up on a stream while it waits for the peer's
 * next chunk — an aborted fetch whose response head has not come, say — cannot
 * end it until that chunk arrives, which for a peer that never answers is
 * never. The stream's `finally` (which closes its port and tells the peer)
 * then never runs, and on a multiplexer the port is kept for good.
 *
 * So `abandon` runs first, synchronously: it must make the pending `next()`
 * settle (abort the stream), after which the generator's own `return()` /
 * `throw()` proceeds as usual. On a generator suspended at a `yield` it is
 * the same ending, a step earlier. `abandon` runs once, whichever comes first.
 */
export function returningAtOnce<T>(
  gen: AsyncGenerator<T>,
  abandon: (reason?: unknown) => void,
): AsyncGenerator<T> {
  let abandoned = false;
  const giveUp = (reason?: unknown) => {
    if (abandoned) return;
    abandoned = true;
    abandon(reason);
  };
  const wrapped: AsyncGenerator<T> = {
    next: (...args: [] | [unknown]) => gen.next(...args),
    return(value) {
      giveUp();
      return gen.return(value);
    },
    throw(error) {
      giveUp(error);
      return gen.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };
  return wrapped;
}
