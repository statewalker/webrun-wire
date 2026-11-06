import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

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
});
