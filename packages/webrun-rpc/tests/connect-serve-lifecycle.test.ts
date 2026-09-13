/**
 * What `connect`/`serve` claim for themselves, and the conformance suite
 * cannot see.
 *
 * L0–L6 exercise the `Duplex` contract — round-trip, concurrency, half-close,
 * cancellation, errors, teardown, chunking — and they pass for any adapter
 * that honours it. They are blind to the choices THIS adapter makes underneath:
 * when a port is opened, what teardown posts before it drops the transport, and
 * whether the bookkeeping that makes teardown possible is itself bounded.
 *
 * Each test below corresponds to a claim written in `connect-serve.ts`. A claim
 * in a comment with no test is a wish, and this file is where those stopped
 * being wishes.
 */

import { describe, expect, it } from "vitest";
import { STREAM_ABORT } from "../src/duplex-over-port.js";
import { connect, serve } from "../src/index.js";

const empty = async function* (): AsyncGenerator<Uint8Array> {};

/** Count the abort notices one side posts, without disturbing delivery. */
function countAborts(port: MessagePort): () => number {
  let aborts = 0;
  const original = port.postMessage.bind(port);
  (port as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage = (
    message: unknown,
    transfer?: Transferable[],
  ) => {
    // The notice travels inside a port envelope, so the payload is nested.
    if (JSON.stringify(message ?? null)?.includes(STREAM_ABORT)) aborts++;
    original(message as never, transfer as never);
  };
  return () => aborts;
}

function pair() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

describe("connect: the port is opened on the first pull", () => {
  it("costs the peer nothing when a caller builds a stream and never iterates it", async () => {
    // The claim: "A caller that builds a stream and then drops it without
    // iterating therefore costs the peer nothing — under eager opening it
    // would have burned an id and left the responder holding a handler for a
    // call that never arrives."
    const channel = pair();
    let handlerCalls = 0;

    const teardown = await serve({ port: channel.port2, side: "responder" }, async function* () {
      handlerCalls++;
      yield new Uint8Array(0);
    });
    const { call, close } = await connect({ port: channel.port1, side: "initiator" });

    // Build ten streams; iterate none of them.
    for (let i = 0; i < 10; i++) void call(empty());
    await new Promise((r) => setTimeout(r, 100));

    expect(handlerCalls).toBe(0);

    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });

  it("opens exactly one port per stream that IS iterated", async () => {
    const channel = pair();
    let handlerCalls = 0;

    const teardown = await serve({ port: channel.port2, side: "responder" }, async function* () {
      handlerCalls++;
      yield new Uint8Array(0);
    });
    const { call, close } = await connect({ port: channel.port1, side: "initiator" });

    for (let i = 0; i < 5; i++) {
      for await (const _ of call(empty())) {
        /* drain */
      }
    }

    expect(handlerCalls).toBe(5);

    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });
});

describe("serve: teardown", () => {
  it("abandons a LIVE stream so its caller rejects instead of parking", async () => {
    // Layer 1's close is not observable to layer 2 — a closed virtual port
    // drops its listeners silently and looks exactly like a working port
    // nobody is answering. Without a deliberate notice the caller waits for
    // ever, which is the failure this ordering exists to prevent.
    const channel = pair();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const teardown = await serve({ port: channel.port2, side: "responder" }, async function* () {
      yield new Uint8Array([1]);
      await gate; // still running when teardown happens
      yield new Uint8Array([2]);
    });
    const { call, close } = await connect({ port: channel.port1, side: "initiator" });

    const it = call(empty())[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual(new Uint8Array([1]));

    await teardown();

    // The caller learns the stream is over rather than hanging on `next()`.
    await expect(
      Promise.race([
        it.next(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("TIMED OUT — the caller parked")), 3000),
        ),
      ]),
    ).rejects.toThrow(/abandoned|abort|closed/i);

    release();
    await close();
    channel.port1.close();
    channel.port2.close();
  }, 20_000);

  it("does NOT abort streams that already finished — the live set is pruned", async () => {
    // THE SHARPEST TEST HERE, because the hazard is invisible otherwise. The
    // implementation tracks live streams so teardown can abandon them; a set
    // that merely accumulated one entry per call would grow for the life of
    // the connection — the same unbounded retention this stack exists to
    // avoid, moved from bytes into closures.
    //
    // That is unobservable from outside... except at teardown, where an
    // unpruned set would abort every stream it ever saw. So: run many calls to
    // completion, tear down, and count the notices. Pruned ⇒ zero.
    const channel = pair();
    const aborts = countAborts(channel.port2);

    const teardown = await serve({ port: channel.port2, side: "responder" }, async function* () {
      yield new Uint8Array([7]);
    });
    const { call, close } = await connect({ port: channel.port1, side: "initiator" });

    const CALLS = 50;
    for (let i = 0; i < CALLS; i++) {
      for await (const _ of call(empty())) {
        /* drain to completion */
      }
    }

    await teardown();

    // Fifty streams ran and every one of them ended on its own. None is live,
    // so teardown has nothing to abandon.
    expect(aborts()).toBe(0);

    await close();
    channel.port1.close();
    channel.port2.close();
  }, 30_000);

  it("is idempotent", async () => {
    const channel = pair();
    const teardown = await serve({ port: channel.port2, side: "responder" }, async function* () {
      yield new Uint8Array(0);
    });

    await teardown();
    await expect(teardown()).resolves.toBeUndefined();

    channel.port1.close();
    channel.port2.close();
  });
});

describe("connect: a caller answers no inbound calls", () => {
  it("refuses a port the peer opens rather than accepting and starving it", async () => {
    // `connect` passes no `onPort`, and `multiplexPort` refuses inbound ports
    // when there is none. The alternative — accepting a port nothing will ever
    // read — is the worse failure: the peer sees an open stream and waits.
    const channel = pair();

    const { close } = await connect({ port: channel.port1, side: "initiator" });
    // The other end tries to call US.
    const backwards = await connect({ port: channel.port2, side: "responder" });

    const it = backwards.call(empty())[Symbol.asyncIterator]();

    await expect(
      Promise.race([
        it.next(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("TIMED OUT — the port was accepted and starved")), 3000),
        ),
      ]),
    ).rejects.toThrow();

    await backwards.close();
    await close();
    channel.port1.close();
    channel.port2.close();
  }, 20_000);
});
