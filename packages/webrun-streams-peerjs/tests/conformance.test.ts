import { describe, it } from "vitest";

// PeerJS uses WebRTC. `@roamhq/wrtc` is enough for primitives but the full
// peerjs handshake hangs under Node — run only in browser mode. Same gate as
// the legacy webrun-port-peerjs package.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  void import("./make-peerjs-pair.js").then(async ({ makePeerJsPair }) => {
    const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
    describeDuplexAdapter("webrun-streams-peerjs", makePeerJsPair);
  });
} else {
  describe.skip("webrun-streams-peerjs (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
