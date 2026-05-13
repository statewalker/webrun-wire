import { bindBytesToPort } from "@statewalker/webrun-port-core";
import type { DataPacket_Kind, RemoteParticipant, Room } from "livekit-client";

/**
 * LiveKit's data channel reliability mode. Default LOSSY in livekit-client is
 * UDP-like; for the bridged-port contract we need ordered + reliable, so we
 * always send RELIABLE.
 */
const RELIABLE: DataPacket_Kind = 1 as DataPacket_Kind;

/**
 * LiveKit caps a single data publish at ~15 KiB. The adaptive chunker handles
 * larger payloads transparently.
 */
const DEFAULT_LIVEKIT_MTU = 12 * 1024;

export interface CreateLiveKitPortOptions {
  /** Override the per-frame byte budget. Default ~12 KiB. */
  mtu?: number;
}

// Cache: one port per (Room, identity) pair so repeated calls don't add
// duplicate listeners to the same Room.
const participantPorts = new WeakMap<Room, Map<string, MessagePort>>();

/**
 * Wrap a connected LiveKit `Room` plus a remote participant identity into a
 * real `MessagePort` whose peer is that specific participant. Outbound payloads
 * are addressed only to the named participant; inbound data is filtered by
 * sender identity.
 *
 * Multiple ports per `Room` (one per remote participant of interest) are
 * supported via internal caching keyed on `(Room, participantIdentity)`.
 */
export function createLiveKitPort(
  room: Room,
  participantIdentity: string,
  options: CreateLiveKitPortOptions = {},
): MessagePort {
  let cache = participantPorts.get(room);
  if (!cache) {
    cache = new Map();
    participantPorts.set(room, cache);
  }
  const existing = cache.get(participantIdentity);
  if (existing) return existing;

  let chunkHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
    if (!participant) return;
    if (participant.identity !== participantIdentity) return;
    const h = chunkHandler;
    if (h) h(new Uint8Array(payload));
  };

  const onDisconnected = () => {
    const h = closeHandler;
    if (h) h();
  };

  const onParticipantDisconnected = (participant: RemoteParticipant) => {
    if (participant.identity !== participantIdentity) return;
    const h = closeHandler;
    if (h) h();
  };

  // livekit-client surfaces these via the Room's typed event emitter.
  (
    room as unknown as {
      on(ev: string, fn: (...args: unknown[]) => void): void;
      off(ev: string, fn: (...args: unknown[]) => void): void;
    }
  ).on("dataReceived", onData as (...args: unknown[]) => void);
  (
    room as unknown as {
      on(ev: string, fn: (...args: unknown[]) => void): void;
    }
  ).on("disconnected", onDisconnected);
  (
    room as unknown as {
      on(ev: string, fn: (...args: unknown[]) => void): void;
    }
  ).on("participantDisconnected", onParticipantDisconnected as (...args: unknown[]) => void);

  const port = bindBytesToPort({
    postChunk(bytes) {
      void (
        room.localParticipant as unknown as {
          publishData: (
            data: Uint8Array,
            kind: DataPacket_Kind,
            opts?: { destinationIdentities?: string[] },
          ) => Promise<void>;
        }
      )
        .publishData(bytes, RELIABLE, { destinationIdentities: [participantIdentity] })
        .catch(() => {
          /* publish failed — close will be detected via disconnect events */
        });
    },
    onChunk(handler) {
      chunkHandler = handler;
      return () => {
        if (chunkHandler === handler) chunkHandler = null;
      };
    },
    onClose(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    close() {
      (
        room as unknown as {
          off(ev: string, fn: (...args: unknown[]) => void): void;
        }
      ).off("dataReceived", onData as (...args: unknown[]) => void);
      (
        room as unknown as {
          off(ev: string, fn: (...args: unknown[]) => void): void;
        }
      ).off("disconnected", onDisconnected);
      (
        room as unknown as {
          off(ev: string, fn: (...args: unknown[]) => void): void;
        }
      ).off("participantDisconnected", onParticipantDisconnected as (...args: unknown[]) => void);
      cache?.delete(participantIdentity);
    },
    mtu: options.mtu ?? DEFAULT_LIVEKIT_MTU,
  });
  cache.set(participantIdentity, port);
  return port;
}
