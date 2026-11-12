import { describe, expect, it } from "vitest";
import { readerIterator } from "../src/reader-iterator.js";

/**
 * How `readerIterator` lets go of its stream: the lock is released however the iteration
 * ends — read to its end, `return()`, `throw()`, an abort, a stream error — as the generator it
 * replaced released it, and a stream that fails on its own fails the iteration once, after which
 * it is done, as a generator would be.
 */

/** A stream that sends one chunk and then waits for good, noting its cancellations. */
function idleStream() {
  const cancels: unknown[] = [];
  let fail: (error: unknown) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      fail = (error) => controller.error(error);
    },
    cancel(reason) {
      cancels.push(reason);
    },
  });
  return { stream, cancels, fail: (error: unknown) => fail(error) };
}

/** Reads the first chunk, then starts a `next()` that waits on the idle stream. */
async function reading(it: AsyncIterableIterator<Uint8Array>) {
  // Returned in a box: an async function returning the promise itself would wait for it.
  expect(await it.next()).toEqual({ done: false, value: new Uint8Array([1]) });
  const inFlight = it.next().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await new Promise((r) => setTimeout(r, 5));
  return { inFlight };
}

const DONE = { done: true, value: undefined };

describe("readerIterator releases the stream's lock", () => {
  it("when read to its end", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const it = readerIterator(stream);
    expect((await it.next()).done).toBe(false);
    expect(await it.next()).toEqual(DONE);
    expect(stream.locked).toBe(false);
  });

  it("on return() with a next() in flight, which is done; cancelled once", async () => {
    const { stream, cancels } = idleStream();
    const it = readerIterator(stream);
    const { inFlight } = await reading(it);
    expect(await it.return?.()).toEqual(DONE);
    expect(await inFlight).toEqual({ result: DONE });
    expect(stream.locked).toBe(false);
    expect(await it.next()).toEqual(DONE);
    await it.return?.();
    expect(cancels).toEqual([undefined]);
  });

  it("on return() before the first next()", async () => {
    const { stream, cancels } = idleStream();
    const it = readerIterator(stream);
    expect(await it.return?.()).toEqual(DONE);
    expect(stream.locked).toBe(false);
    expect(await it.next()).toEqual(DONE);
    expect(stream.locked).toBe(false);
    expect(cancels).toEqual([undefined]);
  });

  it("on throw() with a next() in flight, which is done; cancelled once with the error", async () => {
    const { stream, cancels } = idleStream();
    const it = readerIterator(stream);
    const { inFlight } = await reading(it);
    const failure = new Error("torn down");
    await expect(it.throw?.(failure)).rejects.toBe(failure);
    expect(await inFlight).toEqual({ result: DONE });
    expect(stream.locked).toBe(false);
    expect(await it.next()).toEqual(DONE);
    expect(cancels).toEqual([failure]);
  });

  it("on an abort with a next() in flight, which fails with the reason; cancelled once", async () => {
    const { stream, cancels } = idleStream();
    const controller = new AbortController();
    const it = readerIterator(stream, controller.signal);
    const { inFlight } = await reading(it);
    const reason = new Error("aborted");
    controller.abort(reason);
    expect(await inFlight).toEqual({ error: reason });
    expect(stream.locked).toBe(false);
    await expect(it.next()).rejects.toBe(reason);
    await it.return?.();
    expect(cancels).toEqual([reason]);
  });

  it("on a signal already aborted at the first next()", async () => {
    const { stream, cancels } = idleStream();
    const controller = new AbortController();
    const reason = new Error("aborted");
    controller.abort(reason);
    const it = readerIterator(stream, controller.signal);
    await expect(it.next()).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
    expect(cancels).toEqual([reason]);
  });

  it("on a stream error, which fails the next() in flight once; later ones are done", async () => {
    const { stream, cancels, fail } = idleStream();
    const it = readerIterator(stream);
    const { inFlight } = await reading(it);
    const failure = new Error("producer failed");
    fail(failure);
    expect(await inFlight).toEqual({ error: failure });
    expect(stream.locked).toBe(false);
    expect(await it.next()).toEqual(DONE);
    expect(await it.next()).toEqual(DONE);
    await it.return?.();
    expect(cancels).toEqual([]);
  });

  it("on return() on a tee branch whose other branch nobody reads, without hanging", async () => {
    const { stream } = idleStream();
    const [branch] = stream.tee();
    const it = readerIterator(branch);
    const { inFlight } = await reading(it);
    let outcome: unknown;
    void Promise.all([inFlight, it.return?.()]).then((results) => {
      outcome = results;
    });
    for (let i = 0; i < 100 && outcome === undefined; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(outcome).toEqual([{ result: DONE }, DONE]);
    expect(branch.locked).toBe(false);
  });
});
