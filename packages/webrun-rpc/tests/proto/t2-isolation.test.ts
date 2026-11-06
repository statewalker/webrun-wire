// PROTOTYPE T-2: does pipelining keep isolation and bounded memory?
import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { connect, overPipe, serve } from "../../src/connect-serve.js";
import type { PortInfo, PortMux } from "../../src/port-types.js";
import { structuredCodec } from "../../src/structured-codec.js";
import { type Mode, median } from "./harness.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const RUNS = Number(process.env.RUNS ?? 3);
const CHUNK = 4 * KiB;
const PINGS = 1000;

const gc = (globalThis as { gc?: () => void }).gc;
const heap = async () => {
  for (let i = 0; i < 3; i++) {
    gc?.();
    await new Promise((r) => setTimeout(r, 10));
  }
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

async function run(mode: Mode, window?: number) {
  const ch = new MessageChannel();
  const caps = mode === "today" ? undefined : [mode === "h1" ? "pipeline-msg" : "pipeline-call"];
  const opts = mode === "today" ? {} : { window, caps };
  let produced = 0;
  let serverMux: (PortMux & { ports?(): PortInfo[] }) | undefined;
  let clientMux: (PortMux & { ports?(): PortInfo[] }) | undefined;
  const handler: Duplex = async function* (input) {
    const first = await input[Symbol.asyncIterator]().next();
    const kind = (first.value as Uint8Array)[0];
    if (kind === 1) {
      // the bulk stream: an endless body of fresh 4 KiB chunks
      for (;;) {
        produced++;
        yield new Uint8Array(CHUNK).fill(produced & 0xff);
      }
    }
    // the ping stream: echo
    yield new Uint8Array([2]);
  };
  const serverFactory = overPipe(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    ...opts,
  } as never);
  const teardown = await serve(
    {
      mux: async (onPort) => {
        serverMux = await serverFactory(onPort);
        return serverMux;
      },
    },
    handler,
  );
  const clientFactory = overPipe(ch.port1, {
    codec: structuredCodec,
    side: "initiator",
    ...opts,
  } as never);
  const { call, close } = await connect({
    mux: async (onPort) => {
      clientMux = await clientFactory(onPort);
      return clientMux;
    },
  });

  const ping = async () => {
    const t0 = performance.now();
    for await (const _ of call([new Uint8Array([2])])) {
    }
    return performance.now() - t0;
  };
  // baseline latency with no stalled stream
  for (let i = 0; i < 50; i++) await ping();
  const heap0 = await heap();

  // the stalled reader: read one chunk, then stop pulling
  const bulk = call([new Uint8Array([1])]);
  for (let i = 0; i < 8; i++) await bulk.next();
  await new Promise((r) => setTimeout(r, 200));
  const producedAfterStall = produced;

  const lat: number[] = [];
  for (let i = 0; i < PINGS; i++) lat.push(await ping());
  await new Promise((r) => setTimeout(r, 200));
  const heap1 = await heap();
  const producedEnd = produced;
  const held = (clientMux?.ports?.() ?? []).reduce((n, p) => n + (p.unconsumed ?? 0), 0);
  const queued = (serverMux?.ports?.() ?? []).reduce((n, p) => n + (p.queued ?? 0), 0);

  await bulk.return(undefined);
  await close();
  await teardown();
  ch.port1.close();
  ch.port2.close();
  lat.sort((a, b) => a - b);
  return {
    p50: lat[Math.floor(lat.length * 0.5)] as number,
    p99: lat[Math.floor(lat.length * 0.99)] as number,
    producedAfterStall,
    producedEnd,
    heapGrowthKiB: (heap1 - heap0) / KiB,
    clientUnconsumedKiB: held / KiB,
    serverQueuedKiB: queued / KiB,
  };
}

const configs: Array<{ mode: Mode; window?: number }> = [
  { mode: "today" },
  { mode: "h1", window: 256 * KiB },
  { mode: "h1", window: MiB },
  { mode: "h2", window: 256 * KiB },
  { mode: "h2", window: MiB },
];

describe("T-2 stalled reader beside a ping stream, one link", () => {
  it("ping p99 no worse than today; memory bounded by about one window", async () => {
    const rows: Record<string, Record<string, number>> = {};
    for (const { mode, window } of configs) {
      const label = window ? `${mode}@${window / KiB}KiB` : mode;
      const runs = [];
      for (let r = 0; r < RUNS; r++) runs.push(await run(mode, window));
      const keys = Object.keys(runs[0] as object) as Array<keyof (typeof runs)[0]>;
      rows[label] = Object.fromEntries(keys.map((k) => [k, median(runs.map((x) => x[k]))]));
    }
    console.log(`\n[T-2] gc=${!!gc} median of ${RUNS}`);
    console.table(rows);
    const today = rows.today as Record<string, number>;
    for (const { mode, window } of configs) {
      if (!window) continue;
      const row = rows[`${mode}@${window / KiB}KiB`] as Record<string, number>;
      // isolation: p99 within noise of today (1.5x or +0.5 ms)
      expect(row.p99).toBeLessThanOrEqual(Math.max(today.p99 * 1.5, today.p99 + 0.5));
      // bounded: the producer ran at most about one window ahead, and did not
      // keep running while the reader stayed stalled
      expect(row.producedEnd * CHUNK).toBeLessThanOrEqual(window * 1.5 + 16 * CHUNK);
      expect(row.producedEnd).toBe(row.producedAfterStall);
      if (gc)
        expect(row.heapGrowthKiB - today.heapGrowthKiB).toBeLessThanOrEqual((window / KiB) * 2);
    }
  }, 300_000);
});
