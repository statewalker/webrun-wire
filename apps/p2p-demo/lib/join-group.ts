import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { discoveryClient } from "./discovery.js";
import { type PeerEntry, type Service, type ServiceAnnouncement } from "./announcement.js";
import { applyAnnouncement, evictStale, type GroupState } from "./group-state.js";

export interface GroupHandle {
  /** Synchronous current view of the group. Same object every read. */
  readonly state: ReadonlyMap<string, PeerEntry>;
  /** Subscribe to coalesced state-change notifications. Returns unsubscribe. */
  on(event: "change", listener: (state: ReadonlyMap<string, PeerEntry>) => void): () => void;
  /** Add or replace a service in the local catalog; publishes immediately. */
  announceService(svc: Service): void;
  /** Remove a service from the local catalog; publishes immediately. */
  removeService(serviceId: string): void;
  /** Best-effort `leave` broadcast + teardown. Safe to call once. */
  leave(): Promise<void>;
}

export interface JoinGroupParams {
  node: Libp2p;
  groupId: string;
  relay: Multiaddr;
}

/** Re-broadcast interval. */
const ANNOUNCE_INTERVAL_MS = 5_000;
/** Eviction window. Peers not heard within this window are dropped. */
const TTL_MS = 15_000;
/** How often we scan for stale entries. */
const EVICT_SWEEP_MS = 1_000;

export async function joinGroup({ node, groupId, relay }: JoinGroupParams): Promise<GroupHandle> {
  const selfPeerId = node.peerId.toString();
  const state: GroupState = new Map();
  const services: Service[] = [];
  const listeners = new Set<(s: ReadonlyMap<string, PeerEntry>) => void>();

  const client = discoveryClient(node, relay, groupId);

  // Coalesce burst-y mutations into a single microtask-scheduled emit so a
  // batch of applyAnnouncements (e.g., an announce round trip returning
  // many peers) produces one render, not N.
  let emitScheduled = false;
  const emitChange = (): void => {
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(() => {
      emitScheduled = false;
      for (const l of listeners) {
        try {
          l(state);
        } catch (err) {
          console.error("[joinGroup] change listener threw:", err);
        }
      }
    });
  };

  const buildAnnouncement = (extra?: Partial<ServiceAnnouncement>): ServiceAnnouncement => ({
    v: 1,
    peerId: selfPeerId,
    services: [...services],
    ts: Date.now(),
    ...extra,
  });

  const applyReplies = (replies: ServiceAnnouncement[]): void => {
    let changed = false;
    for (const ann of replies) {
      if (ann.peerId === selfPeerId) continue;
      applyAnnouncement(state, ann, Date.now());
      changed = true;
    }
    if (changed) emitChange();
  };

  // Background connection pre-warming. Discovery only tells us who is in
  // the group; it doesn't itself open anything. Without this, the first
  // fetch to a newly discovered peer pays the full cold
  // WS→relay→circuit-reservation→WebRTC-upgrade path on click. This
  // restores the auto-dial warming libp2p's connection manager used to do
  // for free — we dial the same `/p2p-circuit/webrtc/p2p/<peerId>` form
  // `getOrOpenHandle` uses, just proactively and in the background.
  // Best-effort only: a peer that's briefly unreachable must not disturb
  // discovery, so failures are swallowed and never surfaced or rethrown.
  const warming = new Set<string>();
  const preWarmPeers = (): void => {
    for (const peerId of state.keys()) {
      if (peerId === selfPeerId || warming.has(peerId)) continue;
      let pid;
      try {
        pid = peerIdFromString(peerId);
      } catch {
        continue; // malformed peer id — nothing to dial.
      }
      if (node.getConnections(pid).some((c) => c.status === "open")) continue;
      warming.add(peerId);
      const target = multiaddr(`${relay.toString()}/p2p-circuit/webrtc/p2p/${peerId}`);
      void node
        .dial(target)
        .catch(() => {
          /* best-effort pre-warm; the click-time dial in getOrOpenHandle retries */
        })
        .finally(() => {
          warming.delete(peerId);
        });
    }
  };

  const announceCurrent = async (extra?: Partial<ServiceAnnouncement>): Promise<void> => {
    try {
      const replies = await client.announce(buildAnnouncement(extra));
      console.log(
        `[joinGroup] announce OK group=${groupId} services=${services.length} peers=${replies.length}`,
      );
      applyReplies(replies);
      // No point pre-warming connections on the way out.
      if (extra?.leave !== true) preWarmPeers();
    } catch (err) {
      console.warn(`[joinGroup] announce FAIL group=${groupId} err=${(err as Error).message}`);
    }
  };

  console.log(`[joinGroup] joining group=${groupId} self=${selfPeerId.slice(0, 12)}`);

  void announceCurrent();

  const tickTimer = setInterval(() => {
    void announceCurrent();
  }, ANNOUNCE_INTERVAL_MS);

  const sweepTimer = setInterval(() => {
    const evicted = evictStale(state, Date.now(), TTL_MS);
    if (evicted.length > 0) emitChange();
  }, EVICT_SWEEP_MS);

  // Best-effort leave on tab close. Fire-and-forget — `beforeunload` runs
  // synchronously and the network send may not complete, but TTL catches
  // up within `TTL_MS` regardless.
  const onBeforeUnload = (): void => {
    void announceCurrent({ leave: true });
  };
  const hasWindow = typeof window !== "undefined";
  if (hasWindow) window.addEventListener("beforeunload", onBeforeUnload);

  let left = false;

  return {
    get state(): ReadonlyMap<string, PeerEntry> {
      return state;
    },

    on(_event, listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    announceService(svc) {
      const i = services.findIndex((s) => s.id === svc.id);
      if (i >= 0) services[i] = svc;
      else services.push(svc);
      void announceCurrent();
    },

    removeService(serviceId) {
      const i = services.findIndex((s) => s.id === serviceId);
      if (i < 0) return;
      services.splice(i, 1);
      void announceCurrent();
    },

    async leave() {
      if (left) return;
      left = true;
      clearInterval(tickTimer);
      clearInterval(sweepTimer);
      if (hasWindow) window.removeEventListener("beforeunload", onBeforeUnload);
      await announceCurrent({ leave: true });
    },
  };
}
