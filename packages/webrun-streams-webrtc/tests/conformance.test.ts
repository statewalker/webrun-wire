import { describe, it } from "vitest";

// WebRTC conformance needs a real RTCPeerConnection pair. Node can use
// @roamhq/wrtc; browser uses native APIs. Same gate as the legacy package.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  void import("./make-webrtc-pair.js").then(async ({ makeWebRtcPair }) => {
    const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
    describeDuplexAdapter("webrun-streams-webrtc", makeWebRtcPair);
  });
} else {
  describe.skip("webrun-streams-webrtc (browser-only conformance)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
