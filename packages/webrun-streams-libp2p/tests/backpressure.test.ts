import { streamPair } from "@libp2p/utils";
import { describe, expect, it } from "vitest";
import { duplexOverStream } from "../src/duplex-over-stream.js";

// Regression test for a libp2p 3.x flow-control bug: `Stream.onDrain()`
// (`@libp2p/utils@7.3.2/dist/src/abstract-message-stream.js`) memoises a
// single promise for the stream's whole lifetime and never clears it, so
// awaiting it past the first backpressure cycle resolves instantly even
// while the write buffer is still full. A write loop built on `onDrain()`
// therefore floods `stream.writeBuffer` without bound on any transfer that
// hits more than one backpressure cycle — this test forces several cycles
// and checks the buffer stays small instead of accumulating the whole
// unsent remainder.
//
// Verified to fail before the fix: reinstating `await stream.onDrain()` in
// place of the event-based wait makes this fail with a peak around 37 KiB
// for the same 40 x 1 KiB run (vs. 0 B with the fix) — consistent with the
// review's own measurement (36 864 B) of the same bug.
//
// Uses `@libp2p/utils`'s in-memory `streamPair`, not a real libp2p node, so
// unlike tests/conformance.test.ts it needs no network setup and is not
// gated behind WEBRUN_STREAMS_LIBP2P.
describe("duplexOverStream backpressure", () => {
  it("keeps stream.writeBufferLength bounded across multiple backpressure cycles", async () => {
    // capacity: 2 makes the mock transport signal "buffer full" after just
    // 2 in-flight chunks, so a 40-chunk transfer forces many backpressure
    // cycles instead of at most one.
    const [local, remote] = await streamPair({ capacity: 2, delay: 15 });
    // Remote never sends anything back; close its write side up front so
    // `local`'s own read loop (driven internally by duplexOverStream) ends
    // promptly via `remoteCloseWrite` instead of blocking forever on a
    // reply that will never arrive — only the write/outbound side is under
    // test here.
    await remote.close();

    const chunkSize = 1024;
    const chunkCount = 40;
    async function* bigInput(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < chunkCount; i++) {
        yield new Uint8Array(chunkSize).fill(i % 256);
      }
    }

    let peakWriteBufferLength = 0;
    const sampler = setInterval(() => {
      peakWriteBufferLength = Math.max(peakWriteBufferLength, local.writeBufferLength);
    }, 1);

    try {
      // Content isn't under test; only how much unsent data piles up in
      // `local.writeBuffer` while the transfer runs.
      for await (const _chunk of duplexOverStream(local, bigInput())) {
        // ignore received bytes
      }
    } finally {
      clearInterval(sampler);
    }

    expect(local.writeStatus).toBe("closed");
    // Buggy `onDrain()` reuse let ~36 KiB of a 40 KiB transfer pile up
    // unsent in the same scenario. A bound of three chunks' worth is
    // generous headroom for legitimate in-flight bytes while still
    // catching the regression by more than an order of magnitude.
    expect(peakWriteBufferLength).toBeLessThan(chunkSize * 3);
  });
});
