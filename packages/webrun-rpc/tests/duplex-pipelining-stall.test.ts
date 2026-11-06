import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// A stalled reader on a pipelined stream: the producer runs about one window
// ahead and then stops, and what the link holds for it is about one window.
// The memory half collects garbage before it measures.

const KiB = 1024;
const WINDOW = 256 * KiB;
const CHUNK = 4 * KiB;

const MiB = 1024 * KiB;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await settle(10);
  }
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/**
 * One link, `window` on both ends (0: none). The handler answers an endless
 * body of `chunkAt(n)`, fresh chunks by default; the caller reads 8 of them
 * and stops pulling.
 */
async function stall(
  window: number,
  chunkAt = (n: number) => new Uint8Array(CHUNK).fill(n & 0xff),
) {
  const ch = new MessageChannel();
  let produced = 0;
  const endless: Duplex = async function* (input) {
    for await (const _ of input) {
    }
    for (;;) {
      produced++;
      yield chunkAt(produced);
    }
  };
  const teardown = await serve(
    { mux: overPipe(ch.port2, { codec: structuredCodec, side: "responder", window }) },
    endless,
  );
  const { call, close } = await connect({
    mux: overPipe(ch.port1, { codec: structuredCodec, side: "initiator", window }),
  });

  const before = await heap();
  const body = call([new Uint8Array([1])]);
  for (let i = 0; i < 8; i++) await body.next();
  await settle(200);
  const producedAtStall = produced;
  await settle(300);
  const held = (await heap()) - before;
  const producedLater = produced;

  await body.return(undefined);
  await close();
  await teardown();
  ch.port1.close();
  ch.port2.close();
  return { producedAtStall, producedLater, held };
}

describe("duplexOverPort — a stalled reader on a pipelined stream", () => {
  it("the producer stops about one window ahead", async () => {
    const { producedAtStall, producedLater } = await stall(WINDOW);
    // Pipelined: well past the one chunk ahead an acknowledged stream allows…
    expect(producedAtStall * CHUNK).toBeGreaterThan(WINDOW / 2);
    // …but within the window (plus the 8 chunks read, and one in hand).
    expect(producedAtStall * CHUNK).toBeLessThanOrEqual(WINDOW + 10 * CHUNK);
    expect(producedLater).toBe(producedAtStall);
  });

  it("memory above the window: 0 baseline stays within 2x the window", async () => {
    const baseline = await stall(0);
    const piped = await stall(WINDOW);
    expect(baseline.producedLater).toBe(baseline.producedAtStall);
    expect(piped.held - baseline.held).toBeLessThanOrEqual(2 * WINDOW);
  });

  for (const [kind, big] of [
    ["Uint8Array", new Uint8Array(4 * MiB)],
    ["Node Buffer", Buffer.alloc(4 * MiB)],
  ] as const) {
    it(`a producer yielding ${kind} views of one large buffer holds about one window too`, async () => {
      // `toChunks` and Node `Buffer` slices yield views; posted as they are,
      // each chunk would carry the whole 4 MiB buffer past a window that
      // counts 4 KiB.
      const view = (n: number) => big.subarray((n * CHUNK) % big.byteLength).subarray(0, CHUNK);
      const baseline = await stall(0, view);
      const piped = await stall(WINDOW, view);
      expect(piped.producedLater).toBe(piped.producedAtStall);
      expect(piped.held - baseline.held).toBeLessThanOrEqual(2 * WINDOW);
    });
  }
});
