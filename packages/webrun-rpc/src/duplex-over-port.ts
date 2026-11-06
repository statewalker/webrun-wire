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
import { portAgreement, portBufferedAmount, whenPortReady } from "./port-credit.js";
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

/** PROTOTYPE H-1: a chunk posted as a plain port message, confirmed by the window's credit. */
const CHUNK = "webrun-rpc:chunk";
/** PROTOTYPE capability names. */
export const CAP_PIPELINE_MSG = "pipeline-msg";
export const CAP_PIPELINE_CALL = "pipeline-call";
const agreed = (port: MessageTarget, cap: string): boolean => {
  const a = portAgreement(port);
  return !!a?.enforced && a.caps.includes(cap);
};
const hasCap = (port: MessageTarget, cap: string): boolean =>
  !!portAgreement(port)?.caps.includes(cap);

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
 * `listenPort` withholds it until then.
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
  const inbound = receiveChunks(port, CHANNEL_IN, controller, clock.touch);
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
    );
    void pump.catch(() => {});
    disarmClockWhenBothSidesSettle(clock, pump, inbound.ended);
    return teardownOnce(controller, notice, clock, inbound, undefined);
  }
  const pump = sendChunks(port, CHANNEL_OUT, output, options, controller.signal, clock.touch);
  void pump.catch(() => {
    // Reported to the peer inside sendChunks; nothing to surface locally.
  });
  disarmClockWhenBothSidesSettle(clock, pump, inbound.ended);
  return teardownOnce(controller, notice, clock, inbound, output);
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
  const inbound = receiveChunks(port, CHANNEL_OUT, controller, clock.touch);
  const pump = sendChunks(port, CHANNEL_IN, input, options, controller.signal, clock.touch);
  void pump.catch(() => {
    // The outbound half's failure surfaces to the peer, not to this consumer:
    // the consumer's contract is the inbound half.
  });

  const stream = (async function* () {
    try {
      yield* inbound.stream;
    } finally {
      // Abort BEFORE awaiting the pump. `callPort` runs with NO_TIMEOUT here,
      // so an un-aborted in-flight chunk call would never settle and this
      // `finally` would deadlock — which is exactly the defect found in the
      // -webrtc adapter, where the outbound half was awaited unconditionally.
      if (!controller.signal.aborted) {
        controller.abort(new Error("webrun-rpc: the caller abandoned the stream"));
      }
      notice.post();
      notice.stop();
      clock.stop();
      inbound.stop();
      await pump.catch(() => {});
      try {
        await port.close?.();
      } catch {
        /* the port may already be gone; nothing to unwind */
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
): { stream: AsyncGenerator<Uint8Array>; stop(): void; ended: Promise<void> } {
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

  const off = listenPort<WireChunk, void>(
    port,
    async ({ done, value, error }) => {
      touch();
      if (poison) throw poison;
      if (outstanding && !hasCap(port, CAP_PIPELINE_CALL)) {
        // Spec D15: a second chunk before the first was confirmed is a
        // protocol violation, not a resource question. A count of one needs
        // no threshold and no byte accounting, and it bounds memory by
        // construction: maxPorts x one chunk.
        poison = new Error(
          "webrun-rpc: peer sent a second unconfirmed chunk; the stream port is closed",
        );
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
        throw poison;
      }
      outstanding = true;
      try {
        // PROTOTYPE H-2: with pipelined calls several handlers wait here at
        // once; `ready()` and `deliver` keep them in arrival order.
        await ready();
        if (finished) throw poison ?? new Error("webrun-rpc: the stream is closed");
        await deliver?.({
          done,
          value,
          error: error ? deserializeError(error) : undefined,
        });
      } finally {
        outstanding = false;
      }
      if (done) resolveEnded();
    },
    { channelName },
  );

  // PROTOTYPE H-1: chunks as plain messages. The listener's promise settles
  // when the consumer pulls past the chunk, so the mux grants the window's
  // credit only then: the credit is the confirmation.
  const onChunk = (event: MessageEvent): Promise<void> | undefined => {
    const data = event.data as { type?: unknown; channelName?: unknown; chunk?: WireChunk };
    if (!data || data.type !== CHUNK || data.channelName !== channelName || !data.chunk) return;
    const { done, value, error } = data.chunk;
    touch();
    return (async () => {
      await ready();
      if (finished) return;
      await deliver?.({ done, value, error: error ? deserializeError(error) : undefined });
      if (done) resolveEnded();
    })();
  };
  port.addEventListener("message", onChunk as (e: MessageEvent) => void);
  const offRaw = () => port.removeEventListener("message", onChunk as (e: MessageEvent) => void);

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
    offRaw();
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
  };
}

/**
 * The sending half of one direction: one `callPort` per chunk, one call
 * outstanding at a time (spec D11/D12), with no per-chunk deadline (spec D8).
 */
async function sendChunks(
  port: MessageTarget,
  channelName: string,
  output: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  { maxMessageSize, log }: DuplexOverPortOptions,
  signal: AbortSignal,
  touch: () => void,
): Promise<void> {
  const framed = maxMessageSize ? toChunks(maxMessageSize)(output) : output;
  const stream = throughAbort(framed, signal);
  // `throughAbort` returns `framed`; when chunking wraps the output, that
  // `return()` is queued behind the chunker's pending `next()`, so the abort
  // would reach the producer only once it yields. Return the producer itself.
  const producer = output as Partial<AsyncIterator<Uint8Array>>;
  const returnProducer = () => void Promise.resolve(producer.return?.()).catch(() => {});
  if (framed !== output) signal.addEventListener("abort", returnProducer, { once: true });
  // PROTOTYPE H-2 (attempt 2): one reply listener for all calls in flight,
  // not one per `callPort` — with N calls in flight every reply would
  // otherwise be dispatched to N listeners.
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  let seq = 0;
  const onReply = (event: MessageEvent) => {
    const d = event.data as {
      type?: string;
      channelName?: string;
      callId?: string;
      error?: SerializedError;
    };
    if (!d || d.channelName !== channelName || typeof d.callId !== "string") return;
    const p = pending.get(d.callId);
    if (!p) return;
    pending.delete(d.callId);
    if (d.type === "response:error") p.reject(deserializeError(d.error as SerializedError));
    else if (d.type === "response:result") p.resolve();
  };
  const onAbortAll = () => {
    for (const p of pending.values()) p.reject(signal.reason);
    pending.clear();
  };
  const callPipelined = (chunk: WireChunk): Promise<void> => {
    if (pending.size === 0 && seq === 0) {
      port.addEventListener("message", onReply);
      signal.addEventListener("abort", onAbortAll, { once: true });
    }
    const callId = `p-${channelName}-${seq++}`;
    const promise = new Promise<void>((resolve, reject) =>
      pending.set(callId, { resolve, reject }),
    );
    port.postMessage({ type: "request", channelName, callId, params: chunk });
    return promise;
  };
  // PROTOTYPE H-2: calls in flight, and the bytes they carry.
  const inFlight: Array<{ size: number; reply: Promise<void> }> = [];
  let inFlightBytes = 0;
  let failure: unknown;
  try {
    await sendIterator<Uint8Array>(async ({ done, value, error }) => {
      if (signal.aborted) return;
      if (failure) throw failure;
      const chunk: WireChunk = {
        done,
        value,
        error: error === undefined ? undefined : serializeError(error),
      };
      log?.("[duplexOverPort] send", { channelName, done, size: value?.byteLength });
      if (agreed(port, CAP_PIPELINE_MSG)) {
        // H-1: post and go on; only the window holds us back.
        port.postMessage({ type: CHUNK, channelName, chunk });
        touch();
        if (portBufferedAmount(port) > 0) await whenPortReady(port);
        return;
      }
      if (agreed(port, CAP_PIPELINE_CALL) && !done) {
        // H-2: keep up to a window of calls unreplied. `listenPort` counts a
        // request consumed at its handler's entry, so the window's credit
        // alone would not bound them: the sender counts its own.
        // biome-ignore lint/style/noNonNullAssertion: agreed() checked it.
        const window = portAgreement(port)!.window;
        const size = (value?.byteLength ?? 0) + 64;
        const reply = callPipelined(chunk).then(
          () => {
            inFlightBytes -= size;
            touch();
          },
          (err) => {
            failure ??= err;
          },
        );
        inFlight.push({ size, reply });
        inFlightBytes += size;
        while (inFlightBytes > window && inFlight.length) await inFlight.shift()?.reply;
        if (portBufferedAmount(port) > 0) await whenPortReady(port);
        return;
      }
      // Drain what is in flight before a confirmed chunk (the last one, or a
      // port with nothing agreed).
      for (const f of inFlight.splice(0)) await f.reply;
      if (failure) throw failure;
      await callPort<void, WireChunk>(port, chunk, {
        channelName,
        timeout: NO_TIMEOUT,
        signal,
      });
      touch();
    }, stream);
  } catch (err) {
    // An abort is the expected way this ends when the local side walks away;
    // anything else is a genuine transport failure worth surfacing.
    if (signal.aborted) return;
    throw err;
  } finally {
    signal.removeEventListener("abort", returnProducer);
    port.removeEventListener("message", onReply);
    signal.removeEventListener("abort", onAbortAll);
  }
}
