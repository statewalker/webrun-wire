import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeLegacyPair, makeLibp2pPair } from "./make-libp2p-pair.js";

// Two real libp2p nodes over loopback TCP, in process: part of the normal Node run.
// `connect`/`serve`: one port of the windowed native port mux per call (#153).
describeDuplexAdapter("webrun-streams-libp2p", makeLibp2pPair, { skipHugeBody: true });
// The deprecated protocol, kept as a shim on both ends for one release.
describeDuplexAdapter("webrun-streams-libp2p, deprecated protocol", makeLegacyPair, {
  skipHugeBody: true,
});
