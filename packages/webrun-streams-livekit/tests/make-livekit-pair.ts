import { type Room, RoomEvent } from "livekit-client";

/**
 * Waiting helpers for the browser pair. The server and the two access tokens
 * come from `livekit-server-setup.ts` (Vitest global setup, Node side) and
 * arrive through `inject`.
 */

const PEER_TIMEOUT_MS = 20_000;

/**
 * Both rooms must see each other before any call: the adapter addresses the
 * remote by identity, and a data packet sent to a participant LiveKit has not
 * announced yet is dropped rather than queued.
 */
export function waitForPeer(room: Room, identity: string): Promise<void> {
  const alreadyHere = Array.from(room.remoteParticipants.values()).some(
    (p) => p.identity === identity,
  );
  if (alreadyHere) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`webrun-streams-livekit: "${identity}" did not appear in the room`));
    }, PEER_TIMEOUT_MS);

    const onJoin = (participant: { identity: string }): void => {
      if (participant.identity !== identity) return;
      cleanup();
      resolve();
    };

    function cleanup(): void {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, onJoin);
    }

    room.on(RoomEvent.ParticipantConnected, onJoin);
  });
}
