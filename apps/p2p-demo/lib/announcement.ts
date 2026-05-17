/**
 * Wire shape for the group-discovery protocol. One message type travels on
 * the per-group gossipsub topic `webrun/<groupId>/announce`. Every
 * announcement carries the publisher's full current catalog — receivers
 * replace the peer's entry on each message rather than merging.
 *
 * The `leave: true` flag marks a graceful-shutdown variant. Receivers that
 * see it evict the peer immediately instead of waiting for TTL expiry. The
 * flag is the only difference; everything else is a normal announcement
 * with the peer's last known state, which makes diagnostics easier.
 */
export interface HttpService {
  id: string;
  kind: "http";
  title: string;
  path?: string;
}

export type Service = HttpService;

export interface Announcement {
  v: 1;
  peerId: string;
  multiaddrs: string[];
  services: Service[];
  ts: number;
  leave?: true;
}

export interface PeerEntry {
  multiaddrs: string[];
  services: Service[];
  lastSeen: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function encodeAnnouncement(a: Announcement): Uint8Array {
  return ENCODER.encode(JSON.stringify(a));
}

export function decodeAnnouncement(bytes: Uint8Array): Announcement | undefined {
  try {
    const obj: unknown = JSON.parse(DECODER.decode(bytes));
    return isAnnouncement(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
}

function isAnnouncement(x: unknown): x is Announcement {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (typeof o.peerId !== "string") return false;
  if (typeof o.ts !== "number") return false;
  if (!Array.isArray(o.multiaddrs) || !o.multiaddrs.every((m) => typeof m === "string")) {
    return false;
  }
  if (!Array.isArray(o.services)) return false;
  return true;
}
