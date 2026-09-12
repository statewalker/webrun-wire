/**
 * Cancelling a call must cancel the CALLER'S INPUT.
 *
 * `pumpOutbound` is fire-and-forget and checks `s.closed` only after a chunk
 * arrives, so before `Stream.cancelInput` existed an input that yielded
 * nothing more left the pump parked inside `next()` for ever — holding the
 * producer and its `finally` — even though the consumer had cancelled and the
 * stream slot was already gone.
 *
 * Found by a consumer (statewalker-sandbox's httpeers ladder) twice, each time
 * worked around by tearing the whole transport down instead. That is a defect
 * report, not a usage pattern.
 */

import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux } from "../src/index.js";

/** A loopback byte channel: whatever one mux sends, the other receives. */
function loopback(): { a: ByteChannel; b: ByteChannel } {
  const make = () => {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    return {
      push(bytes: Uint8Array) {
        queue.push(bytes);
        const w = wake;
        wake = null;
        w?.();
      },
      close() {
        done = true;
        const w = wake;
        wake = null;
        w?.();
      },
      async *recv(): AsyncGenerator<Uint8Array> {
        for (;;) {
          const next = queue.shift();
          if (next != null) {
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    };
  };

  const left = make();
  const right = make();
  const closedA = new Promise<void>(() => {});
  const closedB = new Promise<void>(() => {});

  return {
    a: {
      send: (bytes) => right.push(bytes),
      recv: left.recv(),
      closed: closedA,
      close: () => {
        left.close();
        right.close();
      },
    },
    b: {
      send: (bytes) => left.push(bytes),
      recv: right.recv(),
      closed: closedB,
      close: () => {
        left.close();
        right.close();
      },
    },
  };
}

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

describe("emulateMux: cancelling a call cancels the caller's input", () => {
  it("runs the producer's finally when the consumer returns early", async () => {
    const channel = loopback();
    const caller = emulateMux(channel.a, { side: "initiator" });
    const responder = emulateMux(channel.b, { side: "responder" });

    // Echo, so the caller receives something and the call is genuinely live.
    const stopServing = responder.serve(async function* (input) {
      for await (const chunk of input) yield chunk;
    });

    const input = tickingInput();
    const output = caller.call(input.iterable)[Symbol.asyncIterator]();
    expect((await output.next()).value).toEqual(te.encode("tick"));

    await output.return?.(undefined);

    // The producer must be told. Before the fix this never happened.
    const deadline = Date.now() + 2_000;
    while (!input.state.unwound && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(input.state.unwound).toBe(true);

    await stopServing();
    await caller.close();
    await responder.close();
  }, 20_000);

  it("returns promptly even when the producer cannot be woken", async () => {
    // A producer parked on an unresolvable await cannot be unwound by anyone —
    // `.return()` on an async generator suspended at an `await` is queued
    // behind it. Teardown must not wait for that, or one unwakeable producer
    // deadlocks the consumer.
    const channel = loopback();
    const caller = emulateMux(channel.a, { side: "initiator" });
    const responder = emulateMux(channel.b, { side: "responder" });
    const stopServing = responder.serve(async function* (input) {
      for await (const chunk of input) yield chunk;
    });

    const unwakeable = (async function* (): AsyncGenerator<Uint8Array> {
      yield te.encode("hello");
      await new Promise<void>(() => {});
    })();

    const output = caller.call(unwakeable)[Symbol.asyncIterator]();
    await output.next();

    const settled = await Promise.race([
      (output.return?.(undefined) ?? Promise.resolve()).then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 2_000)),
    ]);
    expect(settled).toBe("settled");

    await stopServing();
    await caller.close();
    await responder.close();
  }, 20_000);
});
