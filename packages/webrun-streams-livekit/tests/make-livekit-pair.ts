import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { Room, RoomEvent } from "livekit-client";
import { inject } from "vitest";
import { connect, serve } from "../src/connect-serve.js";

/**
 * Two LiveKit participants in one room, talking to each other over data
 * packets.
 *
 * The server and the two access tokens come from `livekit-server-setup.ts`
 * (Vitest global setup, Node side) and arrive through `inject`.
 *
 * Unlike the WebRTC adapter, this one is built on `emulateMux`, so it forwards
 * the suite's tuning and L6 exercises the real credit path rather than
 * degrading to an integrity check.
 */

const PEER_TIMEOUT_MS = 20_000;

/**
 * Both rooms must see each other before any call: the adapter addresses the
 * remote by identity, and a data packet sent to a participant LiveKit has not
 * announced yet is dropped rather than queued.
 */
function waitForPeer(room: Room, identity: string): Promise<void> {
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

export const makeLiveKitPair: MakePair = async (tuning) => {
  const url = inject("livekitUrl");
  const callerRoom = new Room();
  const responderRoom = new Room();

  try {
    await callerRoom.connect(url, inject("livekitTokenCaller"));
    await responderRoom.connect(url, inject("livekitTokenResponder"));
    await Promise.all([waitForPeer(callerRoom, "responder"), waitForPeer(responderRoom, "caller")]);
  } catch (err) {
    await Promise.allSettled([callerRoom.disconnect(), responderRoom.disconnect()]);
    throw err;
  }

  return {
    async connect() {
      return connect({ room: callerRoom, peerIdentity: "responder", mux: tuning });
    },
    async serve(handler) {
      return serve({ room: responderRoom, peerIdentity: "caller", mux: tuning }, handler);
    },
    async close() {
      await Promise.allSettled([callerRoom.disconnect(), responderRoom.disconnect()]);
    },
  };
};
