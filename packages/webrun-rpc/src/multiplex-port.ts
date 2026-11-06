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
 * (`PortCodec.encode`): its bytes and string lengths, found in its values up
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
    frameSize,
    onLeak,
  } = options;
  // A frame of no bytes would never advance the split: refuse it here.
  if (frameSize != null && !(Number.isSafeInteger(frameSize) && frameSize > 0)) {
    throw new RangeError(`webrun-rpc: frameSize must be a positive integer, got ${frameSize}`);
  }

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
     * Both ends count encoded bytes (`PortCodec.encode` / `decode`), and so
     * may split a large message into frames (`frameSize`). If either cannot,
     * both count the shared estimate and send messages whole: two ends
     * counting different sizes would leak window on every message until the
     * port wedged.
     */
    exact: boolean;
    outstanding: number;
    queue: { send: () => void; size: number }[];
    queued: number;
    unconsumed: number;
    waiters: { below: number; resolve: () => void }[];
    toGrant: number;
    grantScheduled: boolean;
  }
  /**
   * What the mux keeps of a port: never the consumer's `port` object itself,
   * so a port its consumer dropped can be collected and reported (`onLeak`).
   */
  type PortRecord = Pick<
    VirtualPortHandle,
    "deliver" | "markClosed" | "isClosed" | "hasListeners"
  > & {
    /** Close the port as its consumer's `close()` would, without its object. */
    close(reason: unknown): void;
  };
  interface Entry extends PortInfo {
    handle: PortRecord;
    credit?: Credit;
    /** The frames of a message still arriving. */
    partial?: { chunks: Uint8Array[]; bytes: number };
  }
  const open = new Map<number, Entry>();
  // A port collected while still open: report it, then free its slot on both
  // ends as its close would. Only with `onLeak` — a registry costs per port.
  const leaks = onLeak
    ? new FinalizationRegistry<{
        id: number;
        record: PortRecord;
        release: (reason: unknown) => void;
      }>(({ id, record, release }) => {
        const entry = open.get(id);
        if (entry?.handle !== record) return;
        const { handle: _, credit: __, partial: ___, ...info } = entry;
        // A port whose consumer still listens is still receiving (a
        // subscription that keeps only its listener): report it, but leave it
        // open. One with no listener can neither send nor receive any more.
        if (!record.hasListeners()) {
          release("leaked");
          record.markClosed(new Error("webrun-rpc: the port was dropped without close()"));
        }
        try {
          onLeak?.(info);
        } catch {
          // A reporter's fault must not escape into the finalizer.
        }
      })
    : undefined;
  const touch = (id: number): void => {
    const entry = open.get(id);
    if (entry) entry.lastActivity = Date.now();
  };
  let nextId = side === "initiator" ? 0 : 1;
  let muxClosed = false;
  /** This end counts encoded bytes and reassembles frames. */
  const exactCodec = codec.encode != null && codec.decode != null;

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

  // FAIR FRAMING (`frameSize`): what each port has to put on the pipe, taken
  // one item per port in turn whenever the pipe has room (`whenDrained`). A
  // large message is split into frames first, so a small one on another port
  // waits for one frame, not for the whole message. Without `frameSize`
  // everything is posted at once, as before.
  const outgoing = new Map<number, Array<() => void>>();
  const ring: number[] = [];
  let pumping = false;
  const pump = async (): Promise<void> => {
    pumping = true;
    try {
      while (ring.length && !muxClosed) {
        // A pipe without the method has no way to say it is full; the loop
        // then runs to the end synchronously.
        if (port.whenDrained) await port.whenDrained();
        if (muxClosed) break;
        // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the ring is not empty.
        const id = ring.shift()!;
        const queue = outgoing.get(id);
        const item = queue?.shift();
        if (queue?.length) ring.push(id);
        else outgoing.delete(id);
        item?.();
      }
    } catch (err) {
      // The pipe failed while this mux waited for room: nothing queued can
      // go out now, and the ports must hear so rather than wait forever.
      close(err).catch(() => {});
    } finally {
      pumping = false;
    }
  };
  const sendOnPort = (id: number, item: () => void): void => {
    if (frameSize == null) {
      item();
      return;
    }
    let queue = outgoing.get(id);
    if (!queue) {
      queue = [];
      outgoing.set(id, queue);
      ring.push(id);
    }
    queue.push(item);
    if (!pumping) void pump();
  };
  const dropOutgoing = (id: number): void => {
    if (!outgoing.delete(id)) return;
    const at = ring.indexOf(id);
    if (at >= 0) ring.splice(at, 1);
  };
  const postBytes = (bytes: Uint8Array): void => {
    if (muxClosed) return;
    try {
      port.postMessage(bytes);
    } catch {
      // The underlying port is gone, as in `post`.
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
  };

  // Credit goes back in batches: at once from a quarter of the window, else on
  // the next task (so a burst of small messages costs one credit envelope, and
  // a quiet port still gets its last bytes back).
  const grant = (id: number, c: Credit, bytes: number): void => {
    c.unconsumed -= bytes;
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

  const attach = (
    id: number,
    meta: unknown,
    portWindow: unknown,
    opener: boolean,
    exact: boolean,
  ): VirtualPortHandle => {
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
    const self = newVirtualPort(
      (payload, transfer) => {
        touch(id);
        const envelope: PortEnvelope = { type: "message", id, payload };
        // Without a window nothing frames or waits: post at once, so the
        // payload is read now, while the caller still expects it to be.
        if (!c) {
          post(envelope, transfer);
          return;
        }
        // Encoded once, here, when the codec can: the exact wire size is then
        // what the window counts, on both ends, and the bytes are what frames split.
        const bytes = c.exact ? codec.encode?.(envelope) : undefined;
        const size = bytes?.byteLength ?? estimateMessageSize(payload);
        // A message that will wait (for credit, or for the pump when framing)
        // is copied now, as `postMessage` would copy it at once: the caller may
        // reuse its buffer as soon as it returns. Encoded bytes are a copy already.
        const waits =
          frameSize != null ||
          c.queue.length > 0 ||
          (c.enforced && c.outstanding > 0 && c.outstanding + size > c.window);
        const held =
          !bytes && waits
            ? { ...envelope, payload: structuredClone(payload, { transfer }) }
            : undefined;
        const send = (): void => {
          if (!bytes) {
            sendOnPort(id, held ? () => post(held) : () => post(envelope, transfer));
            return;
          }
          // Frames only once the peer has acknowledged exact sizing: before
          // that, it may be a peer that cannot reassemble them.
          if (frameSize != null && c.enforced && c.exact && bytes.byteLength > frameSize) {
            for (let at = 0; at < bytes.byteLength; at += frameSize) {
              const data = bytes.subarray(at, at + frameSize);
              const frame: PortEnvelope =
                at + frameSize >= bytes.byteLength
                  ? { type: "frame", id, data, last: true }
                  : { type: "frame", id, data };
              sendOnPort(id, () => post(frame));
            }
            return;
          }
          sendOnPort(id, () => postBytes(bytes));
        };
        c.queue.push({ send, size });
        c.queued += size;
        flush(c);
      },
      (reason) => {
        release(reason);
        record.markClosed(reason);
      },
    );
    function release(reason: unknown): void {
      open.delete(id);
      leaks?.unregister(record);
      // What is queued goes out now, before the close and regardless of the
      // window: a peer that stopped returning credit (a listener that never
      // settles) must still learn that the port is closed, and nothing is
      // kept for a port nobody holds. Without a window it would all have
      // gone out at once anyway.
      if (c?.queue.length) {
        for (const item of c.queue.splice(0)) item.send();
        c.queued = 0;
      }
      // Behind this port's frames, so the peer gets the whole message first.
      sendOnPort(id, () => post({ type: "close", id, reason }));
      releaseWaiters(c);
    }
    // No closure below may refer to `self`: closures in one scope share it, and
    // the ones the mux keeps would then hold the consumer's port (`onLeak`).
    const { markClosed, isClosed, hasListeners } = self;
    if (c) {
      const deliver = self.deliver;
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
            if (c.queued <= below || isClosed()) nextTask(resolve);
            else c.waiters.push({ below, resolve: () => nextTask(resolve) });
          }),
      });
    }
    const record: PortRecord = {
      deliver: self.deliver,
      markClosed,
      isClosed,
      hasListeners,
      close: (reason) => {
        if (isClosed()) return;
        release(reason);
        markClosed(reason);
      },
    };
    leaks?.register(self.port, { id, record, release }, record);
    const now = Date.now();
    open.set(id, { id, meta, openedAt: now, lastActivity: now, handle: record, credit: c });
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
        envelope.exact === true && exactCodec,
      );
      // Acknowledge the window before `onPort` runs: what `onPort` posts then
      // reaches the opener after the ack, so both ends count it the same way
      // (exact bytes or the estimate). A rejection's close follows the ack.
      const credit = open.get(envelope.id)?.credit;
      if (credit) {
        post(
          credit.exact
            ? { type: "credit", id: envelope.id, bytes: 0, exact: true }
            : { type: "credit", id: envelope.id, bytes: 0 },
        );
      }
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

      return;
    }

    const entry = open.get(envelope.id);

    if (envelope.type === "credit") {
      const c = entry?.credit;
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
        (c.exact ? byteLengthOf(event.data) : undefined) ?? estimateMessageSize(envelope.payload);
      if (!entry) return;
      touch(envelope.id);
      entry.handle.deliver(envelope.payload, entry.credit ? sizeOf(entry.credit) : undefined);
      return;
    }

    if (envelope.type === "frame") {
      // Only where this end advertised exact sizing — the one place a peer may
      // frame. A frame sequence buffers no more than the same message sent
      // whole, which a byte transport would also have to hold entire.
      if (!entry?.credit?.exact || !codec.decode || !(envelope.data instanceof Uint8Array)) return;
      touch(envelope.id);
      const partial = entry.partial ?? { chunks: [], bytes: 0 };
      entry.partial = partial;
      partial.chunks.push(envelope.data);
      partial.bytes += envelope.data.byteLength;
      if (!envelope.last) return;
      entry.partial = undefined;
      const whole = new Uint8Array(partial.bytes);
      let at = 0;
      for (const chunk of partial.chunks) {
        whole.set(chunk, at);
        at += chunk.byteLength;
      }
      const inner = codec.decode(whole);
      if (inner?.type !== "message" || inner.id !== envelope.id) return;
      entry.handle.deliver(inner.payload, whole.byteLength);
      return;
    }

    // The peer closed the port: whatever it still had to receive is moot.
    dropOutgoing(envelope.id);
    if (!entry) return;
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
    const closedNow = new Set<number>();
    for (const [id, { handle, credit }] of [...open]) {
      // A port that a close-signal listener closed meanwhile is still sent its close here: its own
      // close() posts nothing once the mux is closing.
      closedNow.add(id);
      codecPost({ type: "close", id });
      open.delete(id);
      releaseWaiters(credit);
      handle.markClosed(reason ?? new Error(MUX_CLOSED_MESSAGE));
    }
    // Ports closed here whose close still waits behind their frames: it goes
    // now, or the peer would hold them open forever.
    for (const id of outgoing.keys()) if (!closedNow.has(id)) codecPost({ type: "close", id });
    outgoing.clear();
    ring.length = 0;
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
      const handle = attach(id, meta, window, true, exactCodec);
      post(
        window
          ? exactCodec
            ? { type: "open", id, meta, window, exact: true }
            : { type: "open", id, meta, window }
          : { type: "open", id, meta },
      );
      if (portSignal) {
        // Through the mux's record, not the port: a long-lived signal must not
        // keep a dropped port reachable, and must still free it once dropped.
        const record = open.get(id)?.handle;
        const onAbort = () => {
          if (record && open.get(id)?.handle === record) record.close(portSignal.reason);
        };
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

/** The byte length of a received message's data, or `undefined` if it is not bytes. */
function byteLengthOf(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
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
