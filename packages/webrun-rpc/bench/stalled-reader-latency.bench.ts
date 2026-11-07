import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// With one stream's reader stalled, pings on another stream of the same
// link stay as responsive as on a link with no window. Both are measured in
// this run, so the bar moves with the machine: p99 at most 2x the baseline's,
// plus 1 ms.

const KiB = 1024;
const WINDOW = 256 * KiB;
const CHUNK = 4 * KiB;
const PINGS = 1000;
const RUNS = 3;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

/** Ping p99 in ms beside a stalled endless body, `window` on both ends (0: none). */
async function stalledP99(window: number): Promise<number> {
  const ch = new MessageChannel();
  const handler: Duplex = async function* (input) {
    const first = await (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]().next();
    if ((first.value as Uint8Array)[0] === 1) {
      for (let n = 0; ; n++) yield new Uint8Array(CHUNK).fill(n & 0xff);
    }
    yield new Uint8Array([2]);
  };
  const teardown = await serve(
    { mux: overPipe(ch.port2, { codec: structuredCodec, side: "responder", window }) },
    handler,
  );
  const { call, close } = await connect({
    mux: overPipe(ch.port1, { codec: structuredCodec, side: "initiator", window }),
  });
  const ping = async () => {
    const t0 = performance.now();
    for await (const _ of call([new Uint8Array([2])])) {
    }
    return performance.now() - t0;
  };
  try {
    for (let i = 0; i < 50; i++) await ping(); // warm-up
    // The stalled reader: takes a few chunks, then stops pulling.
    const bulk = call([new Uint8Array([1])]);
    for (let i = 0; i < 8; i++) await bulk.next();
    await new Promise((r) => setTimeout(r, 200));
    const latencies: number[] = [];
    for (let i = 0; i < PINGS; i++) latencies.push(await ping());
    await bulk.return(undefined);
    latencies.sort((a, b) => a - b);
    return latencies[Math.floor(PINGS * 0.99)] as number;
  } finally {
    await close();
    await teardown();
    ch.port1.close();
    ch.port2.close();
  }
}

describe("a stalled reader beside a ping stream, one link", () => {
  it("ping p99 with the window is at most 2x the no-window p99 plus 1 ms", async () => {
    const plain: number[] = [];
    const windowed: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      plain.push(await stalledP99(0));
      windowed.push(await stalledP99(WINDOW));
    }
    const baseline = median(plain);
    const p99 = median(windowed);
    const bar = 2 * baseline + 1;
    console.log(
      `[bench] ping p99 beside a stalled reader (median of ${RUNS}): ` +
        `no window ${baseline.toFixed(3)} ms, window ${WINDOW / KiB} KiB ${p99.toFixed(3)} ms, ` +
        `bar ${bar.toFixed(3)} ms`,
    );
    expect(p99).toBeLessThanOrEqual(bar);
  });
});
