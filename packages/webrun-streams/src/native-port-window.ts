/**
 * Per-port flow control for native ports (statewalker/webrun-wire#153): a
 * window of credit on each channel a native port mux runs over, so a producer
 * stays within a bounded number of bytes of a consumer that stopped reading,
 * whatever the transport buffers, while up to a window is in flight per round
 * trip.
 *
 * Each end grants its peer a window: at most that many bytes of the port's
 * messages delivered to it and not yet consumed. A message counts as consumed
 * once every listener has returned, or, for a listener that returns a
 * promise, once it settles. Credit goes back as the consumer drains, in
 * batches. A message larger than the peer's window goes once nothing else is
 * outstanding.
 *
 * **On the wire.** A data frame is the codec's bytes, as on a channel without
 * a window. A control frame starts with the byte {@link CONTROL_BYTE} (0xC1,
 * which no msgpack value and no UTF-8 text starts with), then its type: a
 * `hello` carries the window its sender grants, a `credit` the bytes its
 * sender consumed. A data frame whose bytes start with 0xC1 goes escaped.
 *
 * **Agreement.** The transport says at open whether both ends speak it
 * (`NativeChannel.window`): `"agreed"` when the open settled it for both (a
 * libp2p protocol id, or a WebRTC responder that saw the opener ask), so each
 * end says `hello` at once; `"offered"` when this end asked and only an
 * answer can tell (a WebRTC opener), so this end says nothing until the
 * peer's `hello`, and an older peer, which never says it, is never sent a
 * control frame.
 *
 * **No round trip where it is known.** Every windowed end grants at least
 * {@link MIN_PORT_WINDOW}, and a `hello` below it is refused. So an end that
 * knows its peer speaks the window (`"agreed"`, or an `"offered"` port on a
 * mux that has already heard a peer's `hello`: `presume`) holds its sends to
 * that floor from the start, and needs no confirmation per message, until the
 * peer's `hello` raises the window to what it grants. An `"offered"` port
 * without that knowledge counts but does not wait until the peer's `hello`,
 * as a port without a window.
 *
 * **A bounded send-ahead** (statewalker/webrun-wire#195). The peer's window
 * is what it says it will hold, not what this end must buffer for it: a
 * sender runs at most min(the peer's window, its own window) ahead, so a peer
 * that announces 4 GiB and stops reading costs this end no more than the
 * window it chose. And nothing goes on a transport that says it needs to
 * drain (`transport.needsDrain()`): the frame waits in the port's queue,
 * which the stream tier waits on (`bufferedAmount`, `ready`), so at most one
 * frame is written past the transport's buffer. Credit for the peer is held
 * back too, and goes as one combined frame once the transport drains: a peer
 * that uploads and never reads cannot grow this end's buffer with credit
 * frames. A write or credit that has waited for drain longer than
 * `drainTimeoutMs` breaks the port off (`stall`); so does a write that has
 * waited that long for the peer's credit (statewalker/webrun-wire#201): a
 * peer that takes a message and never consumes past it cannot park the
 * sender (and whatever its producer holds) for ever. Credit that arrives
 * restarts the bound. A quiet port, with nothing waiting to go, is never
 * timed out. Withholding credit cannot deadlock past that bound: a peer
 * waiting for credit while this end waits for its transport to drain ends in
 * the stall timeout, as any stalled peer does.
 *
 * **The inbound window is enforced** (statewalker/webrun-wire#197): a peer
 * that sends past the window this end grants, without waiting for credit,
 * gets its port failed, so a slow listener holds at most about one window of
 * a peer that ignores it. An honest peer never makes the unconsumed bytes
 * pass the window, except with one message larger than the window sent while
 * nothing else was outstanding: so the port fails once the unconsumed bytes
 * pass both the window and the message that just arrived. The bound holds
 * from the first frame: a windowed peer that knows this end speaks the
 * window holds its sends to the 64 KiB floor until this end's `hello`, and
 * this end grants at least that. (A WebRTC opener learns that its peer speaks
 * the window only from the peer's `hello`, and sends without a bound until
 * then: it must not post more than the peer's window before its port has
 * heard the peer. The stream tier never does.)
 */

/** The first byte of a control frame on a windowed channel. */
export const CONTROL_BYTE = 0xc1;

const TYPE_DATA = 0x00;
const TYPE_HELLO = 0x01;
const TYPE_CREDIT = 0x02;

/** The longest delay `setTimeout` keeps: a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The largest window a `hello` can carry: 4 GiB less one byte. */
export const MAX_PORT_WINDOW = 0xffffffff;

/**
 * The smallest window an end may grant: 64 KiB. What a peer may send before
 * this end's `hello` arrives, where it knows this end speaks the window.
 */
export const MIN_PORT_WINDOW = 64 * 1024;

/** What two ends have agreed on one windowed native port, once the peer's `hello` arrived. */
export interface NativePortAgreement {
  /** The window this end grants: the most it holds of the peer's messages unconsumed. */
  window: number;
  /** `"pipeline"`: the peer holds its sends to this end's window, so it needs no confirmation per message. */
  caps: ReadonlySet<"pipeline">;
  /** This end holds its own sends to the peer's window. */
  enforced: boolean;
}

/** The flow state of one windowed native port. */
export interface PortFlow {
  /** What has been agreed with the peer; `undefined` until its `hello` arrives (or for ever, from an older peer). */
  agreement(): NativePortAgreement | undefined;
  /** Bytes queued on this port, waiting for the peer's credit. */
  bufferedAmount(): number;
  /** Resolves once at most `below` bytes are queued (default 0), or the port ended. */
  ready(below?: number): Promise<void>;
  /** The counters, for diagnostics. */
  stats(): {
    window: number;
    peerWindow?: number;
    queued: number;
    outstanding: number;
    unconsumed: number;
  };
}

/**
 * Where a windowed native port carries its {@link PortFlow}; `Symbol.for`, so
 * that a reader in another copy of this package (`@statewalker/webrun-rpc`'s
 * stream tier) finds it.
 */
export const PORT_FLOW: unique symbol = Symbol.for("@statewalker/webrun-streams/port-flow");

/** The flow state of `port`, if it is a windowed native port. */
export function portFlow(port: unknown): PortFlow | undefined {
  if (port === null || (typeof port !== "object" && typeof port !== "function")) return undefined;
  return (port as { [PORT_FLOW]?: PortFlow })[PORT_FLOW];
}

/** @internal How a native port mux drives one windowed channel. */
export interface PortWindow {
  flow: PortFlow;
  /** Sends one message's codec bytes, now or once the peer's window has room. Throws what the channel throws. */
  post(bytes: Uint8Array): void;
  /**
   * One inbound frame: the codec bytes of a data frame, or `undefined` for a
   * control frame, handled here. Throws on a control frame it cannot read.
   */
  receive(frame: Uint8Array): Uint8Array | undefined;
  /**
   * A data frame of `size` bytes reached the port. Throws when it takes the
   * peer past the window this end grants: the peer ignored the window (#197).
   */
  arrived(size: number): void;
  /** A message of `size` bytes was consumed: its credit goes back. */
  consumed(size: number): void;
  /** Sends everything queued, past the window: the port is closing. */
  flushAll(): void;
  /** The port ended: nothing more is sent, and every wait settles. */
  end(): void;
}

const PIPELINE: ReadonlySet<"pipeline"> = new Set(["pipeline"]);

function controlFrame(type: number, value: number): Uint8Array {
  const frame = new Uint8Array(6);
  frame[0] = CONTROL_BYTE;
  frame[1] = type;
  new DataView(frame.buffer).setUint32(2, value);
  return frame;
}

function readValue(frame: Uint8Array): number {
  if (frame.byteLength !== 6) throw new Error("a control frame of the wrong length");
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2);
}

/** @internal Checks a `window` option: an integer from {@link MIN_PORT_WINDOW} to {@link MAX_PORT_WINDOW}. */
export function checkPortWindow(name: string, window: number | undefined): void {
  if (window === undefined) return;
  if (!Number.isSafeInteger(window) || window < MIN_PORT_WINDOW || window > MAX_PORT_WINDOW) {
    throw new RangeError(
      `${name}: \`window\` must be an integer from ${MIN_PORT_WINDOW} to ${MAX_PORT_WINDOW} bytes, got ${window}`,
    );
  }
}

/** @internal The window of one channel; see the module comment. */
export function newPortWindow(options: {
  /** The window this end grants. */
  window: number;
  mode: "agreed" | "offered";
  /**
   * An `"offered"` port whose peer is known to speak the window (its mux
   * heard a peer's `hello` before): treated as `"agreed"`.
   */
  presume?: boolean;
  /** The peer's `hello` arrived, with the window it grants. */
  onHello?(window: number): void;
  /** Puts one frame on the channel; throws what the channel throws. */
  send(frame: Uint8Array): void;
  /** A queued frame failed to go out: the port is broken. */
  fail(reason: Error): void;
  /**
   * The transport's backpressure: while `needsDrain()` says so, data frames
   * wait in the port's queue, and go once `whenDrained()` resolves. Control
   * frames (small, and what frees the peer) always go.
   */
  transport?: { needsDrain(): boolean; whenDrained(): Promise<void> };
  /**
   * How long a write (or credit for the peer) may wait for the transport to
   * drain before the port is broken off with `stall`. Unset, 0 or Infinity:
   * no bound; past 2^31 - 1 ms it is clamped to that.
   */
  drainTimeoutMs?: number;
  /** A write waited for drain longer than `drainTimeoutMs`. Default: `fail`. */
  stall?(reason: Error): void;
}): PortWindow {
  const { window: own, send, fail, onHello, transport } = options;
  // 0 and Infinity: no bound.
  const drainTimeoutMs =
    options.drainTimeoutMs === 0 || options.drainTimeoutMs === Number.POSITIVE_INFINITY
      ? undefined
      : options.drainTimeoutMs;
  const stall = options.stall ?? fail;
  const mode = options.presume ? "agreed" : options.mode;
  /** The window the peer grants: the floor until its `hello`, where it is known to speak the window. */
  let peerWindow: number | undefined = mode === "agreed" ? MIN_PORT_WINDOW : undefined;
  let heard = false;
  let helloSent = false;
  let outstanding = 0;
  const queue: { frame: Uint8Array; size: number }[] = [];
  let queued = 0;
  let unconsumed = 0;
  let toGrant = 0;
  let grantScheduled = false;
  let ended = false;
  const waiters: { below: number; resolve: () => void }[] = [];

  /** Whether this end may send control frames: the peer is known to read them. */
  const speaks = () => mode === "agreed" || peerWindow !== undefined;

  const sayHello = (): void => {
    if (helloSent || ended) return;
    helloSent = true;
    send(controlFrame(TYPE_HELLO, own));
  };

  const sendGrant = (): void => {
    grantScheduled = false;
    if (ended || !speaks()) return;
    // Credit is cumulative: on a transport that needs to drain it accumulates,
    // and goes as one frame once it drains (review of #196). Otherwise a peer
    // that uploads and never reads would grow this end's write buffer by a
    // credit frame per batch, with no write ever waiting for drain.
    if (toGrant > 0 && transportFull()) {
      awaitDrain();
      return;
    }
    while (toGrant > 0) {
      const bytes = Math.min(toGrant, MAX_PORT_WINDOW);
      toGrant -= bytes;
      try {
        send(controlFrame(TYPE_CREDIT, bytes));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  };

  const settleWaiters = (): void => {
    for (const w of [...waiters]) {
      if (ended || queued <= w.below) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  /** Set while a wait for the transport to drain is armed. */
  let draining = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Armed while a queued write waits for the peer's credit (#201). */
  let creditTimer: ReturnType<typeof setTimeout> | undefined;

  const stopCreditTimer = (): void => {
    if (creditTimer !== undefined) clearTimeout(creditTimer);
    creditTimer = undefined;
  };

  /** A queued write waits for the peer's credit: bounded by `drainTimeoutMs`, restarted by credit. */
  const awaitCredit = (): void => {
    if (drainTimeoutMs === undefined || creditTimer !== undefined || ended) return;
    creditTimer = setTimeout(
      () => {
        creditTimer = undefined;
        if (ended || queue.length === 0) return;
        stall(
          new Error(
            `a write waited for the peer's credit for more than ${drainTimeoutMs} ms: the peer stopped reading`,
          ),
        );
      },
      Math.min(drainTimeoutMs, MAX_TIMER_MS),
    );
    // A peer that stops reading must not keep Node alive.
    (creditTimer as { unref?: () => void }).unref?.();
  };

  const stopStallTimer = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const transportFull = (): boolean => transport?.needsDrain() === true;

  /** Waits for the transport to drain, then sends what is queued; bounded by `drainTimeoutMs`. */
  const awaitDrain = (): void => {
    if (draining || ended || !transport) return;
    draining = true;
    if (drainTimeoutMs !== undefined && stallTimer === undefined) {
      stallTimer = setTimeout(
        () => {
          stallTimer = undefined;
          if (ended || !draining || (queue.length === 0 && toGrant === 0)) return;
          stall(
            new Error(
              `a write waited for the transport to drain for more than ${drainTimeoutMs} ms: the peer stopped reading`,
            ),
          );
        },
        Math.min(drainTimeoutMs, MAX_TIMER_MS),
      );
      // A peer that stops reading must not keep Node alive.
      (stallTimer as { unref?: () => void }).unref?.();
    }
    let waiting: Promise<void>;
    try {
      waiting = transport.whenDrained();
    } catch (err) {
      draining = false;
      stopStallTimer();
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const resume = (): void => {
      draining = false;
      stopStallTimer();
      // Credit first: it is what lets the peer go on.
      if (toGrant > 0) sendGrant();
      flush();
    };
    waiting.then(resume, resume);
  };

  const blocked = (size: number): boolean =>
    transportFull() ||
    (peerWindow !== undefined && size > 0 && outstanding > 0 && outstanding + size > peerWindow);

  const flush = (): void => {
    while (queue.length && !ended) {
      // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the queue is not empty.
      const next = queue[0]!;
      if (transportFull()) {
        awaitDrain();
        break;
      }
      if (blocked(next.size)) {
        awaitCredit();
        break;
      }
      queue.shift();
      queued -= next.size;
      outstanding += next.size;
      try {
        send(next.frame);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    if (queue.length === 0) stopCreditTimer();
    settleWaiters();
  };

  const escapeData = (bytes: Uint8Array): Uint8Array => {
    if (bytes[0] !== CONTROL_BYTE) return bytes;
    const frame = new Uint8Array(bytes.byteLength + 2);
    frame[0] = CONTROL_BYTE;
    frame[1] = TYPE_DATA;
    frame.set(bytes, 2);
    return frame;
  };

  const flow: PortFlow = {
    agreement: () =>
      peerWindow === undefined ? undefined : { window: own, caps: PIPELINE, enforced: true },
    bufferedAmount: () => queued,
    ready(below = 0) {
      if (ended || queued <= below) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ below, resolve }));
    },
    stats: () => ({
      window: own,
      ...(peerWindow !== undefined ? { peerWindow } : {}),
      queued,
      outstanding,
      unconsumed,
    }),
  };

  if (mode === "agreed") sayHello();

  return {
    flow,
    post(bytes) {
      if (ended) return;
      const size = bytes.byteLength;
      const frame = escapeData(bytes);
      if (queue.length || blocked(size)) {
        queue.push({ frame, size });
        queued += size;
        if (transportFull()) awaitDrain();
        else awaitCredit();
        return;
      }
      outstanding += size;
      send(frame);
    },
    receive(frame) {
      if (frame[0] !== CONTROL_BYTE) return frame;
      const type = frame[1];
      if (type === TYPE_DATA) return frame.subarray(2);
      if (type === TYPE_HELLO) {
        const granted = readValue(frame);
        if (granted < MIN_PORT_WINDOW) throw new Error(`a hello below the floor: ${granted}`);
        if (heard) throw new Error("a second hello");
        heard = true;
        // Clamped to this end's own window: the peer's grant is what it will
        // hold, not what this end must buffer for it (#195).
        peerWindow = Math.min(granted, own);
        onHello?.(granted);
        // An opener that asked learns here that the peer reads control frames.
        sayHello();
        if (toGrant > 0) sendGrant();
        flush();
        return undefined;
      }
      if (type === TYPE_CREDIT) {
        outstanding = Math.max(0, outstanding - readValue(frame));
        // Credit is progress: the bound restarts (armed again by `flush` if a write still waits).
        stopCreditTimer();
        flush();
        return undefined;
      }
      throw new Error(`a control frame of unknown type ${type}`);
    },
    arrived(size) {
      unconsumed += size;
      // An honest peer stays within the window, or sends one message larger
      // than it with nothing else outstanding (#197).
      if (unconsumed > own && unconsumed > size) {
        throw new Error(`the peer sent past the window (${own} bytes) without waiting for credit`);
      }
    },
    consumed(size) {
      if (ended) return;
      unconsumed -= size;
      toGrant += size;
      // Credit goes back in batches: at once from a quarter of the window,
      // else on the next task (a burst of small messages costs one frame, and
      // a quiet port still gets its last bytes back).
      if (toGrant >= own / 4) {
        sendGrant();
        return;
      }
      if (grantScheduled) return;
      grantScheduled = true;
      setTimeout(sendGrant, 0);
    },
    flushAll() {
      while (queue.length && !ended) {
        // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the queue is not empty.
        const next = queue.shift()!;
        queued -= next.size;
        outstanding += next.size;
        try {
          send(next.frame);
        } catch {
          break;
        }
      }
      queue.length = 0;
      queued = 0;
      stopStallTimer();
      stopCreditTimer();
      settleWaiters();
    },
    end() {
      ended = true;
      stopStallTimer();
      stopCreditTimer();
      queue.length = 0;
      queued = 0;
      settleWaiters();
    },
  };
}
