import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { makeLibp2pPair } from "./make-libp2p-pair.js";

describePortAdapter("webrun-port-libp2p", makeLibp2pPair);
