import { describe, it } from "vitest";

// LiveKit conformance requires (a) browser environment for livekit-client and
// (b) a running LiveKit server reachable via env vars. Mirror the gate used by
// the legacy webrun-port-livekit package; this stays skipped in Node CI.
const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";
const hasLiveKitEnv =
  typeof process !== "undefined" &&
  Boolean(
    process.env?.WEBRUN_STREAMS_LIVEKIT_URL &&
      process.env?.WEBRUN_STREAMS_LIVEKIT_TOKEN_ALICE &&
      process.env?.WEBRUN_STREAMS_LIVEKIT_TOKEN_BOB,
  );

if (isBrowser && hasLiveKitEnv) {
  // Dynamic import keeps Node CI from pulling browser-only modules.
  void import("./make-livekit-pair.js").then(async ({ makeLiveKitPair }) => {
    const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
    describeDuplexAdapter("webrun-streams-livekit", makeLiveKitPair);
  });
} else {
  describe.skip("webrun-streams-livekit (browser + LiveKit server required)", () => {
    it("skipped — run via pnpm test:browser with WEBRUN_STREAMS_LIVEKIT_* env vars set", () => {});
  });
}
