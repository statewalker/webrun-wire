import type { ValueCodec } from "@statewalker/webrun-streams";
import { describePortMux } from "@statewalker/webrun-streams-conformance";
import { libp2pPortMux } from "../src/port-mux.js";
import { createNode } from "./make-libp2p-pair.js";

// The native port lifecycle contract (statewalker/webrun-wire#152) over real
// libp2p nodes: every port is its own stream.
const PROTOCOL = "/webrun-ports/contract/1.0.0";

describePortMux("libp2pPortMux", async (codec: ValueCodec) => {
  const server = await createNode();
  const client = await createNode();
  const addr = server.getMultiaddrs()[0];
  if (!addr) throw new Error("no listen address");
  const opener = await libp2pPortMux({ node: client, codec, peer: addr, protocol: PROTOCOL });
  let serving: Awaited<ReturnType<typeof libp2pPortMux>> | undefined;
  return {
    opener,
    async serve(onPort) {
      serving = await libp2pPortMux({ node: server, codec, protocol: PROTOCOL, onPort });
      return serving;
    },
    async dispose() {
      await serving?.close();
      await Promise.allSettled([client.stop(), server.stop()]);
    },
  };
});
