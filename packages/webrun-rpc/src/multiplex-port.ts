import { getPortCloseSignal } from "./close-signal.js";
import type { MessageTarget } from "./message-target.js";
import { nextTask, setPortSendState } from "./port-credit.js";
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
 * What a message costs a port's window when the codec cannot say
 * (`PortCodec.prepare`): its bytes and string lengths, found in its values up
 * to 4 levels deep (at most 256 values), and at least 64. Both ends compute it
 * from the same structured value, so they agree.
 */
export function estimateMessageSize(payload: unknown): number {
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
    window,
  } = options;

  /**
   * Flow control of one port (`PortMuxOptions.window`): the send side's queue
   * and the bytes delivered but not yet consumed, and the receive side's
   * consumed bytes not yet granted back.
   */
  interface Credit {
    window: number;
    /**
     * The peer applies the window. Until it says so (the responder's
     * zero-byte `credit`), bytes are counted but nothing waits: an older peer
     * never sends credit, and its ports must run as they did before.
     */
    enforced: boolean;
    /** This side opened the port; the other answers its window with an ack. */
    opener: boolean;
    /**
     * Both ends count encoded bytes (`PortCodec.prepare` / `size`). If either
     * cannot, both count the shared estimate: two ends counting different
     * sizes would leak window on every message until the port wedged.
     */
    exact: boolean;
    outstanding: number;
    queue: { send: () => void; size: number }[];
    queued: number;
    unconsumed: number;
    waiters: { below: number; resolve: () => void }[];
    toGrant: number;
    grantScheduled: boolean;
    closeAfterFlush?: () => void;
  }
  interface Entry extends PortInfo {
    handle: VirtualPortHandle;
    credit?: Credit;
  }
  const open = new Map<number, Entry>();
  // Ports closed locally whose queue still drains: they left `open`, but the
  // peer's credit must still reach them, or the queue and the close behind it
  // would wait forever.
  const draining = new Map<number, Credit>();
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

  const releaseWaiters = (c: Credit | undefined): void => {
    for (const w of c?.waiters.splice(0) ?? []) w.resolve();
  };

  const flush = (c: Credit): void => {
    while (c.queue.length) {
      // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the queue is not empty.
      const next = c.queue[0]!;
      // A message larger than the window goes out once nothing else is outstanding.
      if (c.enforced && c.outstanding > 0 && c.outstanding + next.size > c.window) break;
      c.queue.shift();
      c.queued -= next.size;
      c.outstanding += next.size;
      next.send();
    }
    for (const w of [...c.waiters]) {
      if (c.queued <= w.below) {
        c.waiters.splice(c.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
    if (!c.queue.length && c.closeAfterFlush) {
      const close = c.closeAfterFlush;
      c.closeAfterFlush = undefined;
      close();
    }
  };

  // Credit goes back in batches: at once from a quarter of the window, else on
  // the next task (so a burst of small messages costs one credit envelope, and
  // a quiet port still gets its last bytes back).
  const grant = (id: number, c: Credit, bytes: number): void => {
    c.unconsumed -= bytes;
    c.toGrant += bytes;
    const send = () => {
      c.grantScheduled = false;
      if (!c.toGrant || !(open.has(id) || draining.has(id))) return;
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

  const attach = (
    id: number,
    meta: unknown,
    portWindow: unknown,
    opener: boolean,
    exact: boolean,
  ): VirtualPortHandle => {
    let self!: VirtualPortHandle;
    // A peer's window must be a positive integer; anything else means none.
    const c: Credit | undefined =
      typeof portWindow === "number" && Number.isSafeInteger(portWindow) && portWindow > 0
        ? {
            window: portWindow,
            // Nobody holds back until the other end has shown it reads credit:
            // the responder's ack proves that to the opener, and the opener's
            // answer to the ack proves it to the responder.
            enforced: false,
            opener,
            exact,
            outstanding: 0,
            queue: [],
            queued: 0,
            unconsumed: 0,
            waiters: [],
            toGrant: 0,
            grantScheduled: false,
          }
        : undefined;
    self = newVirtualPort(
      (payload, transfer) => {
        touch(id);
        if (!c) {
          post({ type: "message", id, payload }, transfer);
          return;
        }
        const envelope: PortEnvelope = { type: "message", id, payload };
        // Encoded once, here, when the codec can: the exact wire size is then
        // what the window counts, on both ends.
        const prepared = c.exact ? codec.prepare?.(envelope, transfer) : undefined;
        const size = prepared?.size ?? estimateMessageSize(payload);
        const send = prepared
          ? () => {
              if (muxClosed) return;
              try {
                prepared.post(port);
              } catch {
                // The underlying port is gone, as in `post`.
              }
            }
          : () => post(envelope, transfer);
        c.queue.push({ send, size });
        c.queued += size;
        flush(c);
      },
      (reason) => {
        open.delete(id);
        // What is queued still goes out before the close, as it would without
        // a window. The id is already free: no new port may take it meanwhile.
        if (c?.queue.length) {
          draining.set(id, c);
          c.closeAfterFlush = () => {
            draining.delete(id);
            post({ type: "close", id, reason });
            releaseWaiters(c);
          };
          self.markClosed();
          return;
        }
        post({ type: "close", id, reason });
        releaseWaiters(c);
        self.markClosed();
      },
    );
    if (c) {
      const deliver = self.deliver.bind(self);
      self.deliver = (payload, size = estimateMessageSize(payload)) => {
        c.unconsumed += size;
        const done = deliver(payload);
        if (done) void done.then(() => grant(id, c, size));
        else grant(id, c, size);
        return done;
      };
      setPortSendState(self.port, {
        bufferedAmount: () => c.queued,
        ready: (below = 0) =>
          new Promise<void>((resolve) => {
            if (c.queued <= below || self.isClosed()) nextTask(resolve);
            else c.waiters.push({ below, resolve: () => nextTask(resolve) });
          }),
      });
    }
    const now = Date.now();
    open.set(id, { id, meta, openedAt: now, lastActivity: now, handle: self, credit: c });
    return self;
  };

  const handleEnvelope = (envelope: PortEnvelope, event: MessageEvent): void => {
    if (muxClosed) return;

    if (envelope.type === "open") {
      // A duplicate id is a peer bug; ignoring it is safer than replacing a
      // live port out from under its consumer.
      if (open.has(envelope.id)) return;
      if (open.size >= maxPorts) {
        post({ type: "close", id: envelope.id, reason: "max-ports" });
        return;
      }
      // The opener asked for a window and is known to speak it.
      const handle = attach(
        envelope.id,
        envelope.meta,
        envelope.window,
        false,
        envelope.exact === true && codec.prepare != null,
      );
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
        return;
      }
      // Acknowledge the window, so the opener starts to apply it.
      const credit = open.get(envelope.id)?.credit;
      if (credit) {
        post(
          credit.exact
            ? { type: "credit", id: envelope.id, bytes: 0, exact: true }
            : { type: "credit", id: envelope.id, bytes: 0 },
        );
      }
      return;
    }

    const entry = open.get(envelope.id);

    if (envelope.type === "credit") {
      const c = entry?.credit ?? draining.get(envelope.id);
      if (!c || !(envelope.bytes >= 0)) return;
      if (!c.enforced && c.opener) {
        // The ack. It also settles the sizing: if the responder cannot count
        // exact bytes, both ends fall back to the estimate, and what was
        // counted exactly before the ack no longer matches what comes back.
        if (c.exact && envelope.exact !== true) {
          c.exact = false;
          c.outstanding = 0;
        }
        // Show the responder its codec reads credit, so it may hold back too.
        post({ type: "credit", id: envelope.id, bytes: 0 });
      }
      c.enforced = true;
      c.outstanding = Math.max(0, c.outstanding - envelope.bytes);
      flush(c);
      return;
    }

    if (envelope.type === "message") {
      // Drop, never queue. An id that was rejected, never opened, or already
      // closed has no consumer, and holding its traffic would be exactly the
      // buffering layer 1 refuses to do.
      const sizeOf = (c: Credit) =>
        c.exact && codec.size ? codec.size(event) : estimateMessageSize(envelope.payload);
      if (!entry) {
        // Closed here while its own queue drains: credit what arrives at
        // once, or a peer that closed with a full queue too would wait for
        // credit that never comes, and neither close would ever go out.
        const c = draining.get(envelope.id);
        if (c) {
          const size = sizeOf(c);
          c.unconsumed += size;
          grant(envelope.id, c, size);
        }
        return;
      }
      touch(envelope.id);
      entry.handle.deliver(envelope.payload, entry.credit ? sizeOf(entry.credit) : undefined);
      return;
    }

    if (!entry) {
      // The peer is gone from a port still draining: nothing will be read.
      releaseWaiters(draining.get(envelope.id));
      draining.delete(envelope.id);
      return;
    }
    open.delete(envelope.id);
    releaseWaiters(entry.credit);
    entry.handle.markClosed(new Error("webrun-rpc: the peer closed the port"));
  };

  const listener = (event: MessageEvent): void => {
    const envelope = codec.read(event);
    if (envelope) handleEnvelope(envelope, event);
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
    for (const [id, { handle, credit }] of [...open]) {
      codecPost({ type: "close", id });
      open.delete(id);
      releaseWaiters(credit);
      handle.markClosed(reason ?? new Error(MUX_CLOSED_MESSAGE));
    }
    // Ports closed locally while their queue drained: the peer still waits
    // for their close.
    for (const [id, c] of draining) {
      codecPost({ type: "close", id });
      releaseWaiters(c);
    }
    draining.clear();
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
      const exact = codec.prepare != null;
      const handle = attach(id, meta, window, true, exact);
      post(
        window
          ? exact
            ? { type: "open", id, meta, window, exact: true }
            : { type: "open", id, meta, window }
          : { type: "open", id, meta },
      );
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
      return [...open.values()].map(({ handle: _, credit, ...info }) =>
        credit
          ? {
              ...info,
              ...(credit.enforced ? { window: credit.window } : {}),
              queued: credit.queued,
              outstanding: credit.outstanding,
              unconsumed: credit.unconsumed,
            }
          : info,
      );
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
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([name, n]) => `${name}: ${n}`)
    .join(", ");
}
