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
 */

/** The first byte of a control frame on a windowed channel. */
export const CONTROL_BYTE = 0xc1;

const TYPE_DATA = 0x00;
const TYPE_HELLO = 0x01;
const TYPE_CREDIT = 0x02;

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
  /** A data frame of `size` bytes reached the port. */
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
}): PortWindow {
  const { window: own, send, fail, onHello } = options;
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

  const blocked = (size: number): boolean =>
    peerWindow !== undefined && size > 0 && outstanding > 0 && outstanding + size > peerWindow;

  const flush = (): void => {
    while (queue.length && !ended) {
      // biome-ignore lint/style/noNonNullAssertion: the loop condition checks the queue is not empty.
      const next = queue[0]!;
      if (blocked(next.size)) break;
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
        peerWindow = granted;
        onHello?.(granted);
        // An opener that asked learns here that the peer reads control frames.
        sayHello();
        if (toGrant > 0) sendGrant();
        flush();
        return undefined;
      }
      if (type === TYPE_CREDIT) {
        outstanding = Math.max(0, outstanding - readValue(frame));
        flush();
        return undefined;
      }
      throw new Error(`a control frame of unknown type ${type}`);
    },
    arrived(size) {
      unconsumed += size;
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
      settleWaiters();
    },
    end() {
      ended = true;
      queue.length = 0;
      queued = 0;
      settleWaiters();
    },
  };
}
