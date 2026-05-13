import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { makeWebRtcPair } from "./make-webrtc-pair.js";

describePortAdapter("webrun-port-webrtc", makeWebRtcPair);
