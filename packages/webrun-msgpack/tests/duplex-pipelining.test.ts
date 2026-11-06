import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  connect,
  type MessageListener,
  type MessageTarget,
  multiplexPort,
  overPipe,
  serve,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { msgpackCodec, serialize } from "../src/index.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const KiB = 1024;
const MiB = 1024 * KiB;

/** Bytes of `ArrayBuffer`s alive after a full collection. */
async function liveBuffers(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 10));
  }
  return process.memoryUsage().arrayBuffers;
}

/**
 * Two ends of an in-process pipe that hands each message over as a Node
 * `Buffer`, as a Node socket does: the codec then decodes into `Buffer` views
 * of the whole frame.
 */
function bufferPipe(): [MessageTarget, MessageTarget] {
  const listeners = [new Set<MessageListener>(), new Set<MessageListener>()];
  const end = (me: 0 | 1): MessageTarget => ({
    postMessage(data) {
      const frame = Buffer.from(data as Uint8Array);
      setTimeout(() => {
        for (const l of listeners[1 - me] ?? []) l(new MessageEvent("message", { data: frame }));
      }, 0);
    },
    addEventListener: (_type, l) => void listeners[me]?.add(l),
    removeEventListener: (_type, l) => void listeners[me]?.delete(l),
  });
  return [end(0), end(1)];
}

// With a byte codec the window counts encoded bytes, which for a pipelined
// chunk of a few bytes is less than the structured estimate. A reader that
// stalls behind a full window of such chunks must still be honest traffic,
// not a sender past the window.

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("pipelined streams with msgpackCodec", () => {
  it("a reader that stalls behind a full window of tiny chunks still gets them all", async () => {
    const CHUNKS = 2000;
    const tiny: Duplex = async function* (input) {
      for await (const _ of input) {
      }
      for (let i = 0; i < CHUNKS; i++) yield new Uint8Array([i & 0xff]);
    };
    const ch = new MessageChannel();
    const window = 4 * 1024;
    const teardown = await serve(
      { mux: overPipe(ch.port2, { codec: msgpackCodec, side: "responder", window }) },
      tiny,
    );
    const { call, close } = await connect({
      mux: overPipe(ch.port1, { codec: msgpackCodec, side: "initiator", window }),
    });
    cleanups.push(async () => {
      await close();
      await teardown();
      ch.port1.close();
      ch.port2.close();
    });

    const seen: number[] = [];
    for await (const chunk of call([new Uint8Array([1])])) {
      seen.push(...chunk);
      // Stall now and then, long enough for the window to fill.
      if (seen.length % 500 === 1) await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toEqual(Array.from({ length: CHUNKS }, (_, i) => i & 0xff));
  });

  it("a chunk decoded as a view of a large Buffer frame is held as its own bytes", async () => {
    // A hostile frame: a one-byte chunk beside 1 MiB the receiver ignores. It
    // counts 33 bytes; held as decoded, each would keep its whole frame.
    const [wire, server] = bufferPipe();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mux = multiplexPort(server, {
      codec: msgpackCodec,
      side: "responder",
      onPort: (port) => {
        serveDuplexOverPort(port, async function* (input) {
          await gate;
          for await (const _ of input) {
          }
          yield new Uint8Array(0);
        });
        return true;
      },
    });
    cleanups.push(async () => {
      release();
      await mux.close();
    });
    wire.postMessage(serialize({ type: "open", id: 0, window: 64 * KiB, caps: ["pipeline"] }));
    wire.postMessage(serialize({ type: "credit", id: 0, bytes: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    const before = await liveBuffers();
    for (let i = 0; i < 50; i++) {
      const payload = {
        type: "webrun-rpc:chunk",
        channelName: "in",
        chunk: { done: false, value: new Uint8Array([i]) },
        junk: new Uint8Array(MiB),
      };
      wire.postMessage(serialize({ type: "message", id: 0, payload }));
    }
    await new Promise((r) => setTimeout(r, 200));
    const held = (await liveBuffers()) - before;
    expect(mux.ports()).toHaveLength(1);
    expect(held).toBeLessThan(2 * MiB);
  });
});
