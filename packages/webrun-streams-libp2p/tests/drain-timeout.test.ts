import type { Stream } from "@libp2p/interface";
import { mockMuxer, multiaddrConnectionPair } from "@libp2p/utils";
import { describe, expect, it, vi } from "vitest";
import { duplexOverStream } from "../src/duplex-over-stream.js";

// A peer that asks for something and then stops accepting data — alive, so no
// `close` and no reset ever arrives — used to park the outbound pump forever:
// `waitForDrain` waited on a `'drain'` event that will never come. On the
// serving side there is no escape from that, because `connect`'s
// `.return`/abort override is a *caller*-side affordance. The stream, the
// handler and everything the handler had buffered were held indefinitely, and
// nothing anywhere logged that it had happened.
//
// Simulated with `@libp2p/utils`'s in-memory mocks rather than a real node: a
// paused `MultiaddrConnection` is exactly "this peer's transport has stopped
// accepting bytes", and it produces the one event pattern a real stalled peer
// produces — namely none at all. (Two real libp2p nodes cannot reproduce it in
// one process: the receiving side's transport keeps reading eagerly into its
// own buffer, so the sender never sees backpressure at all.)
//
// Verified to fail before the fix: with the unbounded `waitForDrain`, the
// handler is never released and vitest kills the test with
// "Test timed out in 10000ms."
describe("duplexOverStream drain timeout", () => {
  it("drops a peer that stops accepting data without closing, and says so", async () => {
    const [outboundConn, inboundConn] = multiaddrConnectionPair({ capacity: 2, delay: 5 });
    const localMuxer = mockMuxer().createStreamMuxer(outboundConn);
    const remoteMuxer = mockMuxer().createStreamMuxer(inboundConn);
    const remoteStream = new Promise<Stream>((resolve) => {
      remoteMuxer.addEventListener("stream", (evt) => resolve(evt.detail), { once: true });
    });
    const local = await localMuxer.createStream({ protocol: "/drain-timeout/1.0.0" });
    await remoteStream;

    // The peer goes quiet: no more bytes accepted, and no close or reset to
    // tell this side about it.
    inboundConn.pause();
    await new Promise((r) => setTimeout(r, 50));

    // Stands in for a serving handler: it must be released, not left parked
    // yielding into a stream nobody drains.
    let handlerReleased = false;
    async function* handler(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < 100_000; i++) {
          yield new Uint8Array(1024).fill(i % 256);
        }
      } finally {
        handlerReleased = true;
      }
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    try {
      for await (const _chunk of duplexOverStream(local, handler(), { drainTimeoutMs: 250 })) {
        // The stalled peer sends nothing back; what the read side reports as
        // it unwinds is not under test.
      }
    } catch {
      // ditto
    }
    const elapsed = Date.now() - started;
    const warned = warn.mock.calls.map((args) => String(args[0])).join("\n");
    warn.mockRestore();

    expect(handlerReleased).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    // Loud, not silent: an operator can tell a dropped stalled peer from a
    // crash, and the message names the bound that was applied.
    expect(warned).toContain("waitForDrain");
    expect(warned).toContain("250ms");

    await Promise.allSettled([localMuxer.close(), remoteMuxer.close()]);
  }, 10_000);
});
