import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// A sender that waits on a full window, chunk after chunk, holds memory that
// does not grow with the number of chunks: each wait leaves nothing behind.

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const KiB = 1024;
const MB = 1024 * KiB;
const CHUNKS = 200_000;
const FIRST = 20_000;
const LAST = 190_000;

function heapAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe("a stream whose sender waits on the window", () => {
  it("keeps heap flat between chunks 20k and 190k", { timeout: 120_000 }, async () => {
    // Small, so the sender waits on it often: a wider window returns credit in
    // batches, and the waits (not the chunks) are what a leak would count.
    const window = 1 * KiB;
    const channel = new MessageChannel();
    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder", window }) },
      async function* () {
        for (let i = 0; i < CHUNKS; i++) yield new Uint8Array(16);
      },
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator", window }),
    });
    try {
      let count = 0;
      let atFirst = 0;
      let atLast = 0;
      for await (const _ of call([])) {
        count++;
        // A reader that lets the sender fill the window now and then.
        if (count % 64 === 0) await new Promise((r) => setTimeout(r, 0));
        if (count === FIRST) atFirst = heapAfterGc();
        if (count === LAST) atLast = heapAfterGc();
      }
      expect(count).toBe(CHUNKS);
      expect((atLast - atFirst) / MB).toBeLessThanOrEqual(2);
    } finally {
      await close();
      await teardown();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
