import { getPortCloseSignal } from "./close-signal.js";
import type { MessageTarget } from "./message-target.js";
import type {
  OpenPortOptions,
  PortEnvelope,
  PortInfo,
  PortMux,
  PortMuxOptions,
} from "./port-types.js";
import { newVirtualPort, type VirtualPortHandle } from "./virtual-port.js";

/**
 * The message of the error that fails the calls still in flight on a
 * multiplexer when it is closed (`PortMux.close()`).
 */
export const MUX_CLOSED_MESSAGE = "webrun-rpc: the multiplexer was closed";

/** Ceiling on concurrently open virtual ports. Bounds the id table only. */
export const DEFAULT_MAX_PORTS = 1024;

/**
 * The default `PortMux`: emulates multiplexing over a single port.
 *
 * A transport that already multiplexes natively supplies its own `PortMux`
 * instead — this implementation is for transports that offer one pipe.
 */
export function multiplexPort(
  port: MessageTarget,
  options: PortMuxOptions,
): PortMux & { ports(): PortInfo[] } {
  const {
    codec,
    onPort,
    side = "initiator",
    maxPorts = DEFAULT_MAX_PORTS,
    maxMessageSize,
    signal,
  } = options;

  interface Entry extends PortInfo {
    handle: VirtualPortHandle;
  }
  const open = new Map<number, Entry>();
  const touch = (id: number): void => {
    const entry = open.get(id);
    if (entry) entry.lastActivity = Date.now();
  };
  let nextId = side === "initiator" ? 0 : 1;
  let muxClosed = false;

  const post = (envelope: PortEnvelope, transfer?: Transferable[]): void => {
    if (muxClosed) return;
    codecPost(envelope, transfer);
  };
  /** Like `post`, also while closing: the mux's own close notices. */
  const codecPost = (envelope: PortEnvelope, transfer?: Transferable[]): void => {
    try {
      codec.post(port, envelope, transfer);
    } catch {
      // The underlying port is gone. There is nothing useful to do here and
      // no flow control to unwind — layer 1 holds no state on its behalf.
    }
  };

  const attach = (id: number, meta: unknown): VirtualPortHandle => {
    let self!: VirtualPortHandle;
    self = newVirtualPort(
      (payload, transfer) => {
        touch(id);
        post({ type: "message", id, payload }, transfer);
      },
      (reason) => {
        post({ type: "close", id, reason });
        open.delete(id);
        self.markClosed(reason);
      },
    );
    const now = Date.now();
    open.set(id, { id, meta, openedAt: now, lastActivity: now, handle: self });
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
      const handle = attach(envelope.id, envelope.meta);
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
        handle.markClosed(new Error("webrun-rpc: the port was rejected"));
        post({ type: "close", id: envelope.id, reason: "rejected" });
      }
      return;
    }

    const handle = open.get(envelope.id)?.handle;

    if (envelope.type === "message") {
      // Drop, never queue. An id that was rejected, never opened, or already
      // closed has no consumer, and holding its traffic would be exactly the
      // buffering layer 1 refuses to do.
      if (!handle) return;
      touch(envelope.id);
      handle.deliver(envelope.payload);
      return;
    }

    if (!handle) return;
    open.delete(envelope.id);
    handle.markClosed(new Error("webrun-rpc: the peer closed the port"));
  };

  const listener = (event: MessageEvent): void => {
    const envelope = codec.read(event);
    if (envelope) handleEnvelope(envelope);
  };

  const close = async (reason?: unknown): Promise<void> => {
    if (muxClosed) return;
    // Closed BEFORE the ports: `markClosed` runs their close-signal listeners
    // synchronously, and one that reopens (reconnect logic) must be refused
    // rather than add a port after the snapshot below, which nothing would
    // ever close.
    muxClosed = true;
    signal?.removeEventListener("abort", onTransportAbort);
    port.removeEventListener("message", listener);
    for (const [id, { handle }] of [...open]) {
      // A port that a close-signal listener closed meanwhile is still sent its close here: its own
      // close() posts nothing once the mux is closing.
      codecPost({ type: "close", id });
      open.delete(id);
      handle.markClosed(reason ?? new Error(MUX_CLOSED_MESSAGE));
    }
    await port.close?.();
  };
  // Nobody awaits the transport's close on this path, and a dead transport's
  // `close()` often rejects (a stream already reset): never let that become
  // an unhandled rejection.
  const onTransportAbort = (): void => {
    close(signal?.reason).catch(() => {});
  };

  port.addEventListener("message", listener);
  void port.start?.();
  if (signal?.aborted) close(signal.reason).catch(() => {});
  else signal?.addEventListener("abort", onTransportAbort, { once: true });

  return {
    maxMessageSize,

    async openPort(meta?: unknown, { signal: portSignal }: OpenPortOptions = {}) {
      if (muxClosed) throw new Error("webrun-rpc: the multiplexer is closed");
      // As `fetch` does: a signal already aborted opens nothing.
      if (portSignal?.aborted) throw portSignal.reason;
      if (open.size >= maxPorts) {
        throw new RangeError(
          `webrun-rpc: maxPorts (${maxPorts}) reached; open ports by kind: ${describeKinds(open.values())}`,
        );
      }
      // A hostile or misconfigured peer may have opened using our own
      // parity. Skipping a claimed id costs one line and keeps a local open
      // from silently taking over a handle the peer is already using.
      while (open.has(nextId)) nextId += 2;
      const id = nextId;
      nextId += 2;
      const handle = attach(id, meta);
      post({ type: "open", id, meta });
      if (portSignal) {
        const onAbort = () => void handle.port.close?.(portSignal.reason);
        portSignal.addEventListener("abort", onAbort, { once: true });
        getPortCloseSignal(handle.port)?.addEventListener(
          "abort",
          () => portSignal.removeEventListener("abort", onAbort),
          { once: true },
        );
      }
      return handle.port;
    },

    close,

    ports(): PortInfo[] {
      return [...open.values()].map(({ handle: _, ...info }) => info);
    },
  };
}

/**
 * `"http: 1000, ws: 24"`: the three commonest `meta.kind`s among `entries`, so
 * a full table names who filled it. A port without a kind counts as `"?"`.
 */
function describeKinds(entries: Iterable<PortInfo>): string {
  const counts = new Map<string, number>();
  for (const { meta } of entries) {
    const kind = (meta as { kind?: unknown } | undefined)?.kind;
    const name = typeof kind === "string" ? kind : "?";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (!counts.size) return "none";
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([name, n]) => `${name}: ${n}`)
    .join(", ");
}
