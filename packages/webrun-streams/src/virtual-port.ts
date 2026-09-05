import type { MessageListener, MessageTarget } from "./message-target.js";

export interface VirtualPortHandle {
  /** The consumer-facing end. Indistinguishable from a real `MessagePort`. */
  port: MessageTarget;
  /** Multiplexer-only: hand an inbound payload to the consumer's listeners. */
  deliver(payload: unknown): void;
  /** Multiplexer-only: the port is finished; drop listeners and go inert. */
  markClosed(): void;
  isClosed(): boolean;
}

/**
 * One virtual port.
 *
 * `deliver` and `markClosed` are deliberately not on `port`: the consumer holds
 * only a `MessageTarget`, so it cannot forge inbound traffic or close the port
 * out from under the multiplexer's bookkeeping.
 */
export function newVirtualPort(
  send: (payload: unknown, transfer?: Transferable[]) => void,
  requestClose: (reason?: unknown) => void,
): VirtualPortHandle {
  const listeners = new Set<MessageListener>();
  let closed = false;

  const port: MessageTarget = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    postMessage(message, transfer) {
      if (closed) return;
      send(message, transfer);
    },
    close() {
      if (closed) return;
      closed = true;
      const notify = requestClose;
      listeners.clear();
      notify();
    },
  };

  return {
    port,
    deliver(payload) {
      if (closed) return;
      const event = new MessageEvent("message", { data: payload });
      // Copy first: a listener may add or remove listeners while running.
      for (const listener of [...listeners]) {
        try {
          void listener(event);
        } catch {
          // One consumer's fault is not the multiplexer's. Swallowing here
          // keeps a thrown listener from killing the inbound loop and every
          // other port with it.
        }
      }
    },
    markClosed() {
      closed = true;
      listeners.clear();
    },
    isClosed() {
      return closed;
    },
  };
}
