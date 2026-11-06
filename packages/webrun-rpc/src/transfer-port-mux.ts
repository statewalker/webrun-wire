import type { MessageTarget } from "./message-target.js";
import type { OpenPortOptions, PortMux } from "./port-types.js";

/** The `type` of the envelope that carries a transferred port to the peer. */
export const PORT_TRANSFER = "webrun-rpc:port-transfer";

export interface TransferPortMuxOptions {
  /**
   * Called when the peer transfers a port in. Return `false` to reject it: the
   * port is closed and nothing further arrives on it. Any other return value —
   * including `undefined` — accepts.
   *
   * With no `onPort` at all, inbound ports are rejected, matching
   * `multiplexPort`: a port nobody holds has no consumer.
   */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined;
  /** Reported to layer 2, never enforced. A `MessagePort` normally has none. */
  maxMessageSize?: number;
}

/**
 * A `PortMux` whose ports are real, transferred `MessagePort`s (spec D23).
 *
 * `openPort` creates a `MessageChannel`, transfers one end to the peer over
 * `target`, and returns the other. There is no id table, no `maxPorts` and no
 * envelope overhead per message, because the platform does the multiplexing.
 *
 * **It needs structured clone with transferables**, so it exists in browsers,
 * workers and iframes and nowhere else that lacks them. A caller selects it
 * explicitly rather than by capability sniffing (spec D21): use
 * `multiplexPort` where the transport is one pipe of bytes.
 *
 * What it buys over emulation: a transferred port can cross an origin or a
 * worker boundary and be handed to code that never saw `target`, where an
 * emulated port id is meaningless outside its own mux.
 *
 * `target` must be a full `MessageTarget`. Reaching a send-only `MessageSink`
 * — a `ServiceWorkerClient`, say — is a real use of port transfer but needs a
 * different entry point, and is not part of this interface.
 */
export function transferPortMux(
  target: MessageTarget,
  options: TransferPortMuxOptions = {},
): PortMux {
  const { onPort, maxMessageSize } = options;
  // Each port this side issued, with the function that detaches it from its `openPort` signal.
  const issued = new Map<MessagePort, () => void>();
  let closed = false;

  const listener = (event: MessageEvent): void => {
    if (closed) return;
    const data = event.data as { type?: unknown; meta?: unknown } | undefined;
    if (!data || typeof data !== "object" || data.type !== PORT_TRANSFER) return;
    const port = event.ports?.[0];
    // The right `type` with no port attached is a malformed message, not a
    // transfer. Dropping it keeps a shared parent port uncorrupted.
    if (!port) return;
    port.start();
    let accepted = false;
    if (onPort) {
      try {
        accepted = onPort(port, data.meta) !== false;
      } catch {
        accepted = false;
      }
    }
    if (!accepted) {
      port.close();
      return;
    }
    // A port its user closes is forgotten, as on the opening side.
    const forget = () => issued.delete(port);
    issued.set(port, forget);
    const close = port.close.bind(port);
    port.close = () => {
      forget();
      close();
    };
  };

  target.addEventListener("message", listener);
  void target.start?.();

  return {
    maxMessageSize,

    async openPort(meta?: unknown, { signal }: OpenPortOptions = {}): Promise<MessageTarget> {
      if (closed) throw new Error("webrun-rpc: the multiplexer is closed");
      if (signal?.aborted) throw signal.reason;
      const channel = new MessageChannel();
      channel.port1.start();
      // The transferred end is not referenced from the message itself, so it
      // arrives in `event.ports` on the peer — the platform's own hand-off,
      // identical in Node and in browsers.
      target.postMessage({ type: PORT_TRANSFER, meta }, [channel.port2]);
      const port = channel.port1;
      const onAbort = () => port.close();
      signal?.addEventListener("abort", onAbort, { once: true });
      // The port is done when its user closes it, the signal aborts, or the mux closes: each
      // forgets it and removes the signal's listener, so a long-lived signal reused for many
      // ports holds none of them.
      const forget = () => {
        signal?.removeEventListener("abort", onAbort);
        issued.delete(port);
      };
      issued.set(port, forget);
      const close = port.close.bind(port);
      port.close = () => {
        forget();
        close();
      };
      return port;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      target.removeEventListener("message", listener);
      for (const port of [...issued.keys()]) {
        try {
          port.close(); // forgets it too
        } catch {
          /* already gone */
        }
      }
      issued.clear();
      await target.close?.();
    },
  };
}
