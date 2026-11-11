import { describe, expect, it } from "vitest";

// Backpressure over a real RTCPeerConnection pair: browser only, like the conformance suite.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

const MiB = 1024 * 1024;

/** `count` bytes in 64 KiB chunks; `pulled` says how many the transport has taken so far */
function source(count: number) {
  const state = { pulled: 0 };
  async function* gen() {
    const chunk = new Uint8Array(64 * 1024);
    for (let sent = 0; sent < count; sent += chunk.byteLength) {
      chunk[0] = (sent / chunk.byteLength) & 0xff;
      state.pulled += chunk.byteLength;
      yield chunk.slice();
    }
  }
  return { state, input: gen() };
}

/** a handler that counts what it receives and answers with the count (8 bytes) */
function counting(pauseAfterFirstMs = 0) {
  return async function* (input: AsyncIterable<Uint8Array>) {
    let n = 0;
    let first = true;
    for await (const c of input) {
      n += c.byteLength;
      if (first && pauseAfterFirstMs) await new Promise((r) => setTimeout(r, pauseAfterFirstMs));
      first = false;
    }
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, n);
    yield out;
  };
}
async function answer(gen: AsyncIterable<Uint8Array>): Promise<number> {
  const parts: Uint8Array[] = [];
  for await (const c of gen) parts.push(c);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new DataView(all.buffer).getFloat64(0);
}

if (isBrowser) {
  const { makeWebRtcPair } = await import("./make-webrtc-pair.js");
  const { HIGH_WATER_MARK, RECEIVE_WINDOW } = await import("../src/duplex-over-data-channel.js");

  describe("webrun-streams-webrtc — backpressure", () => {
    it("100 MiB: the send buffer never grows past the high-water mark", async () => {
      // what the DataChannel holds unsent at each send
      const proto = RTCDataChannel.prototype as unknown as { send: (d: unknown) => void };
      const send = proto.send;
      let maxBuffered = 0;
      proto.send = function (this: RTCDataChannel, d: unknown) {
        maxBuffered = Math.max(maxBuffered, this.bufferedAmount);
        return send.call(this, d);
      };
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(counting());
        const { call } = await pair.connect();
        const { input } = source(100 * MiB);
        expect(await answer(call(input))).toBe(100 * MiB);
        expect(maxBuffered).toBeLessThanOrEqual(HIGH_WATER_MARK + 64 * 1024);
      } finally {
        proto.send = send;
        await pair.close();
      }
    }, 120_000);

    it("a slow reader stalls the sender: no more than the receive window is taken ahead", async () => {
      const pair = await makeWebRtcPair();
      try {
        await pair.serve(counting(1500));
        const { call } = await pair.connect();
        const { state, input } = source(32 * MiB);
        const result = answer(call(input));
        await new Promise((r) => setTimeout(r, 1000)); // the reader is still asleep
        // the receiver's window, the sender's buffer, and a chunk in each pipeline stage
        expect(state.pulled).toBeLessThanOrEqual(RECEIVE_WINDOW + HIGH_WATER_MARK + 4 * 64 * 1024);
        expect(await result).toBe(32 * MiB);
      } finally {
        await pair.close();
      }
    }, 120_000);
  });
} else {
  describe.skip("webrun-streams-webrtc backpressure (browser only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
