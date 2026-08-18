/// <reference types="vite/client" />
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p, type Libp2p } from "libp2p";

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
 * Peer discovery and the group's service catalog are both handled by the
 * relay-mediated request/response discovery protocol (`lib/discovery.ts`),
 * not by any libp2p service registered here — `groupId` is kept in the
 * signature only so callers don't need to special-case this factory.
 */
export function createBrowserLibp2pNode({
  listen,
}: {
  listen: string[];
  groupId: string;
}): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // libp2p 3.x's browser-only default connection gater denies dialling
    // BOTH insecure `ws://` addresses and private/loopback addresses (see
    // `libp2p/dist/src/config/connection-gater.browser.js`). This demo's
    // relay is exactly that: `ws://127.0.0.1:<port>` in `relay/server.ts`.
    // With the default gater every dial the app makes — to the relay
    // itself, and to every `${relayMultiaddr}/p2p-circuit/webrtc/p2p/...`
    // peer address derived from it — is denied before any handshake, so
    // discovery and mounting never work at all.
    //
    // Gated on `import.meta.env.DEV` (false in a production build) rather
    // than left as a bare relaxation, so a future `apps/p2p-demo/deploy/`
    // build that reuses this factory unchanged falls back to libp2p's
    // default posture automatically instead of silently shipping with
    // its dial protections disabled — a comment alone doesn't stop that,
    // only a code guard does.
    connectionGater: import.meta.env.DEV
      ? {
          // Local development only: the demo's relay is reached at
          // /ip4/127.0.0.1/tcp/9090/ws, which libp2p 3.x's browser default
          // gater denies on two counts — insecure websocket and private
          // address. The same gater also sees the derived
          // /p2p-circuit/webrtc/ peer addresses, so both dial paths need it.
          denyDialMultiaddr: async () => false,
        }
      : // Production (see apps/p2p-demo/deploy/): wss:// on a real DNS
        // name, where libp2p's default posture is the correct one. Do not
        // relax it here.
        undefined,
    services: {
      identify: identify(),
    },
  });
}
