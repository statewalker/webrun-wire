import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  connect,
  duplexOverPort,
  overPipe,
  STREAM_ABORT,
  serve,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

/**
 * A caller that gives up on a stream while it waits for the peer ends it at once.
 *
 * `return()` on an async generator is queued behind a pending `next()`. A peer
 * that never answers would then keep the stream — its port, on a multiplexer —
 * for good: an aborted request to a hung handler was a port lost per request.
 */

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A handler that takes the input and never answers, noting when it is let go. */
function silent(state: { started: number; ended: number }): Duplex {
  return async function* (input) {
    state.started++;
    try {
      for await (const _ of input);
      await new Promise(() => {});
      yield new Uint8Array(0);
    } finally {
      state.ended++;
    }
  };
}

describe("return() while a next() is pending", () => {
  it("duplexOverPort: ends the stream at once and tells the peer", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const notices: unknown[] = [];
    channel.port2.addEventListener("message", (e) => {
      if ((e.data as { type?: unknown })?.type === STREAM_ABORT) notices.push(e.data);
    });
    const state = { started: 0, ended: 0 };
    const off = serveDuplexOverPort(channel.port2, silent(state));
    closers.push(
      off,
      () => channel.port1.close(),
      () => channel.port2.close(),
    );

    const stream = duplexOverPort(channel.port1)([new Uint8Array([1])]);
    const pending = stream.next();
    await tick(20);
    const t0 = Date.now();
    await stream.return(undefined);
    expect(Date.now() - t0).toBeLessThan(100);
    await expect(pending).rejects.toThrow(/abandoned/);
    await tick(20);
    expect(notices.length).toBe(1);
  });

  it("connect/serve: rounds of it against a peer that never answers keep the link usable", async () => {
    const channel = new MessageChannel();
    const state = { started: 0, ended: 0 };
    const stop = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder", maxPorts: 2 }) },
      silent(state),
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator", maxPorts: 2 }),
    });
    closers.push(
      close,
      stop,
      () => channel.port1.close(),
      () => channel.port2.close(),
    );

    for (let i = 0; i < 20; i++) {
      const stream = call([new Uint8Array([i])]);
      const pending = stream.next();
      pending.catch(() => {});
      for (let k = 0; k < 100 && state.started <= i; k++) await tick(2);
      const t0 = Date.now();
      await stream.return(undefined);
      expect(Date.now() - t0, `round ${i + 1}`).toBeLessThan(100);
    }
    // Each round got a port on both ends (two at most): every one was given back,
    // though the handler itself is still stuck in an await nothing can end.
    expect(state.started).toBe(20);
  });

  it("connect: return() before the first pull opens no port at all", async () => {
    const channel = new MessageChannel();
    let opened = 0;
    const stop = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder", maxPorts: 1 }) },
      async function* () {
        opened++;
        yield new Uint8Array(0);
      },
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator", maxPorts: 1 }),
    });
    closers.push(
      close,
      stop,
      () => channel.port1.close(),
      () => channel.port2.close(),
    );
    for (let i = 0; i < 5; i++) await call([]).return(undefined);
    await tick(20);
    expect(opened).toBe(0);
    // And the one port there is still opens.
    const chunks: Uint8Array[] = [];
    for await (const c of call([])) chunks.push(c);
    expect(opened).toBe(1);
  });
});
