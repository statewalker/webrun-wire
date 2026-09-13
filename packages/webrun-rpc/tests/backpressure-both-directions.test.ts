/**
 * Backpressure in the OTHER direction, and under concurrency.
 *
 * `connect-serve-backpressure.test.ts` measures caller -> handler. The claim in
 * `duplexOverPort`'s doc comment is symmetric — "within each direction the next
 * chunk is never sent until the previous one has been delivered *and* pulled
 * past by the consumer" — and a claim that holds in the tested direction and
 * fails in the untested one is exactly the shape a reviewer would miss.
 *
 * The concurrency case matters for a different reason. The bound is PER PORT,
 * so "one chunk ahead" does not mean one chunk in the process: N open calls
 * permit N. That is still bounded — by `maxPorts`, which is the id table's own
 * ceiling — but it is a different statement from the single-stream one, and it
 * is the statement that decides whether a busy peer is safe.
 *
 * Measured: 1 of 5000 in the response direction; 20 of 10000 across twenty
 * simultaneous calls, which is exactly one per open port.
 */

import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

describe("the direction the shipped test does not cover", () => {
  it("throttles the HANDLER when the CALLER stops reading", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();

    const TOTAL = 5000;
    let produced = 0;

    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      async function* chatty() {
        for (let i = 0; i < TOTAL; i++) {
          produced++;
          yield new Uint8Array(64);
        }
      },
    );

    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
    });
    const out = call((async function* () {})());

    // Pull exactly one chunk, then stop.
    const it = out[Symbol.asyncIterator]();
    await it.next();

    await new Promise((r) => setTimeout(r, 200));
    const producedWhileStalled = produced;
    expect(producedWhileStalled).toBeGreaterThanOrEqual(1);
    expect(producedWhileStalled).toBeLessThanOrEqual(2);

    await it.return?.(undefined);
    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  }, 60_000);

  it("bounds each of many concurrent calls independently", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();

    const CALLS = 20;
    const PER_CALL = 500;
    let producedTotal = 0;

    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      async function* chatty() {
        for (let i = 0; i < PER_CALL; i++) {
          producedTotal++;
          yield new Uint8Array(64);
        }
      },
    );

    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
    });

    const held: Array<AsyncIterator<Uint8Array>> = [];
    for (let i = 0; i < CALLS; i++) {
      const it = call((async function* () {})())[Symbol.asyncIterator]();
      await it.next();
      held.push(it);
    }

    await new Promise((r) => setTimeout(r, 300));
    // The bound is per-port, so the total is bounded by the number of open
    // ports — NOT unbounded, and nowhere near the 10000 an unthrottled
    // implementation would reach.
    expect(producedTotal).toBeLessThanOrEqual(CALLS * 2);

    for (const it of held) await it.return?.(undefined);
    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  }, 60_000);
});
