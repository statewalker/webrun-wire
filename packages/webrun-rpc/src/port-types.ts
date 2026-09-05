import type { MessageTarget } from "./message-target.js";

/**
 * What a multiplexer exchanges over the underlying port.
 *
 * Three types and nothing more. There is no DATA/ACK split, no credit and no
 * error type: `close` carries an opaque `reason` that layer 1 never inspects,
 * because stream semantics belong above this layer.
 */
export type PortEnvelope =
  | { type: "open"; id: number; meta?: unknown }
  | { type: "message"; id: number; payload: unknown }
  | { type: "close"; id: number; reason?: unknown };

/**
 * How an envelope reaches the wire.
 *
 * This is the only place that knows the wire format. A port whose messages are
 * structured values passes envelopes through untouched; a port whose messages
 * are bytes encodes them. A transport with different constraints adds a codec,
 * not a multiplexer.
 */
export interface PortCodec {
  /** Place one envelope on the underlying port. */
  post(port: MessageTarget, envelope: PortEnvelope, transfer?: Transferable[]): void;
  /** Recover an envelope from a message event, or `undefined` to ignore it. */
  read(event: MessageEvent): PortEnvelope | undefined;
}

export interface PortMuxOptions {
  /** How envelopes are placed on the underlying port. */
  codec: PortCodec;
  /**
   * Called when the peer opens a port. Return `false` to reject it: a `close`
   * goes back and every later message for that id is dropped. Any other return
   * value — including `undefined` — accepts.
   *
   * With no `onPort` at all, inbound ports are rejected. A port nobody holds
   * has no consumer, and accepting one would mean dropping its traffic
   * silently rather than telling the peer.
   */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined;
  /**
   * Id parity. The initiator allocates even ids, the responder odd, so both
   * ends may open concurrently with no negotiation. Defaults to `"initiator"`.
   */
  side?: "initiator" | "responder";
  /**
   * Ceiling on concurrently open virtual ports. Bounds the id table only — it
   * never inspects, counts or delays a payload.
   */
  maxPorts?: number;
  /**
   * Largest message this mux's ports can carry, if the transport imposes one.
   * Layer 1 does not enforce it; it reports it so layer 2 can chunk to fit.
   */
  maxMessageSize?: number;
}

/** One port in, many ports out. */
export interface PortMux {
  /** Allocate a port, announce it, and return the local end immediately. */
  openPort(meta?: unknown): MessageTarget;
  /** Close every virtual port, then release the underlying port. */
  close(): Promise<void>;
  /** See {@link PortMuxOptions.maxMessageSize}. */
  readonly maxMessageSize?: number;
}
