import type { MessageTarget } from "./message-target.js";
import type { PortEnvelope, PortMux, PortMuxOptions } from "./port-types.js";
import { newVirtualPort, type VirtualPortHandle } from "./virtual-port.js";

/** Ceiling on concurrently open virtual ports. Bounds the id table only. */
export const DEFAULT_MAX_PORTS = 1024;

/**
 * The default `PortMux`: emulates multiplexing over a single port.
 *
 * A transport that already multiplexes natively supplies its own `PortMux`
 * instead — this implementation is for transports that offer one pipe.
 */
export function multiplexPort(port: MessageTarget, options: PortMuxOptions): PortMux {
  const {
    codec,
    onPort,
    side = "initiator",
    maxPorts = DEFAULT_MAX_PORTS,
    maxMessageSize,
  } = options;

  const open = new Map<number, VirtualPortHandle>();
  let nextId = side === "initiator" ? 0 : 1;
  let muxClosed = false;

  const post = (envelope: PortEnvelope, transfer?: Transferable[]): void => {
    if (muxClosed) return;
    try {
      codec.post(port, envelope, transfer);
    } catch {
      // The underlying port is gone. There is nothing useful to do here and
      // no flow control to unwind — layer 1 holds no state on its behalf.
    }
  };

  const attach = (id: number): VirtualPortHandle => {
    let self!: VirtualPortHandle;
    self = newVirtualPort(
      (payload, transfer) => post({ type: "message", id, payload }, transfer),
      (reason) => {
        post({ type: "close", id, reason });
        open.delete(id);
        self.markClosed();
      },
    );
    open.set(id, self);
    return self;
  };

  const handleEnvelope = (envelope: PortEnvelope): void => {
    if (muxClosed) return;

    if (envelope.type === "open") {
      // A duplicate id is a peer bug; ignoring it is safer than replacing a
      // live port out from under its consumer.
      if (open.has(envelope.id)) return;
      if (open.size >= maxPorts) {
        post({ type: "close", id: envelope.id, reason: "max-ports" });
        return;
      }
      const handle = attach(envelope.id);
      let accepted = false;
      if (onPort) {
        try {
          accepted = onPort(handle.port, envelope.meta) !== false;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) {
        open.delete(envelope.id);
        handle.markClosed();
        post({ type: "close", id: envelope.id, reason: "rejected" });
      }
      return;
    }

    const handle = open.get(envelope.id);

    if (envelope.type === "message") {
      // Drop, never queue. An id that was rejected, never opened, or already
      // closed has no consumer, and holding its traffic would be exactly the
      // buffering layer 1 refuses to do.
      if (!handle) return;
      handle.deliver(envelope.payload);
      return;
    }

    if (!handle) return;
    open.delete(envelope.id);
    handle.markClosed();
  };

  const listener = (event: MessageEvent): void => {
    const envelope = codec.read(event);
    if (envelope) handleEnvelope(envelope);
  };

  port.addEventListener("message", listener);
  void port.start?.();

  return {
    maxMessageSize,

    async openPort(meta?: unknown): Promise<MessageTarget> {
      if (muxClosed) throw new Error("webrun-ports: the multiplexer is closed");
      if (open.size >= maxPorts) {
        throw new RangeError(`webrun-ports: maxPorts (${maxPorts}) reached`);
      }
      // A hostile or misconfigured peer may have opened using our own
      // parity. Skipping a claimed id costs one line and keeps a local open
      // from silently taking over a handle the peer is already using.
      while (open.has(nextId)) nextId += 2;
      const id = nextId;
      nextId += 2;
      const handle = attach(id);
      post({ type: "open", id, meta });
      return handle.port;
    },

    async close(): Promise<void> {
      if (muxClosed) return;
      for (const [id, handle] of [...open]) {
        post({ type: "close", id });
        open.delete(id);
        handle.markClosed();
      }
      muxClosed = true;
      port.removeEventListener("message", listener);
      await port.close?.();
    },
  };
}
