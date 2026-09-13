import { describe, expect, it } from "vitest";
import { connect, serve } from "../src/index.js";

/**
 * The property `connect`/`serve` exist to have: **memory is bounded by
 * construction, not by a configured ceiling.**
 *
 * This is the test that fails on an unbounded implementation, and it is the
 * only one in the package that does. The conformance suite's L6 cannot do it —
 * it asserts completion and integrity, which a transport that swallows the
 * whole body into a queue passes just as happily. So the measurement here is
 * deliberately not "did it all arrive" but "how far did the producer get while
 * the consumer was not reading".
 *
 * Measured against the previous `emulateMux` implementation of these same two
 * functions, with the same 5000-chunk producer and the same stalled handler,
 * the producer ran to 5000 of 5000 — every chunk pushed into a consumer that
 * had read one. Its 8 MiB `maxStreamBuffer` is a ceiling, and 5000 x 64 bytes
 * is well under it, so nothing stalled at all. That is the number these
 * assertions are calibrated to refuse.
 */
describe("connect/serve — a fast producer over a stalled consumer", () => {
  it("throttles the producer to one chunk ahead instead of buffering", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();

    const TOTAL = 5000;
    const CHUNK_SIZE = 64;

    let produced = 0;
    let consumed = 0;

    let sawFirst: () => void = () => {};
    const firstChunkRead = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Reads one chunk, then stops reading until the test says otherwise. The
    // `await` sits *inside* the loop body on purpose: the receiving generator
    // resolves a chunk's delivery only when the consumer pulls past it, so
    // parking here is exactly "the consumer has taken one value and no more".
    const teardown = await serve(
      { port: channel.port2, side: "responder" },
      async function* stalledHandler(input) {
        for await (const _chunk of input) {
          consumed++;
          if (consumed === 1) {
            sawFirst();
            await gate;
          }
        }
        // One empty chunk and nothing before it. The direction under test is
        // caller → handler, so the response is kept out of the measurement —
        // but a handler that yields literally nothing is a `Duplex` whose
        // output half never opens, and that is a different shape to reason
        // about than one that simply has no data.
        yield new Uint8Array(0);
      },
    );

    const { call, close } = await connect({ port: channel.port1, side: "initiator" });

    const input = async function* () {
      for (let i = 0; i < TOTAL; i++) {
        produced++;
        yield new Uint8Array(CHUNK_SIZE);
      }
    };

    const out = call(input());
    const drained = (async () => {
      for await (const _ of out) {
        /* the handler yields nothing; this just runs the stream to its end */
      }
    })();

    await firstChunkRead;
    // Give an unbounded implementation every chance to run away. 200 ms is
    // ~4 orders of magnitude more than one in-process chunk round-trip costs,
    // so a producer still sitting at 1 here is stalled, not merely slow.
    await new Promise((r) => setTimeout(r, 200));
    const producedWhileStalled = produced;

    // Non-vacuous in both directions: something must have flowed (or the test
    // would pass on a transport that delivers nothing) and it must not have
    // been everything.
    expect(consumed).toBe(1);
    expect(producedWhileStalled).toBeGreaterThanOrEqual(1);
    // One chunk in the consumer's hand, at most one more in flight awaiting its
    // confirmation. The bound is the design's, not a tuning parameter's.
    expect(producedWhileStalled).toBeLessThanOrEqual(2);

    release();
    await drained;

    // And throttling is not loss: once the consumer resumes, the whole body
    // still arrives.
    expect(produced).toBe(TOTAL);
    expect(consumed).toBe(TOTAL);

    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });
});
