/**
 * In-memory LiveKit-style room bus. Multiple {@link RoomLike} instances that
 * connect to the same {@link RoomBus} see each other as participants and can
 * exchange `publishData` payloads, delivered as `dataReceived` events.
 */

import type { RoomLike, RoomParticipantLike } from "../../src/types.js";
import { ROOM_EVENT } from "../../src/types.js";

export class RoomBus {
  readonly members = new Set<MockRoom>();

  broadcastJoin(joined: MockRoom): void {
    // Matches LiveKit: only already-present members get a participantConnected
    // event. The joiner learns of existing members via `remoteParticipants`
    // (seeded in connect()), never via an event.
    for (const member of this.members) {
      if (member === joined) continue;
      member.emit(ROOM_EVENT.participantConnected, { identity: joined.identity });
    }
  }

  deliver(from: string, data: Uint8Array, destinations: string[] | undefined): void {
    for (const member of this.members) {
      if (member.identity === from) continue;
      if (destinations && !destinations.includes(member.identity)) continue;
      member.emit(ROOM_EVENT.dataReceived, data, { identity: from });
    }
  }
}

export class MockRoom implements RoomLike {
  readonly remoteParticipants = new Map<string, RoomParticipantLike>();
  readonly localParticipant = {
    publishData: (
      data: Uint8Array,
      opts?: { reliable?: boolean; destinationIdentities?: string[] },
    ): Promise<void> => {
      this.bus.deliver(this.identity, data, opts?.destinationIdentities);
      return Promise.resolve();
    },
  };

  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly identity: string,
    private readonly bus: RoomBus,
  ) {}

  connect(): Promise<void> {
    // Seed existing members as remote participants, then announce ourselves.
    for (const member of this.bus.members) {
      this.remoteParticipants.set(member.identity, { identity: member.identity });
      member.remoteParticipants.set(this.identity, { identity: this.identity });
    }
    this.bus.members.add(this);
    this.bus.broadcastJoin(this);
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.bus.members.delete(this);
    for (const member of this.bus.members) {
      member.remoteParticipants.delete(this.identity);
      member.emit(ROOM_EVENT.participantDisconnected, { identity: this.identity });
    }
    return Promise.resolve();
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb);
    return this;
  }

  off(event: string, cb: (...args: unknown[]) => void): this {
    this.handlers.get(event)?.delete(cb);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}
