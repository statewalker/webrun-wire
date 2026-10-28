/**
 * Closing a link fails the calls in flight on it.
 *
 * Before, `close()` on a `connect` link (or the teardown of a `serve`) marked
 * the multiplexer's virtual ports closed and nothing else: a call waiting for
 * the peer's next chunk stayed pending forever. That is what a ServiceWorker
 * restart looks like from a handler's side, and a call that hangs is worse
 * than one that fails, because the caller cannot tell it apart from a slow
 * one.
 */

import { describe, expect, it } from "vitest";
import { connect, MUX_CLOSED_MESSAGE, overPipe, serve, structuredCodec } from "../src/index.js";

const empty = async function* (): AsyncGenerator<Uint8Array> {};

function pair() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

/** A handler that sends one chunk, then waits until released. */
function stalling() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const handler = async function* (input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    try {
      for await (const _ of input) {
        // drain
      }
      yield new Uint8Array([1]);
      await released;
      yield new Uint8Array([2]);
    } finally {
      finished = true;
    }
  };
  return { handler, release, isFinished: () => finished };
}

async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("still pending")), ms)),
  ]);
}

describe("closing a link fails the calls in flight on it", () => {
  it("the caller closes its own link", async () => {
    const channel = pair();
    const { handler, release } = stalling();
    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      handler,
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
    });

    const it = call(empty());
    expect((await it.next()).value).toEqual(new Uint8Array([1]));
    const pending = it.next();
    await close();
    await expect(within(pending)).rejects.toThrow("webrun-rpc: the multiplexer was closed");
    expect(MUX_CLOSED_MESSAGE).toBe("webrun-rpc: the multiplexer was closed");

    release();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });

  it("the serving side tears down", async () => {
    const channel = pair();
    const { handler, isFinished } = stalling();
    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      handler,
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
    });

    const it = call(empty());
    expect((await it.next()).value).toEqual(new Uint8Array([1]));
    const pending = it.next();
    await teardown();
    await expect(within(pending)).rejects.toThrow("webrun-rpc:");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isFinished()).toBe(true);

    await close();
    channel.port1.close();
    channel.port2.close();
  });
});
