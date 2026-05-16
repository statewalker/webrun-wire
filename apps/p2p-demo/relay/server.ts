import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";

const PORT = Number(process.env.RELAY_PORT ?? 9090);
const LISTEN_ADDR = `/ip4/127.0.0.1/tcp/${PORT}/ws`;

const node = await createLibp2p({
  addresses: { listen: [LISTEN_ADDR] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    relay: circuitRelayServer(),
  },
});

console.log("p2p-demo relay started.");
console.log(`peerId: ${node.peerId.toString()}`);
console.log("listening on:");
for (const ma of node.getMultiaddrs()) {
  console.log(`  ${ma.toString()}`);
}
console.log("");
console.log("(launcher will parse the multiaddr above and pass it to the browser pages)");

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\nreceived ${signal}, stopping relay...`);
  try {
    await node.stop();
  } catch (err) {
    console.error("error during stop:", err);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
