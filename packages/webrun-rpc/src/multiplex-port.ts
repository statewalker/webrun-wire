import type { MessageTarget } from "./message-target.js";
import { setPortSendState } from "./port-credit.js";
import type { PortEnvelope, PortMux, PortMuxOptions } from "./port-types.js";
import { newVirtualPort, type VirtualPortHandle } from "./virtual-port.js";

/**
 * What a message costs a port's window (`PortMuxOptions.window`): its bytes and string
 * lengths, found in its values up to 4 levels deep (at most 256 values), and at least 64.
 */
function messageSize(payload: unknown): number {
  let budget = 256;
  const walk = (v: unknown, depth: number): number => {
    if (budget-- <= 0) return 0;
    if (typeof v === "string") return v.length;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (v === null || typeof v !== "object" || depth >= 4) return 8;
    let n = 16;
    if (Array.isArray(v)) for (const x of v) n += walk(x, depth + 1);
    else for (const k in v) n += k.length + walk((v as Record<string, unknown>)[k], depth + 1);
    return n;
  };
  return Math.max(64, walk(payload, 0));
}

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
export function multiplexPort(port: MessageTarget, options: PortMuxOptions): PortMux {
  const {
    codec,
    onPort,
    side = "initiator",
    maxPorts = DEFAULT_MAX_PORTS,
    maxMessageSize,
    window,
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

  // Flow control per port (`window`): the send side's queue and outstanding bytes, and the
  // receive side's consumed bytes not yet granted back.
  interface Credit {
    window: number;
    outstanding: number;
    queue: { payload: unknown; transfer?: Transferable[]; size: number }[];
    queued: number;
    waiters: { below: number; resolve: () => void }[];
    toGrant: number;
    grantScheduled: boolean;
    closeAfterFlush?: () => void;
  }
  const credits = new Map<number, Credit>();

  const flush = (id: number, c: Credit): void => {
    while (c.queue.length) {
      const next = c.queue[0];
      // A message larger than the window goes out once nothing else is outstanding.
      if (c.outstanding > 0 && c.outstanding + next.size > c.window) break;
      c.queue.shift();
      c.queued -= next.size;
      c.outstanding += next.size;
      post({ type: "message", id, payload: next.payload }, next.transfer);
    }
    for (const w of [...c.waiters])
      if (c.queued <= w.below) {
        c.waiters.splice(c.waiters.indexOf(w), 1);
        w.resolve();
      }
    if (!c.queue.length && c.closeAfterFlush) {
      const close = c.closeAfterFlush;
      c.closeAfterFlush = undefined;
      close();
    }
  };

  // Credit goes back in batches: at once from a quarter of the window, else on the next
  // task (so a burst of small messages costs one credit envelope, and a quiet port still
  // gets its last bytes back).
  const grant = (id: number, c: Credit, bytes: number): void => {
    c.toGrant += bytes;
    const send = () => {
      c.grantScheduled = false;
      if (!c.toGrant || !open.has(id)) return;
      post({ type: "credit", id, bytes: c.toGrant });
      c.toGrant = 0;
    };
    if (c.toGrant >= c.window / 4) {
      send();
      return;
    }
    if (c.grantScheduled) return;
    c.grantScheduled = true;
    setTimeout(send, 0);
  };

  const attach = (id: number, portWindow?: number): VirtualPortHandle => {
    let self!: VirtualPortHandle;
    const c: Credit | undefined =
      portWindow && portWindow > 0
        ? {
            window: portWindow,
            outstanding: 0,
            queue: [],
            queued: 0,
            waiters: [],
            toGrant: 0,
            grantScheduled: false,
          }
        : undefined;
    if (c) credits.set(id, c);
    const finish = (reason?: unknown) => {
      post({ type: "close", id, reason });
      open.delete(id);
      credits.delete(id);
      for (const w of c?.waiters ?? []) w.resolve();
      self.markClosed();
    };
    self = newVirtualPort(
      (payload, transfer) => {
        if (!c) {
          post({ type: "message", id, payload }, transfer);
          return;
        }
        const size = messageSize(payload);
        c.queue.push({ payload, transfer, size });
        c.queued += size;
        flush(id, c);
      },
      (reason) => {
        // What is queued still goes out before the close, as it would without a window.
        if (c?.queue.length) {
          open.delete(id); // the consumer is done: no new port may take the id meanwhile
          c.closeAfterFlush = () => {
            post({ type: "close", id, reason });
            credits.delete(id);
            for (const w of c.waiters) w.resolve();
          };
          self.markClosed();
          return;
        }
        finish(reason);
      },
    );
    if (c) {
      const deliver = self.deliver.bind(self);
      self.deliver = (payload) => {
        const done = deliver(payload);
        const size = messageSize(payload);
        if (done) void done.then(() => grant(id, c, size));
        else grant(id, c, size);
        return done;
      };
      setPortSendState(self.port, {
        bufferedAmount: () => c.queued,
        ready: (below = 0) =>
          c.queued <= below
            ? Promise.resolve()
            : new Promise<void>((resolve) => c.waiters.push({ below, resolve })),
      });
    }
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
      const handle = attach(envelope.id, envelope.window);
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

    if (envelope.type === "credit") {
      const c = credits.get(envelope.id);
      if (!c || !(envelope.bytes > 0)) return;
      c.outstanding = Math.max(0, c.outstanding - envelope.bytes);
      flush(envelope.id, c);
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
    for (const w of credits.get(envelope.id)?.waiters ?? []) w.resolve();
    credits.delete(envelope.id);
    handle.markClosed(new Error("webrun-rpc: the peer closed the port"));
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
      if (muxClosed) throw new Error("webrun-rpc: the multiplexer is closed");
      if (open.size >= maxPorts) {
        throw new RangeError(`webrun-rpc: maxPorts (${maxPorts}) reached`);
      }
      // A hostile or misconfigured peer may have opened using our own
      // parity. Skipping a claimed id costs one line and keeps a local open
      // from silently taking over a handle the peer is already using.
      while (open.has(nextId)) nextId += 2;
      const id = nextId;
      nextId += 2;
      const handle = attach(id, window);
      post(window ? { type: "open", id, meta, window } : { type: "open", id, meta });
      return handle.port;
    },

    async close(): Promise<void> {
      if (muxClosed) return;
      for (const [id, handle] of [...open]) {
        post({ type: "close", id });
        open.delete(id);
        handle.markClosed(new Error(MUX_CLOSED_MESSAGE));
      }
      for (const c of credits.values()) for (const w of c.waiters) w.resolve();
      credits.clear();
      muxClosed = true;
      port.removeEventListener("message", listener);
      await port.close?.();
    },
  };
}
