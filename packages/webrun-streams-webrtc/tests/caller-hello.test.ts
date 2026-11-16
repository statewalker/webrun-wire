import { describe, expect, it } from "vitest";

// statewalker/statewalker-root#51 (part A): Chromium can lose what a responder
// sends on an answering channel before the caller's first frame reached it,
// when the caller's `open` came before the responder's `datachannel` event.
// The conformance L4 handler, which throws at once, lost its ERROR that way
// and the caller waited for ever. The caller now sends a HELLO frame as soon
// as its channel opens, and the responder sends nothing before a frame of the
// caller's arrived (or a short fallback passed, for older callers).
// Browser-only, like the rest of this package's WebRTC tests.
const isBrowser = typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  const { connectedPeers } = await import("./make-webrtc-pair.js");
  const { connect, serve } = await import("../src/connect-serve.js");
  const { HELLO_FALLBACK_MS } = await import("../src/duplex-over-data-channel.js");

  const failing = async function* () {
    if ((0 as number) === 0) throw new Error("intentional failure");
    yield new Uint8Array(0);
  };

  /** A raw caller channel: the test decides when it sends; `first` resolves with the first frame's arrival time. */
  async function rawCaller() {
    const { clientPc, serverPc } = await connectedPeers();
    await serve({ pc: serverPc }, failing);
    const dc = clientPc.createDataChannel("webrun/raw/0");
    dc.binaryType = "arraybuffer";
    const first = new Promise<number>((resolve) =>
      dc.addEventListener("message", () => resolve(performance.now()), { once: true }),
    );
    await new Promise((r) => dc.addEventListener("open", r, { once: true }));
    return {
      dc,
      first,
      close() {
        clientPc.close();
        serverPc.close();
      },
    };
  }

  describe("webrun-streams-webrtc: the caller's hello (statewalker/statewalker-root#51)", () => {
    it("a caller's first frame on a call's channel is HELLO (0x04)", async () => {
      const { clientPc, serverPc } = await connectedPeers();
      const firstByte = new Promise<number>((resolve) =>
        serverPc.addEventListener("datachannel", (e) =>
          e.channel.addEventListener(
            "message",
            (m) => resolve(new Uint8Array(m.data as ArrayBuffer)[0] ?? -1),
            { once: true },
          ),
        ),
      );
      await serve({ pc: serverPc }, failing);
      const { call, close } = await connect({ pc: clientPc });
      await expect(async () => {
        for await (const _ of call([new Uint8Array(0)])) {
        }
      }).rejects.toThrow("intentional failure");
      expect(await firstByte).toBe(0x04);
      await close();
      clientPc.close();
      serverPc.close();
    });

    it("the responder sends nothing before the caller's first frame arrived", async () => {
      const raw = await rawCaller();
      await new Promise((r) => setTimeout(r, 100));
      const helloAt = performance.now();
      raw.dc.send(new Uint8Array([0x04]));
      const answeredAt = await raw.first;
      expect(answeredAt).toBeGreaterThanOrEqual(helloAt);
      raw.close();
    });

    it("a caller that sends nothing (an older version) is answered after the fallback", async () => {
      const raw = await rawCaller();
      const openedAt = performance.now();
      const answeredAt = await raw.first;
      // The fallback starts at the responder's `datachannel` event, around the caller's open.
      expect(answeredAt - openedAt).toBeGreaterThanOrEqual(HELLO_FALLBACK_MS - 100);
      raw.close();
    });
  });
} else {
  describe.skip("webrun-streams-webrtc caller hello (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
