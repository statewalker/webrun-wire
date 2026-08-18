import type { Libp2p, PeerId } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import {
  decodeAnnouncement,
  encodeAnnouncement,
  type ServiceAnnouncement,
} from "./announcement.js";
import { applyAnnouncement, applyLeave, evictStale, type GroupState } from "./group-state.js";

export const DISCOVERY_PROTOCOL = "/p2p-demo/discovery/1.0.0";

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_SWEEP_MS = 1_000;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Length-prefixed frames so one stream carries N records. */
function frame(payloads: Uint8Array[]): Uint8Array {
  const total = payloads.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const p of payloads) {
    view.setUint32(off, p.length);
    out.set(p, off + 4);
    off += 4 + p.length;
  }
  return out;
}

function unframe(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let off = 0;
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off);
    off += 4;
    if (off + len > bytes.length) break;
    out.push(bytes.subarray(off, off + len));
    off += len;
  }
  return out;
}

async function collect(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of input) {
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Relay side. Holds one `GroupState` per group id and answers each announce
 * with that group's current catalogue (every other peer's last-known
 * services in the *same* group). `ServiceAnnouncement` itself carries no
 * `groupId` — that field lives only in the discovery envelope, one level
 * above the announcement, the same way `joinGroup` scopes it at the pubsub
 * topic layer rather than inside the message. The request envelope is
 * exactly two length-prefixed records: the UTF-8 group id, then the
 * `ServiceAnnouncement`; anything else is rejected rather than guessed at.
 * The announcing peer's identity comes from the Noise-proven
 * `context.remotePeer`, never from the payload.
 */
export async function serveDiscovery(
  node: Libp2p,
  opts: { ttlMs?: number; sweepMs?: number } = {},
): Promise<() => Promise<void>> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
  const groups = new Map<string, GroupState>();

  const sweep = setInterval(() => {
    for (const state of groups.values()) evictStale(state, Date.now(), ttlMs);
  }, sweepMs);

  const stop = await serveConnections(
    { node, protocol: DISCOVERY_PROTOCOL },
    (context) =>
      async function* handle(input) {
        const records = unframe(await collect(input));
        if (records.length !== 2) return; // malformed envelope — reject, don't guess.
        const [groupIdBytes, announcementBytes] = records;
        if (groupIdBytes == null || announcementBytes == null) return;
        const groupId = DECODER.decode(groupIdBytes);
        const incoming = decodeAnnouncement(announcementBytes);
        if (incoming == null) return;

        // Trust the proven peer id, not the payload's claim.
        const proven = context.remotePeer.toString();
        const announcement: ServiceAnnouncement = { ...incoming, peerId: proven };

        let state = groups.get(groupId);
        if (state == null) {
          state = new Map();
          groups.set(groupId, state);
        }
        if (announcement.leave === true) applyLeave(state, proven);
        else applyAnnouncement(state, announcement, Date.now());
        evictStale(state, Date.now(), ttlMs);

        const catalogue: Uint8Array[] = [];
        for (const [peerId, entry] of state) {
          if (peerId === proven) continue;
          catalogue.push(
            encodeAnnouncement({
              v: 1,
              peerId,
              services: entry.services,
              ts: entry.lastSeen,
            }),
          );
        }
        yield frame(catalogue);
      },
  );

  return async () => {
    clearInterval(sweep);
    await stop();
  };
}

/** Peer side. One `announce` == one stream == one round trip, scoped to one group. */
export function discoveryClient(node: Libp2p, relay: PeerId | Multiaddr, groupId: string) {
  const groupIdBytes = ENCODER.encode(groupId);
  return {
    async announce(a: ServiceAnnouncement): Promise<ServiceAnnouncement[]> {
      const { call, close } = await connect({
        node,
        peer: relay,
        protocol: DISCOVERY_PROTOCOL,
      });
      try {
        const reply = await collect(
          call(
            (async function* () {
              yield frame([groupIdBytes, encodeAnnouncement(a)]);
            })(),
          ),
        );
        return unframe(reply)
          .map((b) => decodeAnnouncement(b))
          .filter((x): x is ServiceAnnouncement => x != null);
      } finally {
        await close();
      }
    },
  };
}
