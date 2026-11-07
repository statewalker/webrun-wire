import {
  type ChunkReceiver,
  type Duplex,
  deserializeError,
  recieveIterator,
  type SerializedError,
  sendIterator,
  serializeError,
  toChunks,
} from "@statewalker/webrun-streams";
import { callPort, NO_TIMEOUT } from "./call-port.js";
import { getPortCloseSignal } from "./close-signal.js";
import { listenPort } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";
import {
  endPort,
  portAgreement,
  portBufferedAmount,
  whenPortEnded,
  whenPortReady,
} from "./port-credit.js";
import { returningAtOnce } from "./return-at-once.js";
import { throughAbort } from "./through-abort.js";

/**
 * The `type` of the out-of-band notice a side posts when it abandons a stream.
 *
 * Layer 1's `close` is not observable to layer 2 — a closed virtual port drops
 * its listeners silently and is indistinguishable from a working port nobody
 * is answering — so the peer would otherwise wait forever. Exported because
 * tests and adapters assert on it.
 */
export const STREAM_ABORT = "webrun-rpc:stream-abort";

/**
 * The `type` of a pipelined chunk: a plain port message, not a `callPort`
 * request, sent only on a port where both ends agreed `pipeline`. The window's
 * credit is its confirmation.
 */
const CHUNK = "webrun-rpc:chunk";

/**
 * What a pipelined chunk counts beyond its bytes, against the window, on the
 * receiving side. Both codecs' windows count more for the chunk's envelope
 * (the estimate at least 64, msgpack's keys alone more than this), so an honest
 * sender never makes the receiver count past the window; a sender of empty
 * chunks still cannot have it hold an unbounded number of them.
 */
const CHUNK_OVERHEAD = 32;

/**
 * The bytes of `view` as a plain `Uint8Array` that owns its whole buffer:
 * `view` itself when it already is one, else a copy. Structured clone carries
 * and keeps a view's whole `ArrayBuffer`, and a byte codec may decode into
 * views of the frame, while the window and the receiver's count see only the
 * view: a 4 KiB `subarray` of a 4 MiB buffer would cost 4 MiB per chunk.
 * Copied with the `Uint8Array` constructor, not `slice()`: a Node `Buffer`'s
 * `slice()` is another view on the same memory.
 */
function ownBytes(view: ArrayBufferView): Uint8Array {
  if (
    view instanceof Uint8Array &&
    view.constructor === Uint8Array &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  ) {
    return view;
  }
  return new Uint8Array(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

/**
 * A producer's chunk as bytes this end may send, in either mode: any view or
 * `ArrayBuffer`, normalised by `ownBytes`. Anything else fails the stream here,
 * as the producer's own error, rather than reaching a peer that would refuse it.
 */
/**
 * A received confirmed chunk's value, as its own bytes, put back in place of
 * the original in `chunk`: `listenPort` keeps the request until the handler
 * returns, and the original would keep its whole buffer that long. A function
 * of its own, so that no temporary of the suspended handler holds the
 * original either.
 */
function adoptValue(chunk: WireChunk): WireChunk["value"] {
  const original: unknown = chunk.value;
  if (ArrayBuffer.isView(original)) chunk.value = ownBytes(original);
  return chunk.value;
}

function chunkBytes(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value)) return ownBytes(value);
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  ) {
    return new Uint8Array(value as ArrayBuffer);
  }
  throw new TypeError(
    `webrun-rpc: a stream chunk must be bytes (a typed array, a DataView or an ArrayBuffer), got ${value === null ? "null" : typeof value}`,
  );
}

const MIXED_MESSAGE =
  "webrun-rpc: peer mixed confirmed and pipelined chunks; the stream port is closed";

/** This end may pipeline its own chunks: agreed, and the window holds them. */
const mayPipeline = (port: MessageTarget): boolean => {
  const agreement = portAgreement(port);
  return !!agreement?.enforced && agreement.caps.has("pipeline");
};

/** Caller's input travels on this channel; the handler listens on it. */
const CHANNEL_IN = "in";
/** The handler's output travels on this channel; the caller listens on it. */
const CHANNEL_OUT = "out";

/** One chunk on the wire: `IteratorChunk<Uint8Array>` with the error serialised. */
interface WireChunk {
  done: boolean;
  value?: Uint8Array;
  error?: SerializedError;
}

export interface DuplexOverPortOptions {
  /**
   * Largest payload one chunk may carry, from `PortMux.maxMessageSize` (spec
   * D10). Bodies are split to fit with `toChunks`. Unset means no limit and no
   * splitting.
   */
  maxMessageSize?: number;
  /**
   * Inactivity timeout for the whole stream, in ms: the clock is reset by any
   * chunk in either direction, and elapsing aborts the stream. Unset — the
   * default — means no timeout at all (spec D8): a slow consumer is throttled,
   * never failed. Any finite default would reintroduce F5 at a different
   * threshold.
   */
  timeout?: number;
  /** Logging function; defaults to a no-op. */
  log?: (...args: unknown[]) => void;
}

/**
 * One port in, one `Duplex` out (spec D9).
 *
 * The returned `Duplex` runs a single stream on `port`: the caller's `input`
 * is sent chunk by chunk with `callPort`, and the handler's output arrives the
 * same way on the other channel. Within each direction the next chunk is never
 * sent until the previous one has been delivered *and* pulled past by the
 * consumer (spec D11) — the reply to a chunk call *is* the confirmation, and
 * `listenPort` withholds it until then. On a port whose window both ends
 * speak and that agreed `pipeline`, chunks go as plain messages instead, and
 * the window's credit is the confirmation: up to a window is in flight.
 *
 * A stream port carries exactly one invocation. To make several calls, open
 * several ports: `mux.openPort({ kind: "stream" })` per call.
 */
export function duplexOverPort(port: MessageTarget, options: DuplexOverPortOptions = {}): Duplex {
  return (input) => runCallerSide(port, input, options);
}

/**
 * Installs `handler` as the serving side of one stream on `port`. Returns an
 * idempotent teardown that abandons the stream and notifies the peer.
 */
export function serveDuplexOverPort(
  port: MessageTarget,
  handler: Duplex,
  options: DuplexOverPortOptions = {},
): () => void {
  const controller = new AbortController();
  const notice = installAbortNotice(port, controller);
  abortOnPortClose(port, controller);
  const clock = installStreamTimeout(controller, options.timeout);
  const inbound = receiveChunks(port, CHANNEL_IN, controller, clock.touch, notice);
  let output: AsyncGenerator<Uint8Array>;
  try {
    output = handler(inbound.stream);
  } catch (err) {
    // A handler that throws before returning a generator still owes the peer
    // an end-of-stream, or its `callPort` never settles.
    const pump = sendChunks(
      port,
      CHANNEL_OUT,
      failing(err),
      options,
      controller.signal,
      clock.touch,
      () => {},
    );
    void pump.catch(() => {});
    disarmClockWhenBothSidesSettle(clock, pump, inbound.ended);
    return teardownOnce(controller, notice, clock, inbound, undefined);
  }
  let onSent = () => {};
  const sent = new Promise<void>((resolve) => {
    onSent = resolve;
  });
  const pump = sendChunks(
    port,
    CHANNEL_OUT,
    output,
    options,
    controller.signal,
    clock.touch,
    onSent,
  );
  void pump.catch(() => {
    // Reported to the peer inside sendChunks; nothing to surface locally.
  });
  disarmClockWhenBothSidesSettle(clock, pump, inbound.ended);
  void endServedStream(port, sent, inbound.over);
  return teardownOnce(controller, notice, clock, inbound, output);
}

/**
 * The serving side's normal finish. Once the handler's last chunk has gone
 * without an error, and no more input is coming (`over`: the caller's last
 * chunk arrived without an error and was read, or the caller ended its
 * direction behind it, for a handler that did not read all its input), this
 * side ends its direction too, where `end` was agreed. Without `end` nothing
 * happens here: the caller closes the port. A stream that never gets that far
 * was abandoned, and the caller's notice and `close` free the port; this then
 * never resumes. It needs no race against the port's close signal: nothing
 * awaits it, and what keeps it waiting is the input's watcher, a listener of
 * the port that a close drops, after which the wait is collected.
 *
 * Nothing this side still posts is lost behind its `end`. The caller ends only
 * once its own last chunk was confirmed, so no confirmation is owed to it
 * here, and what the freed port's close signal aborts has settled: the last
 * chunk has left, and input nobody reads is dropped, as on a close.
 */
async function endServedStream(
  port: MessageTarget,
  sent: Promise<void>,
  over: Promise<void>,
): Promise<void> {
  await sent;
  await over;
  endPort(port);
}

/**
 * A stream that completes normally has nobody left to call the returned
 * teardown — the caller only knows the stream ended, not that it must also
 * dispose the serve-side handle. Without this, the last `touch()`'s timer
 * stays armed for up to `timeout` ms after real completion, doing nothing
 * but holding the event loop open.
 *
 * Only disarms once BOTH `pump` (our output) and `inboundEnded` (the peer's
 * declared end of input, or an abort) have settled. Disarming on `pump`
 * alone is not safe: under half-close the handler can finish producing
 * output while the caller is still sending input, and a clock stopped then
 * would leave that still-open half with no deadline at all — worse than the
 * leak this fixes.
 */
function disarmClockWhenBothSidesSettle(
  clock: { stop(): void },
  pump: Promise<void>,
  inboundEnded: Promise<void>,
): void {
  void Promise.allSettled([pump, inboundEnded]).then(() => {
    clock.stop();
  });
}

async function* failing(err: unknown): AsyncGenerator<Uint8Array> {
  if ((0 as number) === 0) throw err;
  yield new Uint8Array(0);
}

function teardownOnce(
  controller: AbortController,
  notice: { post(): void; stop(): void },
  clock: { touch(): void; stop(): void },
  inbound: { stop(): void },
  output: AsyncGenerator<Uint8Array> | undefined,
): () => void {
  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    if (!controller.signal.aborted) controller.abort(new Error("webrun-rpc: stream torn down"));
    notice.post();
    notice.stop();
    clock.stop();
    inbound.stop();
    void output?.return(undefined as never).catch(() => {});
  };
}

function runCallerSide(
  port: MessageTarget,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: DuplexOverPortOptions,
): AsyncGenerator<Uint8Array> {
  const controller = new AbortController();
  const notice = installAbortNotice(port, controller);
  abortOnPortClose(port, controller);
  const clock = installStreamTimeout(controller, options.timeout);
  const inbound = receiveChunks(port, CHANNEL_OUT, controller, clock.touch, notice);
  let sent = false;
  const pump = sendChunks(port, CHANNEL_IN, input, options, controller.signal, clock.touch, () => {
    sent = true;
  });
  void pump.catch(() => {
    // The outbound half's failure surfaces to the peer, not to this consumer:
    // the consumer's contract is the inbound half.
  });

  const stream = (async function* () {
    let received = false;
    try {
      yield* inbound.stream;
      received = true;
    } finally {
      // Both directions ended normally: the handler's end arrived without an
      // error, and this side's left without one. Anything else is abandoned.
      const ended = received && sent;
      // Abort BEFORE awaiting the pump. `callPort` runs with NO_TIMEOUT here,
      // so an un-aborted in-flight chunk call would never settle and this
      // `finally` would deadlock — which is exactly the defect found in the
      // -webrtc adapter, where the outbound half was awaited unconditionally.
      if (!controller.signal.aborted) {
        controller.abort(new Error("webrun-rpc: the caller abandoned the stream"));
      }
      // A normal finish ends this direction where `end` was agreed, rather
      // than closing: the port is then freed on both ends once the handler's
      // side ends too, and the peer never mistakes it for an abandonment.
      if (!ended) notice.post();
      notice.stop();
      clock.stop();
      inbound.stop();
      await pump.catch(() => {});
      // By now `listenPort` has confirmed the handler's last chunk: this
      // generator ends only after that chunk's delivery settled, and the
      // confirmation leaves in the promise turns right after it. It must, as
      // anything posted after the `end` is dropped.
      if (!(ended && endPort(port))) {
        // No `end`: the notice (if not posted above), then `close`.
        notice.post();
        try {
          await port.close?.();
        } catch {
          /* the port may already be gone; nothing to unwind */
        }
      }
    }
  })();
  // A caller that gives up while it waits for the peer's next chunk ends the
  // stream now: the abort settles that wait, and the `finally` above runs.
  return returningAtOnce(stream, () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("webrun-rpc: the caller abandoned the stream"));
    }
  });
}

/**
 * Listens for the peer's abort notice, and can post our own. The notice is a
 * plain message with no `channelName` and a `type` that is not `"request"`,
 * so neither `callPort` nor `listenPort` reacts to it, and it carries no
 * numeric `id`, so `structuredCodec` never mistakes it for a layer 1 envelope.
 */
function installAbortNotice(
  port: MessageTarget,
  controller: AbortController,
): { post(): void; stop(): void } {
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | undefined;
    if (!data || data.type !== STREAM_ABORT) return;
    if (!controller.signal.aborted) {
      controller.abort(new Error("webrun-rpc: the peer abandoned the stream"));
    }
  };
  port.addEventListener("message", onMessage);
  let posted = false;
  return {
    post() {
      if (posted) return;
      posted = true;
      try {
        port.postMessage({ type: STREAM_ABORT });
      } catch {
        /* the port is already gone — the peer needs no notice */
      }
    },
    stop() {
      port.removeEventListener("message", onMessage);
    },
  };
}

/**
 * Aborts the stream when its port closes underneath it — the multiplexer was
 * closed, or the peer closed the port — for ports that report it (see
 * `getPortCloseSignal`). Without this a stream waiting for the peer's next
 * chunk would wait forever on a port that can no longer deliver one: the
 * outbound half's `callPort` already fails on the close signal, but nothing
 * failed the inbound half.
 */
function abortOnPortClose(port: MessageTarget, controller: AbortController): void {
  const closed = getPortCloseSignal(port);
  if (!closed) return;
  const onClose = () => {
    if (!controller.signal.aborted) controller.abort(closed.reason);
  };
  if (closed.aborted) {
    onClose();
    return;
  }
  closed.addEventListener("abort", onClose, { once: true });
  controller.signal.addEventListener("abort", () => closed.removeEventListener("abort", onClose), {
    once: true,
  });
}

/**
 * The per-stream inactivity timeout (spec D8). Reset by any chunk in either
 * direction; elapsing aborts the stream. Unset, zero or non-finite installs no
 * timer at all, which is the default: a slow consumer is throttled, not failed.
 */
function installStreamTimeout(
  controller: AbortController,
  timeout: number | undefined,
): { touch(): void; stop(): void } {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) {
    return { touch() {}, stop() {} };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Once `stop()` runs, it must stay stopped. Without this, a chunk that
  // arrives after disarming (e.g. `touch()` called from a pump that hadn't
  // yet noticed the stream ended) would silently re-arm a timer nobody is
  // ever going to stop again — the same leak this task exists to close, just
  // reachable from a different angle now that `stop()` can run mid-life
  // (fix round 2), not only at final teardown.
  let stopped = false;
  const arm = () => {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`webrun-rpc: stream idle for ${timeout} ms`));
      }
    }, timeout);
  };
  arm();
  return {
    touch() {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The receiving half of one direction.
 *
 * The `listenPort` listener is installed **eagerly**, not lazily inside
 * `recieveIterator`'s installer, because a handler that never drains its input
 * would otherwise leave the peer's chunk calls with nobody to answer them. If
 * the local consumer has not started iterating, an inbound chunk waits for it —
 * which is the correct backpressure, and different from having no listener.
 */
function receiveChunks(
  port: MessageTarget,
  channelName: string,
  controller: AbortController,
  touch: () => void,
  notice: { post(): void },
): {
  stream: AsyncGenerator<Uint8Array>;
  stop(): void;
  ended: Promise<void>;
  over: Promise<void>;
} {
  let deliver: ChunkReceiver<Uint8Array> | undefined;
  const waiting: Array<() => void> = [];
  let finished = false;
  let outstanding = false;
  let poison: Error | undefined;
  // Resolves once no more chunks are coming on this channel — either the
  // wire declared `done` (with or without an error) or the signal aborted.
  // Used by `serveDuplexOverPort` to know when it is safe to disarm the
  // inactivity clock on a stream nobody explicitly tears down.
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  // Resolves once this direction finished normally: the peer's last chunk,
  // without an error, was handed to the consumer, or arrived and the peer
  // then ended its direction (see the watcher below).
  let resolveOver: () => void = () => {};
  const over = new Promise<void>((resolve) => {
    resolveOver = resolve;
  });
  // Set by `onAbort` the instant the signal fires, independent of whether a
  // consumer has started iterating yet. `recieveIterator`'s installer below
  // runs lazily, on the consumer's first `.next()` — if abort fires first,
  // `deliver` is still undefined when `onAbort` runs, so its delivery below
  // is a no-op. Recording the reason here lets the installer catch up and
  // settle the generator immediately instead of leaving it to wait forever
  // for a `deliver` call that already happened before it existed.
  let aborted = false;
  let abortReason: unknown;

  const ready = (): Promise<void> =>
    deliver || finished ? Promise.resolve() : new Promise<void>((r) => waiting.push(r));

  const wake = () => {
    for (const r of waiting.splice(0)) r();
  };

  // A protocol violation fails the stream and closes its port.
  const violate = (message: string): Error => {
    poison = new Error(message);
    // Route through the existing abort machinery instead of duplicating
    // it by hand. `onAbort` below (a) sets `aborted`/`abortReason`, so
    // `recieveIterator`'s installer replays the error even if poison
    // fires before the consumer's first `.next()` — otherwise `deliver`
    // is still undefined here and the local stream hangs forever; and
    // (b) since `controller.signal` is the very signal `sendChunks`
    // passes into `callPort` for *both* directions of this stream,
    // aborting it rejects any outbound call parked at `NO_TIMEOUT` —
    // otherwise `port.close()` below makes that call unsettleable, the
    // pump never returns, the handler's `finally` never runs, and
    // `disarmClockWhenBothSidesSettle` never fires. `onAbort` also
    // resolves `ended`, making a separate call here redundant.
    controller.abort(poison);
    // Close on the next macrotask, so listenPort still gets to post the
    // refusal on this one — a virtual port goes inert the instant it
    // closes, and a silent drop would leave the offender hanging rather
    // than telling it what it did wrong.
    setTimeout(() => {
      try {
        void port.close?.();
      } catch {
        /* already gone */
      }
    }, 0);
    return poison;
  };

  // Where `end` is agreed, the peer's `end` is the other way this direction
  // can be over. This watcher sees the peer's last chunk even once the
  // consumer stopped reading (and the listeners below are gone): an `end`
  // behind a last chunk without an error finishes the input, and one without
  // it is a violation, or the consumer would wait forever for a chunk that
  // cannot come. It stays on the port until that `end`, and it refers to
  // `port` on purpose: the mux holds a port's listeners, so a stream that
  // only waits for the peer's `end` keeps its port, which nothing else of
  // its own may still hold. A close drops it with the other listeners.
  let lastChunkArrived = false;
  let watching = false;
  const watchPeerEnd = (): boolean => {
    if (watching) return true;
    if (!portAgreement(port)?.caps.has("end")) return false;
    watching = true;
    void whenPortEnded(port).then(() => {
      port.removeEventListener("message", watcher);
      if (lastChunkArrived) {
        resolveOver();
        return;
      }
      notice.post();
      violate(
        "webrun-rpc: the peer ended its direction without finishing it; the stream port is closed",
      );
    });
    return true;
  };
  const watcher = (event: MessageEvent): void => {
    const data = event.data as
      | { type?: unknown; channelName?: unknown; chunk?: WireChunk; params?: WireChunk }
      | undefined;
    if (data?.channelName !== channelName) return;
    const chunk =
      data.type === CHUNK ? data.chunk : data.type === "request" ? data.params : undefined;
    if (!chunk) return;
    // The opener learns the agreement from the ack, which comes before any
    // chunk: decided at the first one, and without `end` nothing is watched.
    if (!watchPeerEnd()) {
      port.removeEventListener("message", watcher);
      return;
    }
    if (chunk.done && !chunk.error) lastChunkArrived = true;
  };
  port.addEventListener("message", watcher);
  watchPeerEnd();

  // Bytes of pipelined chunks delivered and not yet consumed (see `onChunk`).
  let held = 0;
  const off = listenPort<WireChunk, void>(
    port,
    async (params) => {
      const { done, error } = params;
      const value = adoptValue(params);
      touch();
      if (poison) throw poison;
      // A confirmed chunk is held outside the pipelined count: one beside
      // pipelined ones would let a peer hold more than the window plus one
      // chunk. An honest sender switches to pipelining once and stays.
      if (held > 0) throw violate(MIXED_MESSAGE);
      if (outstanding) {
        // Spec D15: a second chunk before the first was confirmed is a
        // protocol violation, not a resource question. A count of one needs
        // no threshold and no byte accounting, and it bounds memory by
        // construction: maxPorts x one chunk.
        throw violate(
          "webrun-rpc: peer sent a second unconfirmed chunk; the stream port is closed",
        );
      }
      outstanding = true;
      try {
        await ready();
        if (finished) throw poison ?? new Error("webrun-rpc: the stream is closed");
        await deliver?.({
          done,
          value,
          error: error ? deserializeError(error) : undefined,
        });
        if (done && !error) resolveOver();
      } finally {
        outstanding = false;
      }
      if (done) resolveEnded();
    },
    { channelName },
  );

  // Pipelined chunks: plain messages, held until the consumer pulls past
  // them. The listener's promise settles only then, so the mux returns the
  // window's credit for a chunk once it is consumed, not once it arrived —
  // that is what bounds a stalled reader to one window. A peer that ignores
  // the credit is caught by counting what is held: an honest one never makes
  // it pass the window, so past the window plus this chunk it is refused.
  const onChunk = (event: MessageEvent): Promise<void> | undefined => {
    const data = event.data as
      | { type?: unknown; channelName?: unknown; chunk?: WireChunk }
      | undefined;
    if (data?.type !== CHUNK || data.channelName !== channelName || !data.chunk) return;
    if (poison) return;
    // Agreed is enough here, unlike for sending: the peer pipelines only once
    // the window holds its own sends, and agreeing told it that it may.
    const agreement = portAgreement(port);
    if (!agreement?.caps.has("pipeline")) {
      violate("webrun-rpc: peer sent a pipelined chunk where pipelining was not agreed");
      return;
    }
    if (outstanding) {
      violate(MIXED_MESSAGE);
      return;
    }
    // What is held is counted by its bytes, so it must be bytes.
    if (data.chunk.value !== undefined && !ArrayBuffer.isView(data.chunk.value)) {
      violate("webrun-rpc: peer sent a pipelined chunk whose value is not bytes");
      return;
    }
    if (held > agreement.window) {
      violate(
        `webrun-rpc: peer sent past the window (${agreement.window} bytes) without waiting for credit; the stream port is closed`,
      );
      return;
    }
    touch();
    const { done, error } = data.chunk;
    const value = data.chunk.value && ownBytes(data.chunk.value);
    const size = (value?.byteLength ?? 0) + CHUNK_OVERHEAD;
    held += size;
    return (async () => {
      try {
        await ready();
        if (finished) return;
        await deliver?.({ done, value, error: error ? deserializeError(error) : undefined });
        if (done && !error) resolveOver();
        if (done) resolveEnded();
      } finally {
        held -= size;
      }
    })();
  };
  port.addEventListener("message", onChunk);

  // Every path that stops listening to this channel — the consumer walking
  // away early (`break`/`return`/`throw` on the `for await`), an external
  // `stop()`, or the abort branch below — means no more chunks are coming
  // *as far as this side is concerned*, regardless of what the wire still
  // has in flight. `off()` unregisters the port listener right here, so
  // nothing is left to notice a later wire `done` even if one arrives.
  // `ended` must resolve at the same moment, or `serveDuplexOverPort`'s
  // `Promise.allSettled([pump, inbound.ended])` waits forever for a signal
  // that can no longer come (round-2 fix — this was the dead path: the
  // round-1 version only resolved `ended` from the wire's own `done` chunk
  // or from `onAbort`, missing exactly the "consumer stopped pulling before
  // the wire said done" case, e.g. a handler that reads one chunk and
  // returns).
  const detach = () => {
    finished = true;
    wake();
    off();
    port.removeEventListener("message", onChunk);
    controller.signal.removeEventListener("abort", onAbort);
    resolveEnded();
  };

  const onAbort = () => {
    aborted = true;
    abortReason = controller.signal.reason;
    finished = true;
    wake();
    // No-op if the consumer hasn't started iterating yet — `deliver` is only
    // assigned inside the installer below. That ordering is exactly what the
    // `aborted` check in the installer exists to catch.
    void deliver?.({ done: true, error: abortReason });
    resolveEnded();
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const stream = recieveIterator<Uint8Array>((d) => {
    if (aborted) {
      // The signal already fired before this installer ran. `onAbort`'s
      // delivery above was a no-op because `deliver` didn't exist yet — settle
      // the generator immediately instead of registering `deliver` and
      // waiting for a chunk that will never arrive.
      void d({ done: true, error: abortReason });
      return detach;
    }
    deliver = d;
    wake();
    return detach;
  });

  return {
    stream,
    stop: detach,
    ended,
    over,
  };
}

/**
 * The sending half of one direction: one `callPort` per chunk, one call
 * outstanding at a time (spec D11/D12), with no per-chunk deadline (spec D8) —
 * or, once pipelining is agreed, plain chunk messages held back by the window.
 * `onSent` runs once the end of the output has left without an error: posted
 * when pipelined, confirmed when not.
 */
async function sendChunks(
  port: MessageTarget,
  channelName: string,
  output: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  { maxMessageSize, log }: DuplexOverPortOptions,
  signal: AbortSignal,
  touch: () => void,
  onSent: () => void,
): Promise<void> {
  const framed = maxMessageSize ? toChunks(maxMessageSize)(output) : output;
  const stream = throughAbort(framed, signal);
  // `throughAbort` returns `framed`; when chunking wraps the output, that
  // `return()` is queued behind the chunker's pending `next()`, so the abort
  // would reach the producer only once it yields. Return the producer itself.
  const producer = output as Partial<AsyncIterator<Uint8Array>>;
  const returnProducer = () => void Promise.resolve(producer.return?.()).catch(() => {});
  if (framed !== output) signal.addEventListener("abort", returnProducer, { once: true });
  // A pipelined sender waits only for room in the window, or for the abort.
  let onAborted = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAborted = () => resolve();
  });
  if (signal.aborted) onAborted();
  else signal.addEventListener("abort", onAborted, { once: true });
  try {
    await sendIterator<Uint8Array>(async ({ done, value, error }) => {
      if (signal.aborted) return;
      const chunk: WireChunk = {
        done,
        value: done ? value : chunkBytes(value),
        error: error === undefined ? undefined : serializeError(error),
      };
      log?.("[duplexOverPort] send", { channelName, done, size: value?.byteLength });
      // Decided per chunk: acknowledged calls until `pipeline` is agreed (the
      // opener learns it from the ack), plain messages from then on.
      if (mayPipeline(port)) {
        port.postMessage({ type: CHUNK, channelName, chunk });
        touch();
        if (done && !error) onSent();
        if (portBufferedAmount(port) > 0) await Promise.race([whenPortReady(port), aborted]);
        return;
      }
      await callPort<void, WireChunk>(port, chunk, {
        channelName,
        timeout: NO_TIMEOUT,
        signal,
      });
      touch();
      if (done && !error) onSent();
    }, stream);
  } catch (err) {
    // An abort is the expected way this ends when the local side walks away;
    // anything else is a genuine transport failure worth surfacing.
    if (signal.aborted) return;
    throw err;
  } finally {
    signal.removeEventListener("abort", returnProducer);
    signal.removeEventListener("abort", onAborted);
  }
}
