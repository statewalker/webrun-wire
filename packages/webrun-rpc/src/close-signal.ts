/**
 * Per-port AbortSignal that fires when the underlying transport adapter
 * (libp2p stream, LiveKit participant, WebSocket, …) detects closure.
 *
 * Native `MessagePort` does NOT surface close events to either entangled
 * half — neither a `close` event, nor a `messageerror`, nor any signal at
 * all. Closing one half just silently stops message delivery on the other.
 * A WHATWG proposal exists (https://github.com/whatwg/html/issues/1766) but
 * no browser ships it.
 *
 * This module is the work-around: `bindBytesToPort` creates an
 * `AbortController` per port and aborts it when `transport.onClose` fires.
 * Consumers (`callPort`, `recieve`, `send`, application code) look up the
 * signal via `getPortCloseSignal(port)` and combine it into their own
 * abort plumbing — typically with `AbortSignal.any([userSignal, closeSignal])`
 * — so pending awaits reject cleanly instead of hanging until a per-call
 * timeout fires.
 *
 * Ports created via raw `new MessageChannel()` (i.e., without going through
 * `bindBytesToPort`) return `undefined` from `getPortCloseSignal` — there's
 * no underlying transport so there's nothing to track.
 */

const closeSignals = new WeakMap<MessagePort, AbortSignal>();

/**
 * Internal: register a port's close signal. Called once by `bindBytesToPort`.
 *
 * @internal
 */
export function setPortCloseSignal(port: MessagePort, signal: AbortSignal): void {
  closeSignals.set(port, signal);
}

/**
 * Return the AbortSignal that fires when `port`'s transport closes, or
 * `undefined` if `port` is not transport-backed (e.g., a raw
 * `MessageChannel().port1`).
 */
export function getPortCloseSignal(port: MessagePort): AbortSignal | undefined {
  return closeSignals.get(port);
}
