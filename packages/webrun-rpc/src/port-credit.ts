import type { MessageTarget } from "./message-target.js";

/**
 * The send side of a port with flow control (`PortMuxOptions.window`): what
 * waits in its queue, and when it has drained.
 */
export interface PortSendState {
  /** Bytes queued on this port, waiting for the peer's credit. */
  bufferedAmount(): number;
  /** Resolves once at most `below` bytes are queued (default 0). */
  ready(below?: number): Promise<void>;
}

const states = new WeakMap<MessageTarget, PortSendState>();

/** @internal Registered by the multiplexer for each port with a window. */
export function setPortSendState(port: MessageTarget, state: PortSendState): void {
  states.set(port, state);
}

/**
 * Bytes queued on `port` because its window is spent (0 for a port without
 * flow control). A sender that should not queue without bound waits for
 * `whenPortReady` before posting more.
 */
export function portBufferedAmount(port: MessageTarget): number {
  return states.get(port)?.bufferedAmount() ?? 0;
}

/**
 * Resolves once at most `below` bytes are queued on `port` (at once for a
 * port without flow control).
 */
export function whenPortReady(port: MessageTarget, below = 0): Promise<void> {
  return states.get(port)?.ready(below) ?? Promise.resolve();
}
