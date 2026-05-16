import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { createLibp2p } from "libp2p";
import { connect, serve } from "../src/connect-serve.js";

async function createNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

export const makeLibp2pPair: MakePair = async () => {
  const serverNode = await createNode();
  const clientNode = await createNode();

  const serverAddr = serverNode.getMultiaddrs()[0];
  if (!serverAddr) {
    await Promise.all([serverNode.stop(), clientNode.stop()]);
    throw new Error("webrun-streams-libp2p: server node has no listen address");
  }

  return {
    async connect() {
      return connect({ node: clientNode, peer: serverAddr });
    },
    async serve(handler) {
      return serve({ node: serverNode }, handler);
    },
    async close() {
      await Promise.allSettled([serverNode.stop(), clientNode.stop()]);
    },
  };
};
