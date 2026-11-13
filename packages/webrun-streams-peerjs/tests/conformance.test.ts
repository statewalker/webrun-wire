import { describe, it } from "vitest";

// PeerJS uses WebRTC. `@roamhq/wrtc` is enough for primitives but the full
// peerjs handshake hangs under Node — run only in browser mode. Same gate as
// the legacy webrun-port-peerjs package.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

// Top-level await, not `void import(...).then(...)`. Vitest collects a file by
// running it once and recording the `describe`/`it` calls made during that run;
// anything registered from a later microtask arrives after collection and is
// silently dropped, so the file fails with "No test suite found".
if (isBrowser) {
  const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
  const { makePeerJsPortPair } = await import("./make-peerjs-port-pair.js");
  describeDuplexAdapter("webrun-streams-peerjs over multiplexPort", makePeerJsPortPair);
} else {
  describe.skip("webrun-streams-peerjs (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
