import { setPortCloseSignal } from "./close-signal.js";
import type { MessageListener, MessageTarget } from "./message-target.js";

export interface VirtualPortHandle {
  /** The consumer-facing end. Indistinguishable from a real `MessagePort`. */
  port: MessageTarget;
  /** Multiplexer-only: hand an inbound payload to the consumer's listeners. */
  deliver(payload: unknown): void;
  /**
   * Multiplexer-only: the port is finished; drop listeners and go inert.
   * `reason` becomes the reason of the port's close signal (see
   * `getPortCloseSignal`), which is what fails the calls still waiting on it.
   */
  markClosed(reason?: unknown): void;
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
  // A virtual port knows when it is finished, unlike a raw `MessagePort`. Its
  // close signal is what lets the calls still waiting on it — `callPort`, and
  // the streams of `duplexOverPort` — fail at once instead of hanging on a
  // port that has gone inert. Without it, closing a multiplexer left every call
  // in flight on it pending forever.
  const closing = new AbortController();
  const abort = (reason?: unknown) => {
    if (closing.signal.aborted) return;
    closing.abort(reason ?? new Error("webrun-rpc: the port was closed"));
  };

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
      abort();
    },
  };
  setPortCloseSignal(port, closing.signal);

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
    markClosed(reason) {
      closed = true;
      listeners.clear();
      abort(reason);
    },
    isClosed() {
      return closed;
    },
  };
}
