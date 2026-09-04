import { describe, it } from "vitest";

// LiveKit conformance needs a browser (livekit-client is browser-only) and a
// running LiveKit server. The server is no longer someone else's problem:
// `livekit-server-setup.ts` starts `livekit-server --dev` on a loopback port
// and mints the tokens, the same way the PeerJS suite brings its own broker.
//
// The old gate also required WEBRUN_STREAMS_LIVEKIT_* environment variables,
// which a browser cannot read — `process.env` does not exist there — so the
// suite skipped unconditionally even when a server was available.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";

// Top-level await, not `void import(...).then(...)`. Vitest collects a file by
// running it once and recording the `describe`/`it` calls made during that run;
// anything registered from a later microtask arrives after collection and is
// silently dropped, so the file fails with "No test suite found".
if (isBrowser) {
  const { makeLiveKitPair } = await import("./make-livekit-pair.js");
  const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
  describeDuplexAdapter("webrun-streams-livekit", makeLiveKitPair);
} else {
  describe.skip("webrun-streams-livekit (browser-only conformance)", () => {
    it("skipped — run via pnpm test:browser", () => {});
  });
}
