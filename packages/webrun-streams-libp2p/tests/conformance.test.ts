import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeLibp2pPair } from "./make-libp2p-pair.js";

// Two real libp2p nodes over loopback TCP, in process: part of the normal Node run.
describeDuplexAdapter("webrun-streams-libp2p", makeLibp2pPair, { skipHugeBody: true });
