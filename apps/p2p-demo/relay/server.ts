import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";

const PORT = Number(process.env.RELAY_PORT ?? 9090);
const LISTEN_ADDR = `/ip4/0.0.0.0/tcp/${PORT}/ws`;

const node = await createLibp2p({
  addresses: { listen: [LISTEN_ADDR] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    relay: circuitRelayServer(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
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

// Gossipsub only forwards messages between peers that are BOTH subscribed
// to the topic. For the relay to bridge announcements between two browsers
// that share a group, the relay must subscribe to the group's topic too.
// We do this dynamically: every time a connected peer advertises a
// subscription to a `webrun/*` topic, the relay auto-subscribes so it
// joins that topic's mesh. The relay still has no per-group config and
// runs no app-level handler — it just forwards.
interface PubSubLike {
  getTopics(): string[];
  subscribe(topic: string): void;
  addEventListener(
    type: "subscription-change",
    listener: (e: {
      detail: {
        peerId: { toString(): string };
        subscriptions: { topic: string; subscribe: boolean }[];
      };
    }) => void,
  ): void;
}
const pubsub = node.services.pubsub as unknown as PubSubLike;
pubsub.addEventListener("subscription-change", (evt) => {
  for (const sub of evt.detail.subscriptions ?? []) {
    if (!sub.subscribe) continue;
    if (typeof sub.topic !== "string" || !sub.topic.startsWith("webrun/")) continue;
    if (pubsub.getTopics().includes(sub.topic)) continue;
    pubsub.subscribe(sub.topic);
    console.log(
      `relay: auto-subscribed to "${sub.topic}" (seen via ${evt.detail.peerId.toString().slice(0, 12)}…)`,
    );
  }
});

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
