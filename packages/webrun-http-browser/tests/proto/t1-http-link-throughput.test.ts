// PROTOTYPE T-1 over the HTTP link: a Response body of many small chunks.
import { describe, expect, it } from "vitest";
import { connectHttpLink, serveHttpLink } from "../../src/link/http-link.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const RUNS = Number(process.env.RUNS ?? 3);
type Mode = "today" | "h1" | "h2";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

async function once(mode: Mode, window: number | undefined, size: number, count: number) {
  const ch = new MessageChannel();
  const opts =
    mode === "today" ? {} : { window, caps: [mode === "h1" ? "pipeline-msg" : "pipeline-call"] };
  const chunk = new Uint8Array(size).fill(7);
  const stop = await serveHttpLink(
    ch.port2,
    () => {
      let i = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              if (i++ < count) c.enqueue(chunk.slice());
              else c.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
    opts,
  );
  const link = await connectHttpLink(ch.port1, opts);
  const read = async () => {
    const res = await link.send(new Request("http://x/body"));
    let bytes = 0;
    // biome-ignore lint/style/noNonNullAssertion: body exists
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    return bytes;
  };
  await read(); // warm-up
  const t0 = performance.now();
  const bytes = await read();
  const ms = performance.now() - t0;
  await link.close();
  await stop();
  ch.port1.close();
  ch.port2.close();
  if (bytes !== size * count) throw new Error(`short body ${bytes}`);
  return bytes / MiB / (ms / 1000);
}

const configs: Array<{ mode: Mode; window?: number }> = [
  { mode: "today" },
  { mode: "h1", window: 64 * KiB },
  { mode: "h1", window: 256 * KiB },
  { mode: "h1", window: MiB },
  { mode: "h2", window: 256 * KiB },
  { mode: "h2", window: MiB },
];

describe("T-1 over connectHttpLink / serveHttpLink on a MessageChannel", () => {
  for (const { size, count } of [
    { size: 256, count: 8192 },
    { size: 4 * KiB, count: 2048 },
  ]) {
    it(`Response body of ${count} x ${size} B: pipelined >= 2x today`, async () => {
      const rows: Record<string, number> = {};
      for (const { mode, window } of configs) {
        const runs: number[] = [];
        for (let r = 0; r < RUNS; r++) runs.push(await once(mode, window, size, count));
        rows[window ? `${mode}@${window / KiB}KiB` : mode] = median(runs);
      }
      const today = rows.today as number;
      console.log(
        `\n[T-1 http-link] ${count} x ${size} B (median of ${RUNS})\n` +
          Object.entries(rows)
            .map(
              ([k, v]) =>
                `${k.padEnd(14)} ${v.toFixed(1).padStart(8)} MB/s  ${(v / today).toFixed(2)}x`,
            )
            .join("\n"),
      );
      expect((rows["h1@256KiB"] as number) / today).toBeGreaterThanOrEqual(2);
    }, 300_000);
  }
});
