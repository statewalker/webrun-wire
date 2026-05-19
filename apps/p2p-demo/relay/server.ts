import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { encodeAnnouncement } from "../lib/announcement.js";

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
  getPeers(): Array<{ toString(): string }>;
  getSubscribers(topic: string): Array<{ toString(): string }>;
  subscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<{ recipients?: Array<unknown> } | unknown>;
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

/**
 * Groups whose `webrun/<g>/services` topic we've seen a subscription for.
 * The relay publishes a `presence-hub` announcement on each one every tick
 * so browsers in that group can render an always-on HUB peer in their
 * Peers-in-group view (Level-2 "permanent node" — the relay is already a
 * gossipsub participant for these topics; this adds application-level
 * visibility on top).
 */
const hubGroups = new Set<string>();

function groupIdFromServicesTopic(topic: string): string | null {
  const m = topic.match(/^webrun\/([^/]+)\/services$/);
  return m ? m[1] : null;
}

pubsub.addEventListener("subscription-change", (evt) => {
  const peer = evt.detail.peerId.toString().slice(0, 12);
  for (const sub of evt.detail.subscriptions ?? []) {
    if (typeof sub.topic !== "string" || !sub.topic.startsWith("webrun/")) continue;
    console.log(
      `relay: peer ${peer}… ${sub.subscribe ? "SUBSCRIBED to" : "UNSUBSCRIBED from"} "${sub.topic}"`,
    );
    if (!sub.subscribe) continue;
    if (!pubsub.getTopics().includes(sub.topic)) {
      pubsub.subscribe(sub.topic);
      console.log(`relay: auto-subscribed to "${sub.topic}"`);
    }
    const g = groupIdFromServicesTopic(sub.topic);
    if (g && !hubGroups.has(g)) {
      hubGroups.add(g);
      console.log(`relay: announcing as presence-hub in group "${g}"`);
    }
  }
});

const HUB_TICK_MS = 5_000;
const hubAnnouncement = (): Uint8Array =>
  encodeAnnouncement({
    v: 1,
    peerId: node.peerId.toString(),
    services: [{ id: "hub", kind: "presence-hub", title: "Hub" }],
    ts: Date.now(),
  });

setInterval(() => {
  for (const g of hubGroups) {
    const topic = `webrun/${g}/services`;
    try {
      const subs = pubsub.getSubscribers(topic).length;
      void pubsub
        .publish(topic, hubAnnouncement())
        .then((res) => {
          const recipients = (res as { recipients?: unknown[] }).recipients?.length ?? "?";
          console.log(
            `relay: published hub announce topic="${topic}" subscribers=${subs} recipients=${recipients}`,
          );
        })
        .catch((err) => {
          console.warn(`relay: publish FAIL topic="${topic}" err=${(err as Error).message}`);
        });
    } catch (err) {
      console.warn(`relay: publish THREW topic="${topic}" err=${(err as Error).message}`);
    }
  }
}, HUB_TICK_MS);

// Periodic mesh snapshot for diagnostics.
setInterval(() => {
  const lines: string[] = [];
  lines.push(`relay mesh snapshot: peers=${pubsub.getPeers().length}`);
  for (const t of pubsub.getTopics()) {
    if (!t.startsWith("webrun/")) continue;
    const subs = pubsub.getSubscribers(t).map((p) => p.toString().slice(0, 12));
    lines.push(`  ${t}: subscribers=${subs.length} [${subs.join(", ")}]`);
  }
  console.log(lines.join("\n"));
}, 15_000);

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
