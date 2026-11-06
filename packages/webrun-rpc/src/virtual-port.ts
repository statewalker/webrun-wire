import { setPortCloseSignal } from "./close-signal.js";
import type { MessageListener, MessageTarget } from "./message-target.js";

export interface VirtualPortHandle {
  /** The consumer-facing end. Indistinguishable from a real `MessagePort`. */
  port: MessageTarget;
  /**
   * Multiplexer-only: hand an inbound payload to the consumer's listeners.
   * Returns a promise when a listener returned one (settled once they all
   * have), so flow control can count the message as consumed only then.
   */
  deliver(payload: unknown, size?: number): Promise<unknown> | undefined;
  /**
   * Multiplexer-only: the port is finished; drop listeners and go inert.
   * `reason` becomes the reason of the port's close signal (see
   * `getPortCloseSignal`), which is what fails the calls still waiting on it.
   */
  markClosed(reason?: unknown): void;
  isClosed(): boolean;
  /** Multiplexer-only: the consumer still listens, so the port is in use. */
  hasListeners(): boolean;
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

  // A standalone function, not a method using `port`: closures here share one
  // scope, and one that captured `port` would make `deliver` and `markClosed`
  // — which the mux keeps — hold the consumer's port too (see `onLeak`). It
  // also works detached, as `Symbol.dispose` may be called.
  const close = (reason?: unknown): void => {
    if (closed) return;
    closed = true;
    const notify = requestClose;
    listeners.clear();
    // The mux frees the port first (its slot and its entry in `ports()`), then the close
    // signal fires with the caller's reason: a listener that reopens (reconnect logic) finds
    // the slot free. `notify` passes the reason on to `markClosed`, which aborts with it.
    notify(reason);
    abort(reason);
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
    close,
  };
  setPortCloseSignal(port, closing.signal);
  // `using port = await mux.openPort()` closes it on scope exit. Installed
  // only where the runtime has the symbol, and kept off the declared type,
  // which would require consumers to compile with `esnext.disposable`.
  const dispose = (Symbol as { dispose?: symbol }).dispose;
  if (dispose) {
    Object.defineProperty(port, dispose, { value: () => close(), configurable: true });
  }

  return {
    port,
    deliver(payload) {
      if (closed) return;
      const event = new MessageEvent("message", { data: payload });
      let pending: PromiseLike<unknown>[] | undefined;
      // Copy first: a listener may add or remove listeners while running.
      for (const listener of [...listeners]) {
        try {
          const result = listener(event) as unknown;
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            pending ??= [];
            pending.push(result as PromiseLike<unknown>);
          }
        } catch {
          // One consumer's fault is not the multiplexer's. Swallowing here
          // keeps a thrown listener from killing the inbound loop and every
          // other port with it.
        }
      }
      return pending ? Promise.allSettled(pending) : undefined;
    },
    markClosed(reason) {
      closed = true;
      listeners.clear();
      abort(reason);
    },
    isClosed() {
      return closed;
    },
    hasListeners() {
      return listeners.size > 0;
    },
  };
}
