import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import { connect, serve } from "../src/index.js";

const makePortPair: MakePair = async (mux) => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return {
    connect: () => connect({ port: channel.port1, side: "initiator", mux }),
    serve: (handler) => serve({ port: channel.port2, side: "responder", mux }, handler),
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

describeDuplexAdapter("webrun-rpc (MessageChannel pair)", makePortPair);
