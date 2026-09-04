import { describe, it } from "vitest";

// WebRTC conformance needs a real RTCPeerConnection pair. Node can use
// @roamhq/wrtc; browser uses native APIs. Same gate as the legacy package.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

// Top-level await, not `void import(...).then(...)`. Vitest collects a file by
// running it once and recording the `describe`/`it` calls made during that
// run; anything registered from a later microtask arrives after collection has
// finished and is silently dropped — the file then fails with "No test suite
// found". The dynamic import still keeps the browser-only modules out of Node,
// because the `if` guards it.
if (isBrowser) {
  const { makeWebRtcPair } = await import("./make-webrtc-pair.js");
  const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
  describeDuplexAdapter("webrun-streams-webrtc", makeWebRtcPair);
} else {
  describe.skip("webrun-streams-webrtc (browser-only conformance)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
