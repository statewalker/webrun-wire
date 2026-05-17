import type { Announcement, PeerEntry } from "./announcement.js";

/**
 * Receiver-side state machine for the group-discovery protocol. Pure: no
 * timers, no I/O. All wall-clock injection happens through the `now`
 * argument so behavior is reproducible from tests or replays.
 */
export type GroupState = Map<string, PeerEntry>;

export type ApplyResult = "added" | "updated";

export function applyAnnouncement(state: GroupState, ann: Announcement, now: number): ApplyResult {
  const existed = state.has(ann.peerId);
  state.set(ann.peerId, {
    multiaddrs: ann.multiaddrs,
    services: ann.services,
    lastSeen: now,
  });
  return existed ? "updated" : "added";
}

export function applyLeave(state: GroupState, peerId: string): boolean {
  return state.delete(peerId);
}

/**
 * Remove entries whose `lastSeen` is older than `ttlMs`. Returns the list
 * of evicted peerIds so callers can decide whether to emit a change event.
 */
export function evictStale(state: GroupState, now: number, ttlMs: number): string[] {
  const evicted: string[] = [];
  for (const [peerId, entry] of state) {
    if (now - entry.lastSeen > ttlMs) {
      state.delete(peerId);
      evicted.push(peerId);
    }
  }
  return evicted;
}
