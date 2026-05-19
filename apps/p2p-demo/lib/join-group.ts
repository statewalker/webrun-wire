import type { Libp2p } from "libp2p";
import {
  decodeAnnouncement,
  encodeAnnouncement,
  type PeerEntry,
  type Service,
  type ServiceAnnouncement,
} from "./announcement.js";
import { applyAnnouncement, applyLeave, evictStale, type GroupState } from "./group-state.js";
import { servicesTopic } from "./group-topics.js";

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
}

/** Re-broadcast interval. */
const ANNOUNCE_INTERVAL_MS = 5_000;
/** Eviction window. Peers not heard within this window are dropped. */
const TTL_MS = 15_000;
/** How often we scan for stale entries. */
const EVICT_SWEEP_MS = 1_000;

interface PubSubLike {
  subscribe(topic: string): void;
  unsubscribe(topic: string): unknown;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  getSubscribers(topic: string): Array<unknown>;
  getTopics(): string[];
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

interface MessageEvent {
  detail: {
    topic: string;
    data: Uint8Array;
    from?: { toString(): string };
  };
}

export async function joinGroup({ node, groupId }: JoinGroupParams): Promise<GroupHandle> {
  const topic = servicesTopic(groupId);
  const selfPeerId = node.peerId.toString();
  const state: GroupState = new Map();
  const services: Service[] = [];
  const listeners = new Set<(s: ReadonlyMap<string, PeerEntry>) => void>();

  const pubsub = (node.services as { pubsub: PubSubLike }).pubsub;

  // Coalesce burst-y mutations into a single microtask-scheduled emit so a
  // batch of applyAnnouncements (e.g., during gossipsub heartbeat) produces
  // one render, not N.
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

  const publishCurrent = async (): Promise<void> => {
    try {
      const subs = pubsub.getSubscribers(topic).length;
      await pubsub.publish(topic, encodeAnnouncement(buildAnnouncement()));
      console.log(
        `[joinGroup] publish OK topic=${topic} subscribers=${subs} services=${services.length}`,
      );
    } catch (err) {
      // First publish before the gossipsub mesh has formed via the relay
      // may throw "no peers in topic" / "NoPeersSubscribedToTopic". The
      // periodic tick (or on-new-peer trigger) catches up; not fatal.
      console.warn(`[joinGroup] publish FAIL topic=${topic} err=${(err as Error).message}`);
    }
  };

  const handleMessage = (e: MessageEvent): void => {
    if (e.detail.topic !== topic) return;
    const ann = decodeAnnouncement(e.detail.data);
    if (!ann) {
      console.warn(`[joinGroup] recv: malformed announcement on ${topic}`);
      return;
    }
    const from = ann.peerId.slice(0, 12);
    if (ann.peerId === selfPeerId) {
      console.debug(`[joinGroup] recv self echo from ${from} — ignoring`);
      return;
    }

    if (ann.leave === true) {
      console.log(`[joinGroup] recv LEAVE from ${from}`);
      if (applyLeave(state, ann.peerId)) emitChange();
      return;
    }

    const result = applyAnnouncement(state, ann, Date.now());
    console.log(
      `[joinGroup] recv announce from ${from} services=${ann.services.length} kind=${ann.services[0]?.kind ?? "—"} ${result}`,
    );
    emitChange();
    // On-new-peer trigger: immediately broadcast our state so the newly
    // discovered peer doesn't wait a full tick to learn about us.
    if (result === "added") void publishCurrent();
  };

  console.log(`[joinGroup] subscribing topic=${topic} self=${selfPeerId.slice(0, 12)}`);
  pubsub.subscribe(topic);
  pubsub.addEventListener("message", handleMessage);
  console.log(`[joinGroup] subscribed; current topics: ${pubsub.getTopics().join(", ")}`);

  void publishCurrent();

  const tickTimer = setInterval(() => {
    void publishCurrent();
  }, ANNOUNCE_INTERVAL_MS);

  const sweepTimer = setInterval(() => {
    const evicted = evictStale(state, Date.now(), TTL_MS);
    if (evicted.length > 0) emitChange();
  }, EVICT_SWEEP_MS);

  // Best-effort leave on tab close. Fire-and-forget — `beforeunload` runs
  // synchronously and the network send may not complete, but TTL catches
  // up within `TTL_MS` regardless.
  const onBeforeUnload = (): void => {
    try {
      void pubsub.publish(topic, encodeAnnouncement(buildAnnouncement({ leave: true })));
    } catch {
      /* best-effort */
    }
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
      void publishCurrent();
    },

    removeService(serviceId) {
      const i = services.findIndex((s) => s.id === serviceId);
      if (i < 0) return;
      services.splice(i, 1);
      void publishCurrent();
    },

    async leave() {
      if (left) return;
      left = true;
      clearInterval(tickTimer);
      clearInterval(sweepTimer);
      if (hasWindow) window.removeEventListener("beforeunload", onBeforeUnload);
      try {
        await pubsub.publish(topic, encodeAnnouncement(buildAnnouncement({ leave: true })));
      } catch {
        /* best-effort */
      }
      pubsub.removeEventListener("message", handleMessage);
      try {
        pubsub.unsubscribe(topic);
      } catch {
        /* best-effort */
      }
    },
  };
}
