import { getPortCloseSignal } from "./close-signal.js";
import type { MessageTarget } from "./message-target.js";
import {
  nextTask,
  type PortCap,
  setPortAgreement,
  setPortEndState,
  setPortSendState,
} from "./port-credit.js";
import type {
  OpenPortOptions,
  PortCodec,
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

/**
 * The id of keepalive's `ping` / `pong`: one no port ever takes. An older mux
 * whose codec passes unknown envelopes through reads them as a close of that
 * id, which must therefore not be a real port (0 is the initiator's first).
 */
const KEEPALIVE_ID = Number.MAX_SAFE_INTEGER;

/** The longest delay a timer holds; past it `setInterval` fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What a windowed port offers in its `open`: every capability this end
 * speaks. `end` only over a codec that reads it (`PortCodec.halfClose`).
 */
function ownCaps(codec: PortCodec): readonly PortCap[] {
  return codec.halfClose ? ["pipeline", "end"] : ["pipeline"];
}

/**
 * The capabilities in a peer's `caps` that this end speaks too, or
 * `undefined` when the peer listed none (it is then treated as an older peer).
 */
function sharedCaps(own: readonly PortCap[], listed: unknown): Set<PortCap> | undefined {
  if (!Array.isArray(listed)) return undefined;
  return new Set(own.filter((cap) => listed.includes(cap)));
}

/** Ceiling on concurrently open virtual ports. Bounds the id table only. */
export const DEFAULT_MAX_PORTS = 1024;

/** Default ceiling on one message reassembled from frames (`maxReassembledBytes`). */
export const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

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
    keepalive,
    onLeak,
    presumeAck = "learned",
  } = options;
  const maxReassembledBytes = options.maxReassembledBytes ?? DEFAULT_MAX_REASSEMBLED_BYTES;
  const misses = keepalive?.misses ?? 3;
  if (
    keepalive &&
    !(
      Number.isFinite(keepalive.intervalMs) &&
      keepalive.intervalMs > 0 &&
      keepalive.intervalMs <= MAX_TIMER_MS &&
      Number.isSafeInteger(misses) &&
      misses > 0
    )
  ) {
    throw new RangeError(
      `webrun-rpc: keepalive needs an intervalMs in (0, ${MAX_TIMER_MS}] and a positive integer misses`,
    );
  }
  // A frame of no bytes would never advance the split: refuse it here.
  if (frameSize != null && !(Number.isSafeInteger(frameSize) && frameSize > 0)) {
    throw new RangeError(`webrun-rpc: frameSize must be a positive integer, got ${frameSize}`);
  }
  if (presumeAck !== "learned" && presumeAck !== "always" && presumeAck !== "never") {
    throw new RangeError(
      `webrun-rpc: presumeAck must be "learned", "always" or "never", got ${String(presumeAck)}`,
    );
  }
  if (!(Number.isSafeInteger(maxReassembledBytes) && maxReassembledBytes > 0)) {
    throw new RangeError(
      `webrun-rpc: maxReassembledBytes must be a positive integer, got ${maxReassembledBytes}`,
    );
  }

  /**
   * Flow control of one port (`PortMuxOptions.window`): the send side's queue
   * and the bytes delivered but not yet consumed, and the receive side's
   * consumed bytes not yet granted back.
   */
  interface Credit {
    window: number;
    /**
     * The window holds this end's sends. Until the peer has shown it reads
     * credit, bytes are counted but nothing waits: an older peer never sends
     * credit, and its ports must run as they did before. What shows it: on
     * the opener, the responder's ack, or what this mux presumes of it (see
     * `presumed`); on the responder, the opener's answer to the ack, or an
     * `open` listing `caps` on a mux that has already read credit.
     */
    enforced: boolean;
    /** This side opened the port; the other answers its window with an ack. */
    opener: boolean;
    /** The opener has not had the responder's ack yet: the next credit is it. */
    awaitingAck: boolean;
    /**
     * The opener took the window as agreed when the port opened, without
     * waiting for the ack (`presumeAck`): enforced, `pipeline` agreed, and
     * this sizing. Checked against the ack when it arrives, then cleared.
     */
    presumed?: { exact: boolean };
    /** Something was posted on the port while `presumed` held. */
    sentPresumed: boolean;
    /**
     * Both ends count encoded bytes (`PortCodec.encode` / `decode`), and so
     * may split a large message into frames (`frameSize`). If either cannot,
     * both count the shared estimate and send messages whole: two ends
     * counting different sizes would leak window on every message until the
     * port wedged.
     */
    exact: boolean;
    /** What both ends speak on this port; empty until the handshake says otherwise. */
    caps: Set<PortCap>;
    outstanding: number;
    queue: { send: (whole?: boolean) => void; size: number }[];
    queued: number;
    unconsumed: number;
    waiters: { below: number; resolve: () => void }[];
    toGrant: number;
    grantScheduled: boolean;
    /** This side's `end` is queued: anything posted afterwards is dropped. */
    ending: boolean;
    /** This side's `end` has left, behind the port's frames. */
    endSent: boolean;
    /** The peer's `end` has arrived. */
    peerEnded: boolean;
    /**
     * Resolves `whenPortEnded`, once someone waits for it. Held weakly: the
     * waiter's continuations would otherwise keep a dropped port reachable
     * from the mux, and `onLeak` would never see it.
     */
    onPeerEnd?: WeakRef<() => void>;
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
    /**
     * The frames of a message still arriving. `room`: what the window left
     * when the first came, if anything was still owed back then. `charged`:
     * its bytes past the window, counted in `reassembling`.
     */
    partial?: {
      chunks: Uint8Array[];
      bytes: number;
      room?: number;
      owed: number;
      charged: number;
    };
  }
  const open = new Map<number, Entry>();
  // Bytes of partial messages held past their port's window, across every
  // port (`maxReassembledBytes`). What fits a window is bounded by it already.
  let reassembling = 0;
  const freePartial = (entry: Entry | undefined): void => {
    if (!entry?.partial) return;
    reassembling -= entry.partial.charged;
    entry.partial = undefined;
  };
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
  /** What this end offers on a windowed port. */
  const caps = ownCaps(codec);
  /**
   * This mux has read a `credit` envelope: its codec reads them, and the
   * peer's codec posts them. Only then does a responder hold its own sends
   * back from an `open` on (with `caps`), before the opener's answer.
   */
  let creditRead = false;
  /**
   * What a port this mux opens takes as the responder's ack before it
   * arrives (`presumeAck`): with `"always"`, the ack every responder that
   * speaks capabilities sends; with `"learned"`, the one this peer sent on an
   * earlier port, once one listed `pipeline`. `undefined`: presume nothing.
   * An ack that contradicts it turns presumption off for this mux.
   */
  let presumable: { exact: boolean } | undefined =
    presumeAck === "always" ? { exact: exactCodec } : undefined;
  let presumeOff = presumeAck === "never";

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

  /**
   * Both directions have ended: free the id as a close would, with no `close`
   * on the wire (each end frees it on its own once it has seen both ends).
   * Aborting the close signal is how the port's consumer learns it is gone.
   */
  const freeIfEnded = (id: number, c: Credit): void => {
    const entry = open.get(id);
    if (!c.endSent || !c.peerEnded || entry?.credit !== c) return;
    freePartial(entry);
    open.delete(id);
    leaks?.unregister(entry.handle);
    entry.handle.markClosed(new Error("webrun-rpc: the port ended in both directions"));
  };
  /** A peer that broke the port's protocol: hold none of its traffic, and close. */
  const failPort = (id: number, entry: Entry, error: Error, reason: string): void => {
    freePartial(entry);
    dropOutgoing(id);
    open.delete(id);
    releaseWaiters(entry.credit);
    entry.handle.markClosed(error);
    post({ type: "close", id, reason });
  };

  const releaseWaiters = (c: Credit | undefined): void => {
    for (const w of c?.waiters.splice(0) ?? []) w.resolve();
  };

  const flush = (c: Credit): void => {
    while (c.queue.length) {
      // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the queue is not empty.
      const next = c.queue[0]!;
      // A message larger than the window goes out once nothing else is
      // outstanding. An `end` (size 0) costs no window and never waits for credit.
      if (next.size > 0 && c.enforced && c.outstanding > 0 && c.outstanding + next.size > c.window)
        break;
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
    presume?: { exact: boolean },
  ): VirtualPortHandle => {
    // A peer's window must be a positive integer; anything else means none.
    const c: Credit | undefined =
      typeof portWindow === "number" && Number.isSafeInteger(portWindow) && portWindow > 0
        ? {
            window: portWindow,
            // Nobody holds back until the other end has shown it reads credit:
            // the responder's ack proves that to the opener, and the opener's
            // answer to the ack proves it to the responder. An opener that
            // presumes the ack holds back from the start, as on the ack.
            enforced: presume != null,
            opener,
            awaitingAck: opener,
            ...(presume ? { presumed: presume } : {}),
            sentPresumed: false,
            exact: presume ? exact && presume.exact : exact,
            caps: new Set<PortCap>(presume ? ["pipeline"] : []),
            outstanding: 0,
            queue: [],
            queued: 0,
            unconsumed: 0,
            waiters: [],
            toGrant: 0,
            grantScheduled: false,
            ending: false,
            endSent: false,
            peerEnded: false,
          }
        : undefined;
    const self = newVirtualPort(
      (payload, transfer) => {
        // This side's direction has ended: nothing more goes out on it.
        if (c?.ending) return;
        touch(id);
        if (c?.presumed) c.sentPresumed = true;
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
        // `whole`: at close, what is still queued leaves past the window, and
        // a frame past the window is what the peer refuses (`maxReassembledBytes`).
        const send = (whole = false): void => {
          if (!bytes) {
            sendOnPort(id, held ? () => post(held) : () => post(envelope, transfer));
            return;
          }
          // Frames only once the peer has acknowledged exact sizing: before
          // that, it may be a peer that cannot reassemble them.
          if (
            !whole &&
            frameSize != null &&
            c.enforced &&
            c.exact &&
            bytes.byteLength > frameSize
          ) {
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
      freePartial(open.get(id));
      open.delete(id);
      leaks?.unregister(record);
      // What is queued goes out now, before the close and regardless of the
      // window: a peer that stopped returning credit (a listener that never
      // settles) must still learn that the port is closed, and nothing is
      // kept for a port nobody holds. Without a window it would all have
      // gone out at once anyway.
      if (c?.queue.length) {
        for (const item of c.queue.splice(0)) item.send(true);
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
      setPortEndState(self.port, {
        end: () => {
          if (isClosed() || !c.caps.has("end")) return false;
          if (c.ending) return true;
          c.ending = true;
          // Behind what this side already posted: first in the window queue
          // (a size-0 item), then in the fair-framing ring behind its frames.
          c.queue.push({
            size: 0,
            send: () =>
              sendOnPort(id, () => {
                // A port closed meanwhile was abandoned, not ended: its peer
                // hears the close alone, never an end that looks like a normal finish.
                if (open.get(id)?.credit !== c) return;
                post({ type: "end", id });
                c.endSent = true;
                freeIfEnded(id, c);
              }),
          });
          flush(c);
          return true;
        },
        watchPeerEnd: (resolve) => {
          if (!c.caps.has("end")) return false;
          if (c.peerEnded) resolve();
          else c.onPeerEnd = new WeakRef(resolve);
          return true;
        },
      });
      setPortAgreement(self.port, () => ({
        window: c.window,
        caps: c.caps,
        enforced: c.enforced,
      }));
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

  /**
   * The responder's ack of a port this side opened. It settles the sizing and
   * the capabilities; `false` when it closed the port instead.
   */
  const onAck = (
    ack: Extract<PortEnvelope, { type: "credit" }>,
    entry: Entry,
    c: Credit,
  ): boolean => {
    const listed = sharedCaps(caps, ack.caps);
    const presumed = c.presumed;
    if (presumed) {
      c.presumed = undefined;
      // The answer to the ack already left, right behind the `open`.
      const exact = exactCodec && ack.exact === true;
      if (listed?.has("pipeline") && exact === presumed.exact) {
        c.caps = listed;
        return true;
      }
      // Not the ack presumed: this peer acks otherwise, so no later port
      // presumes. A port that sent nothing yet has relied on nothing, and
      // takes the ack as it is; one that did may have sent what the peer
      // does not read (a pipelined chunk, a frame) or counted its bytes
      // otherwise than the peer does, so it fails now rather than wedge.
      presumable = undefined;
      presumeOff = true;
      if (c.sentPresumed) {
        failPort(
          entry.id,
          entry,
          new Error(
            `webrun-rpc: the peer acknowledged port ${entry.id} with ${JSON.stringify({ exact: ack.exact === true, caps: ack.caps ?? null })}, not the exact sizing (${presumed.exact}) and pipeline this side presumed (presumeAck); the port is closed`,
          ),
          "protocol",
        );
        return false;
      }
      c.exact = exact;
      c.caps = listed ?? new Set();
      return true;
    }
    // It settles the sizing: if the responder cannot count exact bytes, both
    // ends fall back to the estimate, and what was counted exactly before the
    // ack no longer matches what comes back.
    if (c.exact && ack.exact !== true) {
      c.exact = false;
      c.outstanding = 0;
    }
    c.caps = listed ?? new Set();
    // Show the responder its codec reads credit, so it may hold back too.
    post({ type: "credit", id: entry.id, bytes: 0 });
    // What later ports may presume: this peer's ack, the same for every port
    // this mux opens (the same window and `open`). Only a peer that speaks
    // capabilities, so one that reads pipelined chunks after an `open`.
    if (presumeAck === "learned" && !presumeOff && listed?.has("pipeline")) {
      if (presumable && presumable.exact !== c.exact) {
        presumable = undefined;
        presumeOff = true;
      } else {
        presumable = { exact: c.exact };
      }
    }
    return true;
  };

  const handleEnvelope = (envelope: PortEnvelope, event: MessageEvent): void => {
    if (muxClosed) return;
    // Anything from the peer shows it is alive.
    heardSincePing = true;
    if (envelope.type === "ping" || envelope.type === "pong") {
      peerKeepsAlive = true;
      if (envelope.type === "ping") post({ type: "pong", id: KEEPALIVE_ID });
      return;
    }

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
      // Only an opener that listed capabilities hears them answered; they
      // hold from here for what it sends.
      //
      // This end's own sends wait for the window once the opener has shown
      // it reads credit. Its answer to the ack shows that, one round trip
      // after the ack; sooner, an `open` that lists capabilities does (only a
      // version that grants credit lists them), but only on a mux that has
      // already read a `credit`: that is what shows this end's own codec
      // reads them, and the peer's posts them. A responder over a codec that
      // drops credit would otherwise wedge its own port after one window.
      const credit = open.get(envelope.id)?.credit;
      const listed = sharedCaps(caps, envelope.caps);
      if (credit) {
        const ack: PortEnvelope = credit.exact
          ? { type: "credit", id: envelope.id, bytes: 0, exact: true }
          : { type: "credit", id: envelope.id, bytes: 0 };
        if (listed) {
          credit.caps = listed;
          if (creditRead) credit.enforced = true;
        }
        post(listed ? { ...ack, caps: [...listed] } : ack);
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
      creditRead = true;
      const c = entry?.credit;
      if (!c || !(envelope.bytes >= 0)) return;
      if (c.awaitingAck) {
        c.awaitingAck = false;
        if (!onAck(envelope, entry as Entry, c)) return;
      }
      c.enforced = true;
      c.outstanding = Math.max(0, c.outstanding - envelope.bytes);
      flush(c);
      return;
    }

    // Nothing follows a peer's `end` on its direction but credit: an honest
    // sender drops what is posted after it. Delivering more would hand the
    // consumer data after it was told the input is over.
    if ((envelope.type === "message" || envelope.type === "frame") && entry?.credit?.peerEnded) {
      failPort(
        envelope.id,
        entry,
        new Error("webrun-rpc: the peer sent on a port after its end"),
        "protocol",
      );
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
      // frame. What a partial message may hold is bounded below, so frames
      // that never end cannot make this side buffer without limit.
      if (!entry?.credit?.exact || !codec.decode || !(envelope.data instanceof Uint8Array)) return;
      touch(envelope.id);
      const c = entry.credit;
      // What this side still owes back (delivered and unconsumed, or consumed
      // and not yet granted) is never more than what the sender counted as
      // outstanding. So an honest sender starts a message only when owed plus
      // the message fits the window, or when nothing is owed at all: a message
      // larger than the window, bounded by `maxReassembledBytes` alone.
      const owed = c.unconsumed + c.toGrant;
      const partial = entry.partial ?? {
        chunks: [],
        bytes: 0,
        owed,
        charged: 0,
        ...(owed > 0 ? { room: c.window - owed } : {}),
      };
      entry.partial = partial;
      const size = envelope.data.byteLength;
      // Only a message begun with nothing owed may pass the window; what it
      // holds past it is what the cap, shared by all ports, bounds.
      const charged = partial.room == null ? Math.max(0, partial.bytes + size - c.window) : 0;
      const overrun =
        partial.room != null && partial.bytes + size > partial.room
          ? `what the window left (${partial.room} of ${c.window} bytes, ${partial.owed} still owed)`
          : reassembling - partial.charged + charged > maxReassembledBytes
            ? `maxReassembledBytes (${maxReassembledBytes} bytes past the window, across all ports)`
            : undefined;
      if (overrun) {
        // A peer that frames past what it may send: hold none of it.
        failPort(
          envelope.id,
          entry,
          new RangeError(`webrun-rpc: a framed message passed ${overrun}`),
          "max-reassembled-bytes",
        );
        return;
      }
      partial.bytes += size;
      reassembling += charged - partial.charged;
      partial.charged = charged;
      partial.chunks.push(envelope.data);
      if (!envelope.last) return;
      freePartial(entry);
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

    if (envelope.type === "end") {
      if (!entry) return;
      const c = entry.credit;
      // Only where `end` was agreed. Anywhere else the peer broke the protocol,
      // as with a pipelined chunk where pipelining was not agreed.
      if (!c?.caps.has("end")) {
        failPort(
          envelope.id,
          entry,
          new Error("webrun-rpc: the peer ended a port where end was not agreed"),
          "protocol",
        );
        return;
      }
      touch(envelope.id);
      c.peerEnded = true;
      c.onPeerEnd?.deref()?.();
      freeIfEnded(envelope.id, c);
      return;
    }

    // The peer closed the port: whatever it still had to receive is moot.
    dropOutgoing(envelope.id);
    if (!entry) return;
    freePartial(entry);
    open.delete(envelope.id);
    releaseWaiters(entry.credit);
    entry.handle.markClosed(new Error("webrun-rpc: the peer closed the port"));
  };

  const listener = (event: MessageEvent): void => {
    const envelope = codec.read(event);
    if (envelope) handleEnvelope(envelope, event);
  };

  // KEEPALIVE: a MessagePort reports neither death nor a frozen peer, so the
  // mux probes. It counts pings that went unanswered — nothing at all from the
  // peer between one ping and the next tick — rather than time since the last
  // message, so timer jitter cannot turn a prompt answer into a miss. It holds
  // a peer to it only once that peer has answered or pinged: an older one,
  // which never does, is never closed for it.
  let peerKeepsAlive = false;
  let heardSincePing = true;
  let unanswered = 0;
  let pinger: ReturnType<typeof setInterval> | undefined;
  const tick = (): void => {
    if (!keepalive) return;
    // A ping still in this end's own transport buffer has not reached the
    // peer: a backlog of ours is not the peer's silence.
    const backlogged = (port.bufferedAmount ?? 0) > 0;
    if (heardSincePing) unanswered = 0;
    else if (peerKeepsAlive && !backlogged) unanswered++;
    if (unanswered >= misses) {
      close(
        new Error(
          `webrun-rpc: the peer did not answer ${misses} keepalive pings, ${keepalive.intervalMs} ms apart`,
        ),
      ).catch(() => {});
      return;
    }
    heardSincePing = false;
    post({ type: "ping", id: KEEPALIVE_ID });
  };

  const close = async (reason?: unknown): Promise<void> => {
    if (muxClosed) return;
    clearInterval(pinger);
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
  // Started only once the pipe is wired, so a constructor that throws above
  // leaves no timer behind.
  if (keepalive) {
    pinger = setInterval(tick, keepalive.intervalMs);
    // A probe must not keep a Node process alive on its own.
    (pinger as { unref?: () => void }).unref?.();
  }
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
      const presume = presumeOff ? undefined : presumable;
      const handle = attach(id, meta, window, true, exactCodec, presume);
      post(
        window
          ? exactCodec
            ? { type: "open", id, meta, window, exact: true, caps: [...caps] }
            : { type: "open", id, meta, window, caps: [...caps] }
          : { type: "open", id, meta },
      );
      // Presumed: the answer to the ack goes now, right behind the `open`,
      // so a responder that waits for it holds back (and so pipelines) from
      // the start too. It is the envelope an answer always was, only sooner.
      if (presume && open.get(id)?.credit) post({ type: "credit", id, bytes: 0 });
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
              // Acknowledged: a presuming opener holds back before its ack.
              ...(credit.enforced && !credit.awaitingAck ? { window: credit.window } : {}),
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
