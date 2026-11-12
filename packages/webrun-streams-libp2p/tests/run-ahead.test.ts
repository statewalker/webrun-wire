/**
 * L6 (spec D17) for `connect` / `serve`, always on: a consumer that stops
 * reading throttles its producer, in either direction, instead of letting it
 * run 22-24 MiB ahead until libp2p's read buffer killed the stream (the
 * finding before the paced reader). With a 1 MiB window the bound is about
 * 1.2 MiB; with yamux's default 16 MiB window the stalled stream survives too,
 * bounded at about 16.2 MiB.
 */
import { measureRunAhead } from "@statewalker/webrun-streams-conformance";
import { describe, expect, it } from "vitest";
import {
  makeLibp2pPair,
  makePairWith,
  PAIR_STREAM_WINDOW,
  runAheadFor,
  YAMUX_DEFAULT_WINDOW,
} from "./make-libp2p-pair.js";

describe("run-ahead past a stalled consumer (L6)", () => {
  for (const direction of ["response", "request"] as const) {
    it(`${direction}: a 1 MiB window bounds the producer, every byte arrives in place`, async () => {
      const m = await measureRunAhead(makeLibp2pPair, direction);
      expect(m.bound).toBe(runAheadFor(PAIR_STREAM_WINDOW));
      expect(m.ahead).toBeLessThanOrEqual(m.bound as number);
      expect(m.complete).toBe(true);
      expect(m.intact).toBe(true);
    }, 60_000);

    it(`${direction}: yamux's default window: the stream survives the stall, bounded`, async () => {
      const m = await measureRunAhead(() => makePairWith(null), direction);
      expect(m.bound).toBe(runAheadFor(YAMUX_DEFAULT_WINDOW));
      expect(m.ahead).toBeLessThanOrEqual(m.bound as number);
      expect(m.complete).toBe(true);
      expect(m.intact).toBe(true);
    }, 120_000);
  }
});

describe("a consumer that stalls after a fast start (yamux's window grown)", () => {
  it("default window: the stream survives the stall, bounded, and completes", async () => {
    const pair = await makePairWith(null);
    try {
      const CHUNK = 64 * 1024;
      const COUNT = 1024; // 64 MiB
      let produced = 0;
      await pair.serve(async function* () {
        for (let i = 0; i < COUNT; i++) {
          produced++;
          yield new Uint8Array(CHUNK).fill(i & 0xff);
        }
      });
      const { call } = await pair.connect();
      const it = call([new Uint8Array(1)])[Symbol.asyncIterator]();
      let got = 0;
      let intact = true;
      const take = (c: Uint8Array) => {
        for (let j = 0; j < c.byteLength; j += 4096)
          if (c[j] !== (Math.floor((got + j) / CHUNK) & 0xff)) intact = false;
        got += c.byteLength;
      };
      // fast for 16 MiB: yamux doubles the window while data is consumed quickly
      while (got < 16 * 1024 * 1024) {
        const r = await it.next();
        if (r.done) break;
        take(r.value);
      }
      // stall until the producer stops
      let last = -1;
      while (produced !== last) {
        last = produced;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const ahead = produced * CHUNK - got;
      expect(ahead).toBeLessThanOrEqual(runAheadFor(YAMUX_DEFAULT_WINDOW));
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        take(r.value);
      }
      expect(got).toBe(COUNT * CHUNK);
      expect(intact).toBe(true);
    } finally {
      await pair.close?.();
    }
  }, 120_000);
});

describe("a handler that never reads its input", () => {
  it("answers a caller sending 8 MiB: the call completes, the unread input is dropped", async () => {
    const pair = await makeLibp2pPair();
    try {
      await pair.serve(async function* () {
        yield new TextEncoder().encode("ok");
      });
      const { call } = await pair.connect();
      const big = function* () {
        for (let i = 0; i < 128; i++) yield new Uint8Array(64 * 1024);
      };
      const out: Uint8Array[] = [];
      const started = Date.now();
      for await (const c of call(big())) out.push(c);
      expect(new TextDecoder().decode(out[0])).toBe("ok");
      expect(Date.now() - started).toBeLessThan(10_000); // not the 5-minute drain timeout
    } finally {
      await pair.close?.();
    }
  }, 30_000);
});
