/**
 * Peer discovery + connection manager over a {@link SignalingTransport}.
 *
 * Wraps the low-level {@link PeerConnection} (relocated from
 * `@statewalker/vcs-port-webrtc`) with a multi-peer, id-keyed surface: dial a
 * peer with `connect(peerId)` or accept inbound dials via `onConnection`. Each
 * established connection yields a {@link ByteChannel}. The WebRTC
 * offer/answer/ICE routing is the original logic; only the routing-by-peer-id
 * and the ByteChannel result are new.
 */

import { PeerConnection } from "./peer-connection.js";
import type {
  ByteChannel,
  SignalingMessage,
  SignalingTransport,
  WebRtcConnectionOptions,
} from "./types.js";

export type PeerManagerOptions = WebRtcConnectionOptions & {
  /**
   * Called when a connection fails with no caller to tell: a signal it
   * rejects (an offer during glare, malformed SDP or candidates), or an
   * inbound connection whose channel never opens. The connection has already
   * been closed and forgotten, so the peer can dial again. Errors are dropped
   * when unset. A failed `connect()` rejects instead.
   */
  onError?: (error: Error, peerId: string) => void;
};

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
    // Dialing again replaces whatever connection to this peer there was.
    const previous = this.connections.get(peerId);
    if (previous) this.forget(peerId, previous);
    const pc = this.makeConnection(peerId, "initiator");
    const channel = pc.open();
    try {
      await pc.connect();
      return await channel;
    } catch (err) {
      channel.catch(() => undefined);
      this.forget(peerId, pc);
      throw err;
    }
  }

  /** Register a handler for inbound connections. Returns an unsubscribe fn. */
  onConnection(handler: (peerId: string, ch: ByteChannel) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** Tear down all connections and stop listening for signaling. */
  close(): void {
    this.unsubscribe();
    const all = [...this.connections.values()];
    this.connections.clear();
    for (const pc of all) pc.close();
    this.connectionHandlers.clear();
  }

  private makeConnection(peerId: string, role: "initiator" | "responder"): PeerConnection {
    const pc = new PeerConnection(role, this.options);
    pc.on("signal", (msg) => this.signaling.send(peerId, msg));
    pc.on("close", () => this.forget(peerId, pc));
    // A failed connection never recovers: forget it so the peer's next offer
    // starts a new one instead of reaching this one.
    pc.on("stateChange", (state) => {
      if (state === "failed" || state === "closed") this.forget(peerId, pc);
    });
    this.connections.set(peerId, pc);
    return pc;
  }

  /** Close `pc` and drop it, unless a newer connection to `peerId` replaced it. */
  private forget(peerId: string, pc: PeerConnection): void {
    if (this.connections.get(peerId) !== pc) return;
    this.connections.delete(peerId);
    pc.close();
  }

  private fail(peerId: string, pc: PeerConnection, err: unknown): void {
    const live = this.connections.get(peerId) === pc;
    this.forget(peerId, pc);
    if (!live) return; // closed on purpose meanwhile
    const error = err instanceof Error ? err : new Error(String(err), { cause: err });
    try {
      this.options.onError?.(error, peerId);
    } catch {}
  }

  private onSignal(from: string, msg: SignalingMessage): void {
    let pc = this.connections.get(from);
    // A connection makes one offer, so a new offer from a peer we answered
    // before, or whose answer we already applied, means it started over: the
    // old connection is stale. (An offer to an initiator still waiting for
    // its answer is glare: handleSignal rejects it below.)
    if (pc && msg.type === "offer" && (pc.getRole() === "responder" || pc.hasRemoteDescription())) {
      this.forget(from, pc);
      pc = undefined;
    }
    if (!pc) {
      // Only an inbound offer starts a new responder connection; stray
      // candidates/answers for an unknown peer are ignored.
      if (msg.type !== "offer") return;
      const responder = this.makeConnection(from, "responder");
      pc = responder;
      responder.open().then(
        (channel) => {
          for (const handler of this.connectionHandlers) handler(from, channel);
        },
        (err: unknown) => this.fail(from, responder, err),
      );
    }
    const target = pc;
    target.handleSignal(msg).catch((err: unknown) => this.fail(from, target, err));
  }
}
