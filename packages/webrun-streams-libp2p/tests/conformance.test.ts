import { describe, it } from "vitest";

// libp2p conformance needs two real libp2p nodes communicating in process.
// The setup is non-trivial; mirror the legacy package's gate and run only
// when explicitly opted in.
const hasLibp2pEnv = typeof process !== "undefined" && process.env?.WEBRUN_STREAMS_LIBP2P === "1";

if (hasLibp2pEnv) {
  const { makeLibp2pPair } = await import("./make-libp2p-pair.js");
  const { describeDuplexAdapter } = await import("@statewalker/webrun-streams-conformance");
  describeDuplexAdapter("webrun-streams-libp2p", makeLibp2pPair, { skipHugeBody: true });
} else {
  describe.skip("webrun-streams-libp2p (opt-in conformance)", () => {
    it("skipped — set WEBRUN_STREAMS_LIBP2P=1 to enable", () => {});
  });
}
