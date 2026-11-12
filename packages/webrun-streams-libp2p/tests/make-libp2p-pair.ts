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

/**
 * Declares no `runAheadBytes`: L6 measured this transport with no bound. A
 * consumer that stops reading let the producer get 22-24 MiB ahead within half
 * a second, in either direction, until libp2p's 4 MiB read buffer aborted the
 * stream (the call then fails with `PeerGoneError`). Pausing the stream while
 * the consumer holds a chunk, and capping yamux's window, did not bound it, so
 * the buffering is elsewhere in the stack. Until it is found, L6 checks only
 * that a stalled transfer below that point completes once the consumer resumes.
 * The port stack over libp2p (`tests/port-mux.test.ts`) is bounded at one chunk.
 */
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
