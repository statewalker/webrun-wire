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

/** A capability two ends agree on for one windowed port, in its `open` and the ack. */
export type PortCap = "pipeline";

/**
 * What two ends have agreed for one windowed port so far. `caps`: what both
 * speak, and so what the peer may send; empty until the handshake settles it
 * (the opener learns it from the ack, the responder from the `open`).
 * `enforced`: the window holds this end's own sends — what this end needs
 * before it relies on the window instead of a confirmation per message.
 */
export interface PortAgreement {
  window: number;
  caps: ReadonlySet<PortCap>;
  enforced: boolean;
}

const agreements = new WeakMap<MessageTarget, () => PortAgreement | undefined>();

/** @internal Registered by the multiplexer for each port with a window. */
export function setPortAgreement(port: MessageTarget, agreement: () => PortAgreement | undefined) {
  agreements.set(port, agreement);
}

/**
 * @internal What has been agreed with the peer on `port` so far; `undefined`
 * on a port without a window. Not exported from the package.
 */
export function portAgreement(port: MessageTarget): PortAgreement | undefined {
  return agreements.get(port)?.();
}
