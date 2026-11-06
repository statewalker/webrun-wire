import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// A stalled reader on a pipelined stream: the producer runs about one window
// ahead and then stops, and what the link holds for it is about one window.
// The memory half needs `--expose-gc` (the ticket's command passes it);
// without it only the producer half runs.

const KiB = 1024;
const WINDOW = 256 * KiB;
const CHUNK = 4 * KiB;

const gc = (globalThis as { gc?: () => void }).gc;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc?.();
    await settle(10);
  }
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/**
 * One link, `window` on both ends (0: none). The handler answers an endless
 * body of fresh chunks; the caller reads 8 of them and stops pulling.
 */
async function stall(window: number) {
  const ch = new MessageChannel();
  let produced = 0;
  const endless: Duplex = async function* (input) {
    for await (const _ of input) {
    }
    for (;;) {
      produced++;
      yield new Uint8Array(CHUNK).fill(produced & 0xff);
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

  it.skipIf(!gc)("memory above the window: 0 baseline stays within 2x the window", async () => {
    const baseline = await stall(0);
    const piped = await stall(WINDOW);
    expect(baseline.producedLater).toBe(baseline.producedAtStall);
    expect(piped.held - baseline.held).toBeLessThanOrEqual(2 * WINDOW);
  });
});
