import { describe, expect, it } from "vitest";
import { connectHttpLink, type HttpLinkOptions, serveHttpLink } from "../src/link/http-link.js";

// Over the HTTP link with its default window, a streamed response body gets
// several times the throughput of the same link with `window: 0`: at least 2x
// in 256 B chunks, 1.5x in 4 KiB chunks. Both are measured in this run, so the
// bar moves with the machine: one warm-up pair (not recorded), then the median
// of the ratios of 7 pairs, the two modes alternating which runs first.

const KiB = 1024;
const MiB = 1024 * KiB;
const RUNS = 7;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

/** MB/s of one response body of `count` x `size` B, after a warm-up body. */
async function throughput(options: HttpLinkOptions, size: number, count: number) {
  const ch = new MessageChannel();
  const chunk = new Uint8Array(size).fill(7);
  const stop = await serveHttpLink(
    ch.port2,
    () => {
      let i = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (i++ < count) controller.enqueue(chunk.slice());
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
    options,
  );
  const link = await connectHttpLink(ch.port1, options);
  const read = async () => {
    const response = await link.send(new Request("http://x/body"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes;
      bytes += value.byteLength;
    }
  };
  try {
    await read(); // warm-up
    const t0 = performance.now();
    const bytes = await read();
    const ms = performance.now() - t0;
    if (bytes !== size * count) throw new Error(`short body: ${bytes} of ${size * count} bytes`);
    return bytes / MiB / (ms / 1000);
  } finally {
    await link.close();
    await stop();
    ch.port1.close();
    ch.port2.close();
  }
}

describe("HTTP link throughput, default window against window: 0", () => {
  for (const { size, count, bar } of [
    { size: 256, count: 8192, bar: 2 },
    // The link's own cost per chunk (ReadableStream, fetch framing, the copy on
    // receipt) caps the gain at 4 KiB; reducing it is a separate refactoring.
    { size: 4 * KiB, count: 2048, bar: 1.5 },
  ]) {
    it(`a body of ${count} x ${size} B gets at least ${bar}x the throughput`, async () => {
      const plain: number[] = [];
      const windowed: number[] = [];
      const ratios: number[] = [];
      // A warm-up pair, discarded: the first runs pay for the JIT and the heap.
      await throughput({ window: 0 }, size, count);
      await throughput({}, size, count);
      for (let r = 0; r < RUNS; r++) {
        let p: number;
        let w: number;
        if (r % 2 === 0) {
          p = await throughput({ window: 0 }, size, count);
          w = await throughput({}, size, count);
        } else {
          w = await throughput({}, size, count);
          p = await throughput({ window: 0 }, size, count);
        }
        plain.push(p);
        windowed.push(w);
        ratios.push(w / p);
      }
      const ratio = median(ratios);
      console.log(
        `[bench] ${count} x ${size} B (median of ${RUNS} pairs): window: 0 ${median(plain).toFixed(1)} MB/s, ` +
          `default window ${median(windowed).toFixed(1)} MB/s, ratio ${ratio.toFixed(2)}x`,
      );
      expect(ratio).toBeGreaterThanOrEqual(bar);
    });
  }
});
