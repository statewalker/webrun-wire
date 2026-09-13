/**
 * Cancelling a call whose INPUT IS STILL OPEN must not hang.
 *
 * Before this, `duplexOverStream`'s `finally` did:
 *
 *     await outboundSource.return?.(undefined);   // queued behind next()
 *     await outbound;                             // waits for the pump
 *
 * `.return()` on an async generator parked awaiting its own source is queued
 * behind that pending `next()` — it is not preemptive. A long-lived producer
 * spends its life inside `next()`, so neither await ever settled and
 * `.return()` on the call hung for ever. Two consumers hit it and both worked
 * around it by tearing down the whole connection.
 *
 * The fix cancels without waiting, and aborts the stream so the peer is told.
 * These tests pin both halves: teardown settles, and a producer that CAN be
 * woken is told to stop.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeLibp2pPair } from "./make-libp2p-pair.js";

const te = new TextEncoder();

/** Ticks, so its wait settles and a queued `.return()` can land. */
function tickingInput(everyMs = 20) {
  const state = { unwound: false };
  const iterable = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        yield te.encode("tick");
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    } finally {
      state.unwound = true;
    }
  })();
  return { state, iterable };
}

async function settledWithin(work: Promise<unknown>, budgetMs: number): Promise<string> {
  return await Promise.race([
    work.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("pending"), budgetMs);
      timer.unref?.();
    }),
  ]);
}

describe("duplexOverStream: cancelling a call with an open input", () => {
  let pair: Awaited<ReturnType<typeof makeLibp2pPair>>;
  let stopServing: () => Promise<void>;

  beforeAll(async () => {
    pair = await makeLibp2pPair();
    stopServing = await pair.serve(async function* (input) {
      for await (const chunk of input) yield chunk;
    });
  }, 60_000);

  afterAll(async () => {
    await stopServing?.();
    await pair?.close();
  });

  const dial = async () => await pair.connect();

  it("settles `.return()` promptly instead of hanging", async () => {
    const connection = await dial();
    const input = tickingInput();
    const output = connection.call(input.iterable)[Symbol.asyncIterator]();
    expect((await output.next()).value).toEqual(te.encode("tick"));

    const outcome = await settledWithin(
      (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
      5_000,
    );
    expect(outcome).toBe("settled");
    await connection.close();
  }, 30_000);

  it("cancels the producer, so its `finally` runs", async () => {
    const connection = await dial();
    const input = tickingInput();
    const output = connection.call(input.iterable)[Symbol.asyncIterator]();
    await output.next();

    await settledWithin(
      (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
      5_000,
    );

    const deadline = Date.now() + 3_000;
    while (!input.state.unwound && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(input.state.unwound).toBe(true);
    await connection.close();
  }, 30_000);

  it("still completes a call whose input ends naturally", async () => {
    // The fix must not cut a healthy call short: a producer that finishes on
    // its own is not a cancellation, and the graceful close path still applies.
    const connection = await dial();
    const once = (async function* (): AsyncGenerator<Uint8Array> {
      yield te.encode("one");
    })();
    const seen: string[] = [];
    for await (const chunk of connection.call(once)) {
      seen.push(new TextDecoder().decode(chunk));
    }
    expect(seen).toEqual(["one"]);
    await connection.close();
  }, 30_000);
});
