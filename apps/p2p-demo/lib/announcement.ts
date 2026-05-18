/**
 * Wire shape for the group's **service catalog** topic
 * (`webrun/<groupId>/services`). Each message carries the publisher's full
 * current catalog plus a timestamp; receivers replace the peer's entry on
 * each message rather than merging.
 *
 * Peer presence + multiaddrs are owned by `@libp2p/pubsub-peer-discovery`
 * on a sibling `webrun/<groupId>/peer-discovery` topic, so multiaddrs do
 * not appear in this message. Consumers look them up via
 * `node.peerStore.get(peerId)` at mount time.
 *
 * The `leave: true` flag marks a graceful-shutdown variant. Receivers that
 * see it evict the peer immediately instead of waiting for TTL expiry. The
 * flag is the only difference; everything else is a normal announcement
 * with the peer's last known catalog, which makes diagnostics easier.
 */
export interface HttpService {
  id: string;
  kind: "http";
  title: string;
  path?: string;
}

/**
 * Identifies a peer as the always-on group-mesh anchor (Level-2 "permanent
 * node"). Today the relay's libp2p instance publishes this so browsers can
 * see "there is always at least one peer in our group, and it's the relay
 * machine". Carries no mountable content — it's a presence-only marker.
 */
export interface PresenceHubService {
  id: string;
  kind: "presence-hub";
  title: string;
}

export type Service = HttpService | PresenceHubService;

export interface ServiceAnnouncement {
  v: 1;
  peerId: string;
  services: Service[];
  ts: number;
  leave?: true;
}

export interface PeerEntry {
  services: Service[];
  lastSeen: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function encodeAnnouncement(a: ServiceAnnouncement): Uint8Array {
  return ENCODER.encode(JSON.stringify(a));
}

export function decodeAnnouncement(bytes: Uint8Array): ServiceAnnouncement | undefined {
  try {
    const obj: unknown = JSON.parse(DECODER.decode(bytes));
    return isServiceAnnouncement(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
}

function isServiceAnnouncement(x: unknown): x is ServiceAnnouncement {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (typeof o.peerId !== "string") return false;
  if (typeof o.ts !== "number") return false;
  if (!Array.isArray(o.services)) return false;
  return true;
}
