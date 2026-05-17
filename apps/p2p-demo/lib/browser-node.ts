/// <reference types="vite/client" />
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p, type Libp2p } from "libp2p";
import { peerDiscoveryTopic } from "./group-topics.js";

/**
 * Read the relay multiaddr from the Vite-injected env var. The launcher
 * (`scripts/start.sh`) boots the relay first, parses its multiaddr, and
 * passes it down as `VITE_RELAY_MULTIADDR` to both pages — so both peers
 * share the same rendezvous.
 *
 * Throws a clear error if the env var is missing so the failure surfaces
 * in the UI status log, not as a cryptic libp2p multiaddr parse error.
 */
export function readRelayMultiaddr(): string {
  const value = import.meta.env.VITE_RELAY_MULTIADDR ?? "";
  if (!value || value.includes("REPLACE_WITH_RELAY_PEER_ID")) {
    throw new Error(
      "VITE_RELAY_MULTIADDR is unset. Start via `pnpm start` in apps/p2p-demo (which boots the relay and injects the env var automatically).",
    );
  }
  return value;
}

/**
 * Identical libp2p configuration for both the server-page and client-page:
 * WebSocket to dial the relay, WebRTC for the direct browser-to-browser
 * upgrade, Circuit-Relay-v2 transport so dials can target `/p2p-circuit/...`
 * multiaddrs. The "server" variant additionally listens on `/p2p-circuit`
 * so the relay can advertise a reachable circuit address for it.
 *
 * The factory takes `groupId` because two libp2p services must be
 * registered at node-creation time and need to know the per-group topic:
 *
 * 1. `pubsub: gossipsub()` — required by `joinGroup` (services topic).
 * 2. `peerDiscovery: [pubsubPeerDiscovery({topics: [peerDiscoveryTopic]})]`
 *    — feeds libp2p's discovery pipeline so the connection manager auto-
 *    dials peers in the same group; first `[Mount]` is instant because
 *    the connection is already warm.
 */
export function createBrowserLibp2pNode({
  listen,
  groupId,
}: {
  listen: string[];
  groupId: string;
}): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      pubsubPeerDiscovery({
        topics: [peerDiscoveryTopic(groupId)],
        interval: 5_000,
      }),
    ],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  });
}
