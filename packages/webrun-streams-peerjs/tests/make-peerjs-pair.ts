import type { MakePair } from "@statewalker/webrun-streams-conformance";
import type { DataConnection } from "peerjs";
import { Peer } from "peerjs";
import { inject } from "vitest";
import { connect, serve } from "../src/connect-serve.js";

/**
 * Two PeerJS peers against a loopback broker, talking to each other.
 *
 * The broker is started by `peer-server-setup.ts` (Vitest global setup, Node
 * side) and its port arrives here through `inject`. Using a local broker
 * rather than the PeerJS cloud keeps the suite offline and removes a
 * third-party dependency from every run.
 *
 * `serialization: "raw"` is required: this adapter puts its own `emulateMux`
 * framing on the connection, so PeerJS must not also apply BinaryPack.
 */

/** Peer registration and the WebRTC handshake both go through the broker. */
const OPEN_TIMEOUT_MS = 15_000;

function waitPeerOpen(peer: Peer, label: string): Promise<void> {
  if (peer.open) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`webrun-streams-peerjs: ${label} peer did not open in ${OPEN_TIMEOUT_MS}ms`),
      );
    }, OPEN_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`webrun-streams-peerjs: ${label} peer errored: ${err.message}`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      peer.off("open", onOpen);
      peer.off("error", onError);
    }
    peer.on("open", onOpen);
    peer.on("error", onError);
  });
}

function waitConnOpen(conn: DataConnection): Promise<void> {
  if (conn.open) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`webrun-streams-peerjs: DataConnection stalled in ${OPEN_TIMEOUT_MS}ms`));
    }, OPEN_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`webrun-streams-peerjs: DataConnection errored: ${err.message}`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      conn.off("open", onOpen);
      conn.off("error", onError);
    }
    conn.on("open", onOpen);
    conn.on("error", onError);
  });
}

export const makePeerJsPair: MakePair = async (tuning) => {
  const port = inject("peerServerPort");
  // Peer ids are global to the broker and the suite builds a fresh pair per
  // test, so they have to be unique per pair or the second registration is
  // rejected as taken.
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const responderId = `webrun-responder-${suffix}`;
  const options = { host: "127.0.0.1", port, path: "/webrun", secure: false, debug: 0 };

  const responderPeer = new Peer(responderId, options);
  const callerPeer = new Peer(`webrun-caller-${suffix}`, options);

  try {
    await Promise.all([
      waitPeerOpen(responderPeer, "responder"),
      waitPeerOpen(callerPeer, "caller"),
    ]);
  } catch (err) {
    responderPeer.destroy();
    callerPeer.destroy();
    throw err;
  }

  return {
    async connect() {
      // Opened here rather than in the factory: the suite registers `serve`
      // first, and the responder only starts listening for inbound
      // connections at that point.
      const conn = callerPeer.connect(responderId, { serialization: "raw", reliable: true });
      await waitConnOpen(conn);
      return connect({ conn, mux: tuning });
    },
    async serve(handler) {
      return serve({ peer: responderPeer, mux: tuning }, handler);
    },
    async close() {
      callerPeer.destroy();
      responderPeer.destroy();
    },
  };
};
