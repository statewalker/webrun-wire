/**
 * Cancellation has to cross the iterator ↔ ReadableStream boundary, in both
 * directions.
 *
 * These two adapters sit at the ends of every HTTP body in this repo: a
 * response body leaves a handler as a `ReadableStream` and becomes an iterator
 * through `fromReadableStream`; it arrives at the caller as an iterator and
 * becomes a `ReadableStream` again through `toReadableStream`. So when a
 * caller aborts, the *only* path back to the handler's producer runs through
 * both of them — and neither propagated:
 *
 *   - `toReadableStream` had no `cancel` at all, so a cancelled body never
 *     released the iterator feeding it.
 *   - `fromReadableStream` never released its reader, so returning the
 *     generator left the source stream uncancelled and its producer running.
 *
 * That is the same defect rung 13 of the httpeers prototypes found in
 * `emulateMux` and `duplexOverStream`, one layer further out: teardown that
 * stops at the adapter instead of reaching the producer.
 */

import { describe, expect, it } from "vitest";
import { fromReadableStream, toReadableStream } from "../src/readable-streams.js";

const chunk = (n: number): Uint8Array => new Uint8Array([n]);

describe("readable-streams: cancellation reaches the producer", () => {
  it("cancelling the stream returns the source iterator", async () => {
    const state = { unwound: false };
    async function* ticking(): AsyncGenerator<Uint8Array> {
      try {
        for (let n = 0; ; n++) {
          yield chunk(n);
          // A producer that ticks rather than one that floods: an unthrottled
          // `for(;;) yield` fills the stream's queue instead of parking, and
          // then this measures the queue rather than the cancellation.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        state.unwound = true;
      }
    }

    const reader = toReadableStream(ticking()).getReader();
    expect((await reader.read()).value).toEqual(chunk(0));
    await reader.cancel(new Error("caller went away"));

    await waitFor(() => state.unwound, 2_000, "the source iterator was never returned");
    expect(state.unwound).toBe(true);
  });

  it("returning the generator cancels the source stream", async () => {
    const state = { cancelled: false, reason: undefined as unknown };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let n = 0; n < 8; n++) controller.enqueue(chunk(n));
      },
      cancel(reason) {
        state.cancelled = true;
        state.reason = reason;
      },
    });

    const it = fromReadableStream(stream)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual(chunk(0));
    await it.return?.(undefined);

    expect(state.cancelled).toBe(true);
  });

  it("`break` out of a for-await cancels the source stream", async () => {
    // The shape an ordinary consumer actually writes.
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let n = 0; n < 8; n++) controller.enqueue(chunk(n));
      },
      cancel() {
        state.cancelled = true;
      },
    });

    let taken = 0;
    for await (const _c of fromReadableStream(stream)) {
      void _c;
      if (++taken >= 2) break;
    }
    expect(taken).toBe(2);
    expect(state.cancelled).toBe(true);
  });

  it("still drains normally when nobody cancels", async () => {
    // The guard on the fix: a stream that ends on its own must still deliver
    // every chunk and must not report itself cancelled.
    const state = { cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(chunk(1));
        controller.enqueue(chunk(2));
        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const got: Uint8Array[] = [];
    for await (const c of fromReadableStream(stream)) got.push(c);
    expect(got).toEqual([chunk(1), chunk(2)]);
    expect(state.cancelled).toBe(false);
  });
});

async function waitFor(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
