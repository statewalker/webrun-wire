import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { makeWsPair } from "./make-ws-pair.js";

describeDuplexAdapter("webrun-streams-ws", makeWsPair);
