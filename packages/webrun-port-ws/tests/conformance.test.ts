import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { makeWsPair } from "./make-ws-pair.js";

describePortAdapter("webrun-port-ws", makeWsPair);
