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
import { listenPort } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";
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
  const clock = installStreamTimeout(controller, options.timeout);
  const inbound = receiveChunks(port, CHANNEL_IN, controller, clock.touch);
  let output: AsyncGenerator<Uint8Array>;
  try {
    output = handler(inbound.stream);
  } catch (err) {
    // A handler that throws before returning a generator still owes the peer
    // an end-of-stream, or its `callPort` never settles.
    void sendChunks(port, CHANNEL_OUT, failing(err), options, controller.signal, clock.touch).catch(
      () => {},
    );
    return teardownOnce(controller, notice, clock, inbound, undefined);
  }
  const pump = sendChunks(port, CHANNEL_OUT, output, options, controller.signal, clock.touch);
  void pump.catch(() => {
    // Reported to the peer inside sendChunks; nothing to surface locally.
  });
  return teardownOnce(controller, notice, clock, inbound, output);
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
  const clock = installStreamTimeout(controller, options.timeout);
  const inbound = receiveChunks(port, CHANNEL_OUT, controller, clock.touch);
  const pump = sendChunks(port, CHANNEL_IN, input, options, controller.signal, clock.touch);
  void pump.catch(() => {
    // The outbound half's failure surfaces to the peer, not to this consumer:
    // the consumer's contract is the inbound half.
  });

  return (async function* () {
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
      if (timer !== undefined) clearTimeout(timer);
      arm();
    },
    stop() {
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
): { stream: AsyncGenerator<Uint8Array>; stop(): void } {
  let deliver: ChunkReceiver<Uint8Array> | undefined;
  const waiting: Array<() => void> = [];
  let finished = false;
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
      await ready();
      if (finished) throw new Error("webrun-rpc: the stream is closed");
      await deliver?.({
        done,
        value,
        error: error ? deserializeError(error) : undefined,
      });
    },
    { channelName },
  );

  const onAbort = () => {
    aborted = true;
    abortReason = controller.signal.reason;
    finished = true;
    wake();
    // No-op if the consumer hasn't started iterating yet — `deliver` is only
    // assigned inside the installer below. That ordering is exactly what the
    // `aborted` check in the installer exists to catch.
    void deliver?.({ done: true, error: abortReason });
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const stream = recieveIterator<Uint8Array>((d) => {
    if (aborted) {
      // The signal already fired before this installer ran. `onAbort`'s
      // delivery above was a no-op because `deliver` didn't exist yet — settle
      // the generator immediately instead of registering `deliver` and
      // waiting for a chunk that will never arrive.
      void d({ done: true, error: abortReason });
      return () => {
        finished = true;
        wake();
        off();
        controller.signal.removeEventListener("abort", onAbort);
      };
    }
    deliver = d;
    wake();
    return () => {
      finished = true;
      wake();
      off();
      controller.signal.removeEventListener("abort", onAbort);
    };
  });

  return {
    stream,
    stop() {
      finished = true;
      wake();
      off();
      controller.signal.removeEventListener("abort", onAbort);
    },
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
  try {
    await sendIterator<Uint8Array>(async ({ done, value, error }) => {
      if (signal.aborted) return;
      const chunk: WireChunk = {
        done,
        value,
        error: error === undefined ? undefined : serializeError(error),
      };
      log?.("[duplexOverPort] send", { channelName, done, size: value?.byteLength });
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
  }
}
