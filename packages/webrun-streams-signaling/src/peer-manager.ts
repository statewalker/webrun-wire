/**
 * Peer discovery + connection manager over a {@link SignalingTransport}.
 *
 * Wraps the low-level {@link PeerConnection} (relocated from
 * `@statewalker/vcs-port-webrtc`) with a multi-peer, id-keyed surface: dial a
 * peer with `connect(peerId)` or accept inbound dials via `onConnection`. Each
 * established connection yields a webrun-streams {@link ByteChannel}. The WebRTC
 * offer/answer/ICE routing is the original logic; only the routing-by-peer-id
 * and the ByteChannel result are new.
 */

import type { ByteChannel } from "@statewalker/webrun-streams";
import { PeerConnection } from "./peer-connection.js";
import type { SignalingMessage, SignalingTransport, WebRtcConnectionOptions } from "./types.js";

export type PeerManagerOptions = WebRtcConnectionOptions;

export class PeerManager {
  private readonly signaling: SignalingTransport;
  private readonly options: PeerManagerOptions;
  private readonly connections = new Map<string, PeerConnection>();
  private readonly connectionHandlers = new Set<(peerId: string, ch: ByteChannel) => void>();
  private readonly unsubscribe: () => void;

  constructor(signaling: SignalingTransport, options: PeerManagerOptions = {}) {
    this.signaling = signaling;
    this.options = options;
    this.unsubscribe = signaling.onMessage((from, msg) => this.onSignal(from, msg));
  }

  /** Dial `peerId` and resolve with the established channel. */
  async connect(peerId: string): Promise<ByteChannel> {
    const pc = this.makeConnection(peerId, "initiator");
    const channel = pc.open();
    await pc.connect();
    return channel;
  }

  /** Register a handler for inbound connections. Returns an unsubscribe fn. */
  onConnection(handler: (peerId: string, ch: ByteChannel) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** Tear down all connections and stop listening for signaling. */
  close(): void {
    this.unsubscribe();
    for (const pc of this.connections.values()) pc.close();
    this.connections.clear();
    this.connectionHandlers.clear();
  }

  private makeConnection(peerId: string, role: "initiator" | "responder"): PeerConnection {
    const pc = new PeerConnection(role, this.options);
    pc.on("signal", (msg) => this.signaling.send(peerId, msg));
    pc.on("close", () => this.connections.delete(peerId));
    this.connections.set(peerId, pc);
    return pc;
  }

  private onSignal(from: string, msg: SignalingMessage): void {
    let pc = this.connections.get(from);
    if (!pc) {
      // Only an inbound offer starts a new responder connection; stray
      // candidates/answers for an unknown peer are ignored.
      if (msg.type !== "offer") return;
      pc = this.makeConnection(from, "responder");
      void pc.open().then((channel) => {
        for (const handler of this.connectionHandlers) handler(from, channel);
      });
    }
    void pc.handleSignal(msg);
  }
}
