import { createServer } from "node:http";
import type { MakePair } from "@statewalker/webrun-port-conformance";
import { ExpressPeerServer } from "peer";
import { createPeerJsPortAsync } from "../src/index.js";

/**
 * Boot an in-process PeerJS broker + two PeerJS clients against it.
 *
 * PeerJS uses browser WebRTC APIs internally; Node tests therefore need
 * `RTCPeerConnection` and friends as globals. This module attempts to load
 * `@roamhq/wrtc` and install its exports on `globalThis` when running under
 * Node. In browser mode the natives are already present.
 */

async function ensureWebRtcGlobals(): Promise<void> {
  const g = globalThis as typeof globalThis & {
    RTCPeerConnection?: typeof RTCPeerConnection;
    RTCSessionDescription?: typeof RTCSessionDescription;
    RTCIceCandidate?: typeof RTCIceCandidate;
  };
  if (typeof g.RTCPeerConnection === "function") return;
  try {
    const mod = (await import("@roamhq/wrtc")) as {
      RTCPeerConnection?: typeof RTCPeerConnection;
      RTCSessionDescription?: typeof RTCSessionDescription;
      RTCIceCandidate?: typeof RTCIceCandidate;
      default?: {
        RTCPeerConnection: typeof RTCPeerConnection;
        RTCSessionDescription: typeof RTCSessionDescription;
        RTCIceCandidate: typeof RTCIceCandidate;
      };
    };
    const wrtc = mod.default ?? mod;
    g.RTCPeerConnection = (wrtc.RTCPeerConnection ??
      (mod as unknown as { RTCPeerConnection: typeof RTCPeerConnection })
        .RTCPeerConnection) as typeof RTCPeerConnection;
    g.RTCSessionDescription = (wrtc.RTCSessionDescription ??
      (mod as unknown as { RTCSessionDescription: typeof RTCSessionDescription })
        .RTCSessionDescription) as typeof RTCSessionDescription;
    g.RTCIceCandidate = (wrtc.RTCIceCandidate ??
      (mod as unknown as { RTCIceCandidate: typeof RTCIceCandidate })
        .RTCIceCandidate) as typeof RTCIceCandidate;
  } catch (err) {
    throw new Error(
      `webrun-port-peerjs Node tests need @roamhq/wrtc or a browser; got ${(err as Error).message}`,
    );
  }
}

export const makePeerJsPair: MakePair = async () => {
  await ensureWebRtcGlobals();

  const httpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("PeerServer has no address");
  const port = address.port;

  const peerServer = ExpressPeerServer(httpServer, { path: "/", allow_discovery: false });
  // Mount the express middleware on '/'.
  httpServer.on("request", (req, res) => {
    (peerServer as unknown as (req: unknown, res: unknown) => void)(req, res);
  });

  // peerjs is browser-only by default but works under wrtc polyfill.
  const { Peer } = (await import("peerjs")) as unknown as typeof import("peerjs");

  const aliceId = `alice-${Math.random().toString(36).slice(2, 8)}`;
  const bobId = `bob-${Math.random().toString(36).slice(2, 8)}`;
  const peerOpts = { host: "127.0.0.1", port, path: "/", secure: false } as const;
  const alice = new Peer(aliceId, peerOpts);
  const bob = new Peer(bobId, peerOpts);

  await Promise.all([
    new Promise<void>((resolve) => alice.on("open", () => resolve())),
    new Promise<void>((resolve) => bob.on("open", () => resolve())),
  ]);

  const incoming = new Promise<import("peerjs").DataConnection>((resolve) => {
    bob.on("connection", (conn) => resolve(conn));
  });
  const aliceConn = alice.connect(bobId, { serialization: "raw" });
  const bobConn = await incoming;

  const [a, b] = await Promise.all([
    createPeerJsPortAsync(aliceConn),
    createPeerJsPortAsync(bobConn),
  ]);

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
        alice.destroy();
      } catch {}
      try {
        bob.destroy();
      } catch {}
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
};
