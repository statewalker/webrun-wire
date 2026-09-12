/**
 * The iterator ↔ `ReadableStream` boundary.
 *
 * Both adapters must carry CANCELLATION, not just data: a response body leaves
 * a handler as a `ReadableStream`, crosses a transport as an iterator, and
 * becomes a `ReadableStream` again at the caller — so when the caller walks
 * away, the only path back to the handler's producer runs through both of
 * these functions. Teardown that stops at an adapter leaves a producer running
 * for ever.
 */

export function toReadableStream(it: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    /**
     * One chunk per pull. An earlier version drained the whole iterator inside
     * a single `pull`, which defeated the stream's own backpressure (every
     * chunk was enqueued as fast as the producer could make them, however slow
     * the reader was) and left no point between chunks at which a cancellation
     * could take effect.
     */
    async pull(controller) {
      try {
        const slot = await it.next();
        if (!slot || slot.done) {
          controller.close();
          return;
        }
        controller.enqueue((await slot.value) as Uint8Array);
      } catch (error) {
        controller.error(error);
      }
    },
    /**
     * Release the source. NOT awaited: `.return()` on an async generator that
     * is parked awaiting its own source is queued behind that pending
     * `next()`, so awaiting it here would hang `reader.cancel()` on exactly
     * the producers that most need cancelling.
     */
    cancel(reason) {
      void Promise.resolve(it.return?.(reason)).catch(() => {});
    },
  });
}

export async function* fromReadableStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = stream.getReader();
  let drained = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (value !== undefined) yield value;
    }
  } finally {
    // A consumer that stops early (`break`, `.return()`, an error) must cancel
    // the source, or whatever fills it keeps filling it. A stream that ended
    // on its own is merely released — cancelling it would be a lie to any
    // `cancel()` hook watching for an abandoned reader.
    if (drained) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}
