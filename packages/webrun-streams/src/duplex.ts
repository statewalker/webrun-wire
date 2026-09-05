/**
 * The transport seam every `webrun-streams-*` adapter and the conformance suite
 * are written against.
 *
 * These types live here rather than beside an implementation on purpose: the
 * emulated multiplexer that once declared them is scheduled for deletion, and a
 * seam that disappears with its first implementation is not a seam.
 */

/**
 * Canonical seam for the webrun-streams transport family. A `Duplex` carries
 * one logical call: caller emits an iterable of bytes as input, peer yields an
 * async generator of bytes as output. Same shape on both sides — an in-process
 * test can wire `const caller = handler` and run without any transport.
 *
 * Iterator semantics carry every signal:
 *  - Consumer `.return()` on the output → producer's `finally` runs.
 *  - Producer `throw` → consumer's `for await` throws.
 *  - Normal exhaustion on either side → matching end on the other side.
 */
export type Duplex = (
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
) => AsyncGenerator<Uint8Array>;

/**
 * Adapter-side factory that stands up a transport connection and yields a
 * caller `Duplex`. One `Connect` invocation owns one transport; each call
 * to the resolved `call` opens a new sub-stream on it.
 *
 * A caller must either drain the returned generator or `.return()` it.
 * Dropping the reference without doing either emits no observable signal:
 * the abandoned consumer never acknowledges inbound data, so the peer's
 * outbound pump blocks awaiting that acknowledgement, no end-of-stream is
 * ever exchanged, and both peers hold the stream's slot open. There is no
 * way for the transport to detect this — an unreferenced generator is not
 * observable — so it is the consumer's obligation.
 */
export type Connect<P> = (params: P) => Promise<{
  call: Duplex;
  close: () => Promise<void>;
}>;

/**
 * Adapter-side factory that registers a handler `Duplex` against a transport.
 * Returns an idempotent teardown.
 */
export type Serve<P> = (params: P, handler: Duplex) => Promise<() => Promise<void>>;

/**
 * Thrown by `emulateMux` and adapters when the underlying transport closes
 * while one or more `Duplex` calls are in flight. Consumers can catch by
 * `instanceof TransportClosedError` or by checking `error.name`.
 */
export class TransportClosedError extends Error {
  override readonly name = "TransportClosedError";
  constructor(message = "transport closed") {
    super(message);
  }
}
