import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { connect, serve } from "../src/index.js";

const makePortPair: MakePair = async () => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return {
    connect: () => connect({ port: channel.port1, side: "initiator" }),
    serve: (handler) => serve({ port: channel.port2, side: "responder" }, handler),
    close: async () => {
      try {
        channel.port1.close();
      } catch {
        /* ignore */
      }
      try {
        channel.port2.close();
      } catch {
        /* ignore */
      }
    },
  };
};

describeDuplexAdapter("webrun-streams-port (MessageChannel pair)", makePortPair);
