import type { DataConnection, Peer } from "peerjs";

/**
 * Waiting helpers for the browser pairs. The broker is started by
 * `peer-server-setup.ts` (Vitest global setup, Node side) and its port arrives
 * through `inject`, so the suite needs no PeerJS cloud and no internet access.
 */

/** Peer registration and the WebRTC handshake both go through the broker. */
const OPEN_TIMEOUT_MS = 15_000;

export function waitPeerOpen(peer: Peer, label: string): Promise<void> {
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

export function waitConnOpen(conn: DataConnection): Promise<void> {
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
