import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { describe, it } from "vitest";
import { makePeerJsPair } from "./make-peerjs-pair.js";

// PeerJS uses WebRTC under the hood. The @roamhq/wrtc polyfill is enough for
// individual primitives but not for the full peerjs handshake sequence under
// Node — the data channel handshake hangs indefinitely. Run conformance only
// in browser mode (vitest --browser=chromium), where native WebRTC works.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

if (isBrowser) {
  describePortAdapter("webrun-port-peerjs", makePeerJsPair);
} else {
  describe.skip("webrun-port-peerjs (browser-only)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
