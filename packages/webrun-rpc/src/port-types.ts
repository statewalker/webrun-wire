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
   * Largest **payload** a port on this mux can carry, if the transport imposes
   * a limit. Layer 1 does not enforce it; it reports it so layer 2 can chunk.
   *
   * It bounds the payload, **not the frame**. `duplexOverPort` applies
   * `toChunks(maxMessageSize)` and the envelope framing — the chunk wrapper,
   * `callPort`'s request, this mux's own envelope, then the codec — is added on
   * top afterwards. Measured over `msgpackCodec` that framing is 123-128 bytes
   * (modelled ceiling 134), and it is not constant: the call id's length varies
   * per chunk, the port id's integer width adds up to 4, and the payload's
   * length header widens at 64 KiB.
   *
   * So set this **at least 256 bytes below** the transport's real limit. Set to
   * the limit exactly, a full-size chunk overruns it — which on LiveKit
   * delivered a body as zero bytes with no error on either side.
   */
  maxMessageSize?: number;
}

/** One port in, many ports out. */
export interface PortMux {
  /** Allocate a port, announce it, and return the local end. */
  openPort(meta?: unknown): Promise<MessageTarget>;
  /** Close every virtual port, then release the underlying port. */
  close(): Promise<void>;
  /** See {@link PortMuxOptions.maxMessageSize}. */
  readonly maxMessageSize?: number;
}
