import type { MessageTarget } from "./message-target.js";

/**
 * What a multiplexer exchanges over the underlying port.
 *
 * `open`, `message` and `close`, plus `credit` (a port's window) and `frame`
 * (a piece of a large message, with `frameSize`). There is no DATA/ACK split
 * and no error type: `close` carries an opaque `reason` that layer 1 never
 * inspects, because stream semantics belong above this layer.
 */
export type PortEnvelope =
  | { type: "open"; id: number; meta?: unknown; window?: number; exact?: boolean }
  | { type: "message"; id: number; payload: unknown }
  | { type: "close"; id: number; reason?: unknown }
  /** Per-port flow control (`window`): the receiver has consumed `bytes` more. */
  | { type: "credit"; id: number; bytes: number; exact?: boolean }
  /** Fair framing (`frameSize`): one piece of an encoded `message` envelope. */
  | { type: "frame"; id: number; data: Uint8Array; last?: boolean };

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
  /**
   * Optional, for codecs whose wire form is bytes, with `decode`: the bytes
   * `post` would place on the port. A port with a window then counts real
   * bytes instead of an estimate, posts them as they are (encoding once), and
   * can split them into frames (`frameSize`).
   */
  encode?(envelope: PortEnvelope): Uint8Array;
  /** Optional, with `encode`: an envelope back from its bytes, or `undefined`. */
  decode?(data: unknown): PortEnvelope | undefined;
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
  /**
   * The transport's life. When it aborts, the mux closes with
   * `signal.reason`: every port's close signal aborts and the calls in flight
   * on them reject at once. Wire it to whatever reports the pipe's death — a
   * worker's `exit`, a libp2p stream's `close`, a liveness lock — because a
   * pipe that dies silently otherwise leaves every port open, forever.
   */
  signal?: AbortSignal;
  /**
   * Per-port flow control, in bytes (off when unset). A port this mux opens
   * asks for it in its `open`; the peer's mux then applies it to that port in
   * both directions. Each side may have at most `window` bytes of a port's
   * messages delivered but not yet consumed by the other side; what exceeds
   * it waits in the port's send queue (`portBufferedAmount`,
   * `whenPortReady`). A message counts as consumed once every listener has
   * returned, or, for a listener that returns a promise, once it settles: a
   * slow consumer holds its own port's budget, and no other port's.
   *
   * A message's size is its byte length (`ArrayBuffer`, typed arrays), a
   * string's length, or for an object the sizes of its values (4 levels deep,
   * at most 256 values), and at least 64 — or, when both ends' codecs
   * implement `encode` / `decode`, the encoded bytes. A message larger than
   * the window is sent when nothing else is outstanding.
   *
   * Safe against an older peer: neither end holds back until the other has
   * shown it reads credit (the responder's zero-byte ack, then the opener's
   * answer to it), so a peer that never sends credit runs unwindowed.
   */
  window?: number;
  /**
   * Fair framing, in bytes (off when unset). Every port's messages leave in
   * turn, one item per port, whenever the pipe has room (its `whenDrained`),
   * and a message whose encoding is larger than `frameSize` goes as frames of
   * that size, reassembled by the peer. A small message then waits for one
   * frame of another port's large message, not for all of it. It needs
   * `window`, a codec with `encode` / `decode`, and a peer that says it reads
   * frames (in its `open` or its acknowledgement); otherwise messages go
   * whole. 16-64 KiB is a reasonable range.
   */
  frameSize?: number;
  /**
   * Leak detection, for development (off when unset). A port its consumer
   * dropped without `close()` is reported here once the garbage collector
   * reclaims it. If it has no listener left it is freed on both ends, as a
   * close would free it; one that still has a listener is still receiving, so
   * it is reported and left open. A listener that closes over its own port
   * keeps it reachable from the mux, so such a port is never collected, and
   * never reported. Each port costs a `FinalizationRegistry` entry, and when
   * the collector runs is up to the runtime.
   */
  onLeak?: (info: PortInfo) => void;
}

/** What `PortMux.ports()` reports for one open port. */
export interface PortInfo {
  id: number;
  meta?: unknown;
  /** `Date.now()` when the port was opened. */
  openedAt: number;
  /** `Date.now()` of the last message in either direction. */
  lastActivity: number;
  /**
   * The window in force, once the peer acknowledged it. Absent on a port that
   * asked for one from a peer that never answers credit (an older version).
   */
  window?: number;
  /** With a window: bytes waiting in this port's send queue. */
  queued?: number;
  /** With a window: bytes sent and not yet granted back by the peer. */
  outstanding?: number;
  /**
   * With a window: bytes delivered to this side's listeners and not yet
   * consumed. A value that stays up names a listener whose promise never
   * settles, which holds the port's window spent.
   */
  unconsumed?: number;
}

export interface OpenPortOptions {
  /** Closes the port when it aborts, so the port lives no longer than its user. */
  signal?: AbortSignal;
}

/** One port in, many ports out. */
export interface PortMux {
  /** Allocate a port, announce it, and return the local end. */
  openPort(meta?: unknown, options?: OpenPortOptions): Promise<MessageTarget>;
  /**
   * Close every port, then release the underlying port. With
   * `multiplexPort`, `reason` becomes the reason of every port's close signal
   * (`getPortCloseSignal`); `transferPortMux`'s real ports have none.
   */
  close(reason?: unknown): Promise<void>;
  /** The ports open now, to find who holds a full table. */
  ports?(): PortInfo[];
  /** See {@link PortMuxOptions.maxMessageSize}. */
  readonly maxMessageSize?: number;
}
