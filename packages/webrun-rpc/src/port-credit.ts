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

/**
 * Runs `fn` on a later task, never a microtask: a producer looping on
 * `whenPortReady` must let the transport's own events run. `setImmediate`
 * where it exists; elsewhere a `MessageChannel`, because nested `setTimeout`s
 * are clamped to 4 ms in browsers.
 */
const setImmediateFn = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
/** @internal */
export const nextTask: (fn: () => void) => void = setImmediateFn
  ? (fn) => {
      setImmediateFn(fn);
    }
  : (() => {
      let channel: MessageChannel | undefined;
      const queue: Array<() => void> = [];
      return (fn) => {
        if (!channel) {
          channel = new MessageChannel();
          channel.port1.onmessage = () => queue.shift()?.();
        }
        queue.push(fn);
        channel.port2.postMessage(0);
      };
    })();

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
 * Resolves once at most `below` bytes are queued on `port`, always on a later
 * task (for a port without flow control, on the next one).
 */
export function whenPortReady(port: MessageTarget, below = 0): Promise<void> {
  return states.get(port)?.ready(below) ?? new Promise<void>((resolve) => nextTask(resolve));
}

/** @internal PROTOTYPE: a windowed port's half-close (capability `"end"`). */
export interface PortEndState {
  /** End this direction: resolves `true` once the `end` is posted, `false` if not agreed. */
  end(): Promise<boolean>;
  /** Resolves when the peer has ended its direction. */
  ended: Promise<void>;
}
const ends = new WeakMap<MessageTarget, PortEndState>();
/** @internal */
export function setPortEndState(port: MessageTarget, state: PortEndState): void {
  ends.set(port, state);
}
/**
 * PROTOTYPE: end this side's direction of `port`. Behind everything already
 * posted on it. `false` when the peer did not agree on `end` (the caller then
 * closes the port as today). Nothing posted afterwards is sent.
 */
export function endPort(port: MessageTarget): Promise<boolean> {
  return ends.get(port)?.end() ?? Promise.resolve(false);
}
/** PROTOTYPE: resolves once the peer has ended its direction of `port` (never, if it cannot). */
export function whenPortEnded(port: MessageTarget): Promise<void> {
  return ends.get(port)?.ended ?? new Promise<void>(() => {});
}
