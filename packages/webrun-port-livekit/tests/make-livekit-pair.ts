import type { MakePair } from "@statewalker/webrun-port-conformance";
import { Room, RoomEvent } from "livekit-client";
import { createLiveKitPort } from "../src/index.js";

/**
 * Connect two LiveKit `Room`s (alice and bob) to the same room on the
 * dev-server container started by global-setup.ts, and return their
 * cross-targeted ports. Browser-mode only — livekit-client is browser-native.
 */
export const makeLiveKitPair: MakePair = async () => {
  const url = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.WEBRUN_PORT_LIVEKIT_URL;
  const aliceToken = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.WEBRUN_PORT_LIVEKIT_TOKEN_ALICE;
  const bobToken = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.WEBRUN_PORT_LIVEKIT_TOKEN_BOB;
  if (!url || !aliceToken || !bobToken) {
    throw new Error(
      "webrun-port-livekit tests require WEBRUN_PORT_LIVEKIT_URL, WEBRUN_PORT_LIVEKIT_TOKEN_ALICE, WEBRUN_PORT_LIVEKIT_TOKEN_BOB env vars (set by tests/global-setup.ts when Docker is available)",
    );
  }

  const alice = new Room();
  const bob = new Room();

  await alice.connect(url, aliceToken);
  await bob.connect(url, bobToken);

  // Wait until each side sees the other as a remote participant.
  await Promise.all([waitForRemote(alice, "bob"), waitForRemote(bob, "alice")]);

  const a = createLiveKitPort(alice, "bob");
  const b = createLiveKitPort(bob, "alice");

  return {
    a,
    b,
    async close() {
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
      try {
        await alice.disconnect();
      } catch {}
      try {
        await bob.disconnect();
      } catch {}
    },
  };
};

function waitForRemote(room: Room, identity: string): Promise<void> {
  const already = Array.from(room.remoteParticipants.values()).some((p) => p.identity === identity);
  if (already) return Promise.resolve();
  return new Promise((resolve) => {
    const handler = (participant: { identity: string }) => {
      if (participant.identity === identity) {
        room.off(RoomEvent.ParticipantConnected, handler);
        resolve();
      }
    };
    room.on(RoomEvent.ParticipantConnected, handler);
  });
}
