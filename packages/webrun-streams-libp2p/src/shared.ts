import type { PeerId } from "@libp2p/interface";
import type { Duplex } from "@statewalker/webrun-streams";

/**
 * The protocol id `connect`/`serve` are configured with unless told otherwise.
 * Their calls negotiate `portProtocolOf(protocol)` (with `/window`); the id
 * itself is the deprecated protocol, still served and dialled as a fallback
 * for one release (statewalker/webrun-wire#153).
 */
export const DEFAULT_PROTOCOL = "/webrun-streams/1.0.0";

/** What the serving side knows about the connection a call arrived on. */
export interface ConnectionContext {
  /**
   * The peer id libp2p's Noise handshake proved for this connection. This is
   * the only identity claim on the serving side that cannot be forged by the
   * request payload.
   */
  remotePeer: PeerId;
}

/**
 * Builds a handler for one inbound call. Called once per call (one port, or one
 * stream of the deprecated protocol), so the connection stays reachable in the
 * returned Duplex's closure — `Duplex` is bytes-only (ADR-0004) and gains no
 * new parameter.
 */
export type ServeConnectionsHandler = (context: ConnectionContext) => Duplex;
