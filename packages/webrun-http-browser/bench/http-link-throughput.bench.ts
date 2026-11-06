import { describe, expect, it } from "vitest";
import { connectHttpLink, type HttpLinkOptions, serveHttpLink } from "../src/link/http-link.js";

// Over the HTTP link with its default window, a streamed response body
// gets at least 2x the throughput of the same link with `window: 0`. Both are
// measured in this run, median of 3, so the bar moves with the machine.

const KiB = 1024;
const MiB = 1024 * KiB;
const RUNS = 3;

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
  for (const { size, count } of [
    { size: 256, count: 8192 },
    { size: 4 * KiB, count: 2048 },
  ]) {
    it(`a body of ${count} x ${size} B gets at least 2x the throughput`, async () => {
      const plain: number[] = [];
      const windowed: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        plain.push(await throughput({ window: 0 }, size, count));
        windowed.push(await throughput({}, size, count));
      }
      const ratio = median(windowed) / median(plain);
      console.log(
        `[bench] ${count} x ${size} B (median of ${RUNS}): window: 0 ${median(plain).toFixed(1)} MB/s, ` +
          `default window ${median(windowed).toFixed(1)} MB/s, ratio ${ratio.toFixed(2)}x`,
      );
      expect(ratio).toBeGreaterThanOrEqual(2);
    });
  }
});
