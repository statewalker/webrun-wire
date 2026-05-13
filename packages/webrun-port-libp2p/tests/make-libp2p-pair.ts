import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import type { MakePair } from "@statewalker/webrun-port-conformance";
import { createLibp2p, type Libp2p } from "libp2p";
import { createLibp2pStreamPort, WEBRUN_PORT_LIBP2P_PROTOCOL } from "../src/index.js";

async function spawnNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

export const makeLibp2pPair: MakePair = async () => {
  const responder = await spawnNode();
  const initiator = await spawnNode();

  const incomingStream = new Promise<Stream>((resolve) => {
    void responder.handle(WEBRUN_PORT_LIBP2P_PROTOCOL, ({ stream }) => {
      resolve(stream);
    });
  });

  const dialAddrs = responder.getMultiaddrs();
  if (dialAddrs.length === 0) throw new Error("responder has no listen addresses");
  await initiator.dial(dialAddrs[0]);
  const outStream = await initiator.dialProtocol(dialAddrs[0], WEBRUN_PORT_LIBP2P_PROTOCOL);
  const inStream = await incomingStream;

  const a = createLibp2pStreamPort(outStream);
  const b = createLibp2pStreamPort(inStream);

  return {
    a,
    b,
    async close() {
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
      try {
        await initiator.stop();
      } catch {}
      try {
        await responder.stop();
      } catch {}
    },
  };
};
