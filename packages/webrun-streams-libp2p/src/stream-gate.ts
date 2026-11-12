import type { Connection, DialProtocolOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";

/** The early-stream guard of `connect()`, per local node and remote peer. */
interface StreamGate {
  /**
   * A stream has negotiated a protocol on an open connection: the remote is ready.
   * `connection` is that connection when the node can tell (`getConnections`), so a
   * burst after it closes is gated again; a node that offers only `dialProtocol`
   * stays proven.
   */
  proven: { connection: Connection | null } | null;
  /** The stream being opened while no connection is proven; the others wait for it. */
  firstOpening: Promise<Stream> | null;
}

const streamGates = new WeakMap<Libp2p, Map<string, StreamGate>>();

function streamGateFor(node: Libp2p, peer: PeerId | Multiaddr): StreamGate {
  let gates = streamGates.get(node);
  if (gates == null) {
    gates = new Map();
    streamGates.set(node, gates);
  }
  const key = peer.toString();
  let gate = gates.get(key);
  if (gate == null) {
    gate = { proven: null, firstOpening: null };
    gates.set(key, gate);
  }
  return gate;
}

function isProven(gate: StreamGate): boolean {
  if (gate.proven == null) return false;
  return gate.proven.connection == null || gate.proven.connection.status === "open";
}

/**
 * The connection carrying `stream`, when `node` can list its connections.
 * Callers may pass a narrow stand-in that offers only `dialProtocol` (httpeers
 * routes streams onto a kept relay circuit that way), so nothing else is required.
 */
function connectionOf(node: Libp2p, stream: Stream): Connection | null {
  if (typeof node.getConnections !== "function") return null;
  return node.getConnections().find((connection) => connection.streams.includes(stream)) ?? null;
}

/**
 * Opens a stream to `peer` for `proto`, one at a time until the remote has proven ready: a burst
 * of streams on a connection the remote is still upgrading makes yamux abort the whole muxer
 * (`maxEarlyStreams`). Shared by `connect()` and `libp2pPortMux`, and by every caller dialling
 * the same peer from the same node, since they share its connection.
 */
export async function openGatedStream(
  node: Libp2p,
  peer: PeerId | Multiaddr,
  proto: string,
  dialOptions?: DialProtocolOptions,
): Promise<Stream> {
  const gate = streamGateFor(node, peer);
  while (!isProven(gate)) {
    if (gate.firstOpening == null) {
      const opening = node.dialProtocol(peer, [proto], dialOptions);
      gate.firstOpening = opening;
      try {
        const stream = await opening;
        gate.proven = { connection: connectionOf(node, stream) };
        return stream;
      } finally {
        gate.firstOpening = null;
      }
    }
    await gate.firstOpening.catch(() => undefined);
  }
  return node.dialProtocol(peer, [proto], dialOptions);
}
