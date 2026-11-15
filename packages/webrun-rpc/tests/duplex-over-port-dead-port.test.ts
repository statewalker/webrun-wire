/**
 * A call whose port dies while the caller's input is still open — a tunnel
 * whose producer waits for something to send — fails at once instead of
 * waiting for that producer (statewalker/webrun-wire#153).
 *
 * The caller's teardown awaits its sending pump, and the pump sat in the
 * producer's `next()`: an async generator's `return()` is queued behind a
 * pending `next()`, so forwarding it on abort did not end the wait. Found by
 * webrun-streams-libp2p's dead-peer suite once its `connect` ran over windowed
 * native ports, where a chunk leaves without waiting for its confirmation and
 * the pump reaches the producer's next `next()` at once.
 */
import { describe, expect, it } from "vitest";
import {
  duplexOverPort,
  type MessageTarget,
  serveDuplexOverPort,
  setPortCloseSignal,
} from "../src/index.js";
import { throughAbort } from "../src/through-abort.js";

const settledWithin = async (work: Promise<unknown>, ms: number): Promise<unknown> =>
  Promise.race([
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);

/** Yields `[0]`, then waits for ever; records whether its `finally` ran. */
function openInput() {
  const state = { unwound: false };
  const input = (async function* () {
    try {
      yield new Uint8Array([0]);
      await new Promise(() => {});
    } finally {
      state.unwound = true;
    }
  })();
  return { state, input };
}

describe("throughAbort", () => {
  it("ends when the signal fired while its consumer held a value, though the source's return() never settles", async () => {
    const controller = new AbortController();
    let pulls = 0;
    // A hand-written source: its second next() and its return() never settle.
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          pulls++ === 0 ? Promise.resolve({ done: false, value: 1 }) : new Promise(() => {}),
        return: () => new Promise(() => {}),
      }),
    };
    const through = throughAbort(source, controller.signal);
    expect((await through.next()).value).toBe(1);
    // aborted between two next() calls: the consumer was still busy with the value
    controller.abort(new Error("gone"));
    expect(await settledWithin(through.next(), 1000)).toEqual({
      value: { done: true, value: undefined },
    });
  });

  it("ends on abort while the source's next() is pending", async () => {
    const controller = new AbortController();
    const { input } = openInput();
    const through = throughAbort(input, controller.signal);
    expect((await through.next()).value).toEqual(new Uint8Array([0]));
    const pending = through.next();
    controller.abort(new Error("gone"));
    expect(await settledWithin(pending, 1000)).toEqual({ value: { done: true, value: undefined } });
  });
});

describe("duplexOverPort: the port closes under a caller whose input is open", () => {
  it("fails the caller's pending read promptly", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const closed = new AbortController();
    const callerPort = channel.port1 as unknown as MessageTarget;
    setPortCloseSignal(callerPort, closed.signal);
    serveDuplexOverPort(channel.port2 as unknown as MessageTarget, (input) =>
      (async function* () {
        yield new Uint8Array([1]);
        for await (const _ of input);
        await new Promise(() => {});
      })(),
    );
    const { input } = openInput();
    const out = duplexOverPort(callerPort)(input)[Symbol.asyncIterator]();
    expect((await out.next()).value).toEqual(new Uint8Array([1]));
    const pending = out.next();
    // the handler has pulled the caller's chunk; the pump waits on the producer
    await new Promise((resolve) => setTimeout(resolve, 50));
    closed.abort(new Error("the peer is gone"));
    const outcome = await settledWithin(pending, 1000);
    expect(outcome).not.toBe("pending");
    expect((outcome as { error?: Error }).error?.message).toBe("the peer is gone");
    channel.port1.close();
    channel.port2.close();
  });
});
