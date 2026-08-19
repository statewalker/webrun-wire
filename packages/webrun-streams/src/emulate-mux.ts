import { deserializeError, serializeError } from "./errors.js";

/**
 * Canonical seam for the webrun-streams transport family. A `Duplex` carries
 * one logical call: caller emits an iterable of bytes as input, peer yields an
 * async generator of bytes as output. Same shape on both sides — an in-process
 * test can wire `const caller = handler` and run without any transport.
 *
 * Iterator semantics carry every signal:
 *  - Consumer `.return()` on the output → producer's `finally` runs.
 *  - Producer `throw` → consumer's `for await` throws.
 *  - Normal exhaustion on either side → matching end on the other side.
 */
export type Duplex = (
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
) => AsyncGenerator<Uint8Array>;

/**
 * Adapter-side factory that stands up a transport connection and yields a
 * caller `Duplex`. One `Connect` invocation owns one transport; each call
 * to the resolved `call` opens a new sub-stream on it.
 *
 * A caller must either drain the returned generator or `.return()` it.
 * Dropping the reference without doing either emits no observable signal:
 * the abandoned consumer never acknowledges inbound data, so the peer's
 * outbound pump blocks awaiting that acknowledgement, no end-of-stream is
 * ever exchanged, and both peers hold the stream's slot open. There is no
 * way for the transport to detect this — an unreferenced generator is not
 * observable — so it is the consumer's obligation.
 */
export type Connect<P> = (params: P) => Promise<{
  call: Duplex;
  close: () => Promise<void>;
}>;

/**
 * Adapter-side factory that registers a handler `Duplex` against a transport.
 * Returns an idempotent teardown.
 */
export type Serve<P> = (params: P, handler: Duplex) => Promise<() => Promise<void>>;

/**
 * The minimum a transport must expose to be wrapped by `emulateMux`. Inbound
 * bytes are surfaced as an async iterable; outbound is imperative `send`. All
 * five message-oriented transports (WebSocket, LiveKit data channel, PeerJS
 * DataConnection, MessagePort, in-process pipe) match this shape after a thin
 * wrapper.
 */
export type ByteChannel = {
  send(bytes: Uint8Array): void;
  recv: AsyncIterable<Uint8Array>;
  closed: Promise<void>;
  close(): void;
};

/**
 * Thrown by `emulateMux` and adapters when the underlying transport closes
 * while one or more `Duplex` calls are in flight. Consumers can catch by
 * `instanceof TransportClosedError` or by checking `error.name`.
 */
export class TransportClosedError extends Error {
  override readonly name = "TransportClosedError";
  constructor(message = "transport closed") {
    super(message);
  }
}

const TYPE_OPEN = 0x01;
const TYPE_DATA = 0x02;
const TYPE_ACK = 0x03;
const TYPE_END = 0x04;
const TYPE_ERROR = 0x05;
const TYPE_CLOSE = 0x06;

const DEFAULT_MAX_STREAMS = 256;
const DEFAULT_MTU = 64 * 1024;
const DEFAULT_MAX_STREAM_BUFFER = 8 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface Stream {
  id: number;
  inbound: AsyncGenerator<Uint8Array>;
  pushIn: (chunk: Uint8Array) => Promise<boolean>;
  doneIn: (err?: Error) => Promise<boolean>;
  resolveAck: (() => void) | null;
  rejectAck: ((err: Error) => void) | null;
  closed: boolean;
  /** Peer sent END (or the stream was torn down): nothing more arrives. */
  inDone: boolean;
  /** Our outbound pump sent END: nothing more will be sent. */
  outDone: boolean;
  /** Inbound bytes pushed but not yet taken by the consumer. */
  queuedBytes: number;
}

export interface EmulateMuxOptions {
  maxStreams?: number;
  mtu?: number;
  /**
   * Cap on inbound bytes one stream may hold for a consumer that has not
   * drained them. Exceeding it tears down that stream alone.
   */
  maxStreamBuffer?: number;
  /**
   * Stream-id allocation side. Initiator uses even ids (2, 4, …); responder
   * uses odd ids (1, 3, …). Pick one per peer so allocations don't collide.
   */
  side?: "initiator" | "responder";
}

export function emulateMux(
  channel: ByteChannel,
  opts: EmulateMuxOptions = {},
): {
  call: Duplex;
  serve: (handler: Duplex) => () => Promise<void>;
  close: () => Promise<void>;
} {
  const maxStreams = opts.maxStreams ?? DEFAULT_MAX_STREAMS;
  const mtu = opts.mtu ?? DEFAULT_MTU;
  const maxStreamBuffer = opts.maxStreamBuffer ?? DEFAULT_MAX_STREAM_BUFFER;
  const side = opts.side ?? "initiator";

  const streams = new Map<number, Stream>();
  let nextLocalId = side === "initiator" ? 2 : 1;
  let handler: Duplex | null = null;
  let muxClosed = false;

  const sendFrame = (id: number, type: number, payload?: Uint8Array): void => {
    if (muxClosed) return;
    const idEnc = encodeVarint(id);
    const total = idEnc.length + 1 + (payload?.byteLength ?? 0);
    const frame = new Uint8Array(total);
    frame.set(idEnc, 0);
    frame[idEnc.length] = type;
    if (payload && payload.byteLength > 0) frame.set(payload, idEnc.length + 1);
    try {
      channel.send(frame);
    } catch {
      /* underlying transport closed; inbound loop will detect */
    }
  };

  const teardownStream = (s: Stream, err?: Error): void => {
    if (s.closed) return;
    s.closed = true;
    const resolve = s.resolveAck;
    const reject = s.rejectAck;
    s.resolveAck = null;
    s.rejectAck = null;
    if (reject && err) reject(err);
    else resolve?.();
    void s.doneIn(err);
    streams.delete(s.id);
  };

  /**
   * Graceful counterpart to `teardownStream`. A stream occupies a slot in
   * `streams` until BOTH directions finish; releasing on inbound END alone
   * would set `closed` while our own `pumpOutbound` is still sending, and it
   * checks that flag to decide whether to keep going.
   *
   * Without this, only abnormal endings (cancel, ERROR, CLOSE, transport
   * failure) ever freed a slot, so every normally-completed call leaked one
   * until `maxStreams` began rejecting new calls.
   */
  const releaseIfComplete = (s: Stream): void => {
    if (s.closed || !s.inDone || !s.outDone) return;
    s.closed = true;
    streams.delete(s.id);
  };

  const failAll = (err: Error): void => {
    if (muxClosed) return;
    muxClosed = true;
    for (const s of [...streams.values()]) teardownStream(s, err);
    streams.clear();
  };

  const createStream = (id: number): Stream => {
    const queue = makeInboundQueue();
    const state: Stream = {
      id,
      inbound: queue.generator(() => {
        if (!state.closed && !muxClosed) sendFrame(state.id, TYPE_CLOSE);
        teardownStream(state);
      }),
      pushIn: queue.push,
      doneIn: queue.done,
      resolveAck: null,
      rejectAck: null,
      closed: false,
      inDone: false,
      outDone: false,
      queuedBytes: 0,
    };
    return state;
  };

  const pumpOutbound = async (
    s: Stream,
    input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> => {
    try {
      for await (const chunk of input) {
        if (s.closed || muxClosed) return;
        if (chunk.byteLength === 0) continue;
        let off = 0;
        while (off < chunk.byteLength) {
          if (s.closed || muxClosed) return;
          const end = Math.min(off + mtu, chunk.byteLength);
          const piece = chunk.subarray(off, end);
          sendFrame(s.id, TYPE_DATA, piece);
          await new Promise<void>((resolve, reject) => {
            s.resolveAck = resolve;
            s.rejectAck = reject;
          });
          off = end;
        }
      }
      if (!s.closed && !muxClosed) {
        sendFrame(s.id, TYPE_END);
        s.outDone = true;
        releaseIfComplete(s);
      }
    } catch (err) {
      if (!s.closed && !muxClosed) {
        const e = err instanceof Error ? err : new Error(String(err));
        sendFrame(s.id, TYPE_ERROR, encodeError(e));
        teardownStream(s, e);
      }
    }
  };

  const runHandler = async (s: Stream, h: Duplex): Promise<void> => {
    let outbound: AsyncGenerator<Uint8Array>;
    try {
      outbound = h(s.inbound);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      sendFrame(s.id, TYPE_ERROR, encodeError(e));
      teardownStream(s, e);
      return;
    }
    await pumpOutbound(s, outbound);
    // The response is complete. If the handler never consumed the request
    // body, nothing will ever drain the inbound queue, so no ACK is sent, the
    // caller's pump parks forever awaiting one, and neither peer frees the
    // slot — while the caller's `for await` completes normally, so nothing
    // looks wrong from user code. Tell the peer we no longer want the body.
    //
    // This is why a handler must consume `input` within its generator's
    // lifetime: draining it from a detached task is indistinguishable, from
    // here, from not draining it at all.
    if (!s.inDone && !s.closed && !muxClosed) {
      sendFrame(s.id, TYPE_CLOSE);
      teardownStream(s);
    }
  };

  const handleFrame = (frame: Uint8Array): void => {
    if (muxClosed) return;
    if (frame.byteLength < 2) return;

    // The id is the one field parsed from untrusted bytes before we know which
    // stream a frame belongs to, and decodeVarint throws on a truncated or
    // over-long encoding. Left unguarded that exception escapes handleFrame,
    // reaches the inbound loop's catch, and calls failAll — so a single
    // malformed frame tears down every stream on the connection.
    //
    // A ByteChannel is message-oriented, so frames are discrete and a corrupt
    // one cannot desync the next. Dropping it is therefore safe, and is what
    // keeps one bad frame from becoming a denial of service against every
    // healthy stream sharing the mux.
    let id: number;
    let offset: number;
    try {
      ({ value: id, offset } = decodeVarint(frame, 0));
    } catch {
      return;
    }
    if (offset >= frame.byteLength) return; // id consumed the whole frame: no type byte
    const type = frame[offset];
    const payload = frame.subarray(offset + 1);

    if (type === TYPE_OPEN) {
      // A duplicate OPEN for a LIVE stream is ignored. A replay of one that
      // already finished is deliberately not guarded: every transport here is
      // ordered and reliable, so a replay cannot occur by accident, and a
      // hostile peer gains nothing by it — opening a fresh id invokes the same
      // handler just as well. An earlier monotonic high-water mark did guard
      // it, at the cost of letting one OPEN with a high id permanently refuse
      // every later stream, including that peer's own legitimate traffic.
      if (streams.has(id)) return;
      if (streams.size >= maxStreams) {
        sendFrame(
          id,
          TYPE_ERROR,
          encodeError(new RangeError(`emulateMux: maxStreams=${maxStreams} exceeded`)),
        );
        return;
      }
      if (!handler) {
        sendFrame(id, TYPE_ERROR, encodeError(new Error("emulateMux: no handler registered")));
        return;
      }
      const s = createStream(id);
      streams.set(id, s);
      void runHandler(s, handler);
      return;
    }

    const s = streams.get(id);
    if (!s) return;

    switch (type) {
      case TYPE_DATA: {
        // Flow control is the peer holding one in-flight DATA per stream and
        // waiting for its ACK — voluntary, and a hostile peer simply does not.
        // Pushes are fire-and-forget by necessity (see the comment below), so
        // nothing else bounds this queue: a peer that floods DATA at a handler
        // which has not started draining retains every payload. Refuse past a
        // per-stream cap and tear down THAT stream, never the whole mux.
        s.queuedBytes += payload.byteLength;
        if (s.queuedBytes > maxStreamBuffer) {
          const err = new RangeError(
            `emulateMux: stream ${id} buffered ${s.queuedBytes} bytes past maxStreamBuffer=${maxStreamBuffer} without being drained`,
          );
          sendFrame(id, TYPE_ERROR, encodeError(err));
          teardownStream(s, err);
          return;
        }
        const copy = payload.byteLength === 0 ? payload : new Uint8Array(payload);
        // Push fire-and-forget; ACK after the consumer drains. The inbound
        // loop must NOT block on consumer drainage — peer holds one in-flight
        // DATA per stream and waits for ACK, so blocking here causes a
        // cross-direction deadlock where ACK frames can't be processed.
        void s.pushIn(copy).then((handled) => {
          s.queuedBytes -= copy.byteLength;
          if (handled && !s.closed && !muxClosed) sendFrame(id, TYPE_ACK);
        });
        return;
      }
      case TYPE_ACK: {
        const r = s.resolveAck;
        s.resolveAck = null;
        s.rejectAck = null;
        r?.();
        return;
      }
      case TYPE_END: {
        s.inDone = true;
        void s.doneIn();
        releaseIfComplete(s);
        return;
      }
      case TYPE_ERROR: {
        teardownStream(s, decodeError(payload));
        return;
      }
      case TYPE_CLOSE: {
        teardownStream(s);
        return;
      }
      default:
        return;
    }
  };

  // Inbound consumer
  void (async () => {
    try {
      for await (const frame of channel.recv) {
        if (muxClosed) break;
        handleFrame(frame);
      }
    } catch (err) {
      failAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    failAll(new TransportClosedError());
  })();

  void channel.closed.then(() => failAll(new TransportClosedError())).catch(() => {});

  const call: Duplex = (input) => {
    if (muxClosed) return failedGenerator(new TransportClosedError());
    if (streams.size >= maxStreams) {
      return failedGenerator(new RangeError(`emulateMux: maxStreams=${maxStreams} exceeded`));
    }
    const id = nextLocalId;
    nextLocalId += 2;
    const s = createStream(id);
    streams.set(id, s);
    sendFrame(id, TYPE_OPEN);
    void pumpOutbound(s, input);
    return s.inbound;
  };

  const serve = (h: Duplex): (() => Promise<void>) => {
    handler = h;
    let torn = false;
    return async () => {
      if (torn) return;
      torn = true;
      if (handler === h) handler = null;
    };
  };

  const close = async (): Promise<void> => {
    if (muxClosed) return;
    failAll(new TransportClosedError());
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  };

  return { call, serve, close };
}

function failedGenerator(err: Error): AsyncGenerator<Uint8Array> {
  return (async function* () {
    if ((0 as number) === 0) throw err;
    yield new Uint8Array(0);
  })();
}

/**
 * Push/pull queue with eager push/done handles. Unlike `newAsyncGenerator`, the
 * push and done functions are usable *before* the consumer begins iterating —
 * `emulateMux` needs to enqueue frames from inbound traffic regardless of when
 * (or whether) the consumer pulls them.
 *
 * `onCancel` fires only when the consumer terminates the generator before
 * `done()` was called — i.e., a unilateral cancellation. If `done()` is
 * called first (peer END/ERROR/CLOSE), the generator ends naturally and
 * `onCancel` does not fire.
 */
function makeInboundQueue(): {
  generator: (onCancel: () => void) => AsyncGenerator<Uint8Array>;
  push: (chunk: Uint8Array) => Promise<boolean>;
  done: (err?: Error) => Promise<boolean>;
} {
  type Slot =
    | { type: "value"; value: Uint8Array; resolve: (v: boolean) => void }
    | { type: "done"; err?: Error; resolve: (v: boolean) => void };
  const slots: Slot[] = [];
  let wake: (() => void) | null = null;
  let queueClosed = false;
  let doneCalled = false;

  const push = (chunk: Uint8Array): Promise<boolean> => {
    if (queueClosed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      slots.push({ type: "value", value: chunk, resolve });
      wake?.();
    });
  };

  const done = (err?: Error): Promise<boolean> => {
    if (queueClosed || doneCalled) return Promise.resolve(false);
    doneCalled = true;
    return new Promise<boolean>((resolve) => {
      slots.push({ type: "done", err, resolve });
      wake?.();
    });
  };

  async function* generator(onCancel: () => void): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        if (slots.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
          continue;
        }
        const slot = slots.shift() as Slot;
        if (slot.type === "done") {
          slot.resolve(true);
          if (slot.err) throw slot.err;
          return;
        }
        yield slot.value;
        slot.resolve(true);
      }
    } finally {
      queueClosed = true;
      for (const s of slots) s.resolve(false);
      slots.length = 0;
      if (!doneCalled) onCancel();
    }
  }

  return { generator, push, done };
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`encodeVarint: ${value} is not a non-negative integer`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function decodeVarint(buf: Uint8Array, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, offset: i };
    shift += 7;
    if (shift > 28) throw new Error("decodeVarint: too long");
  }
  throw new Error("decodeVarint: truncated");
}

function encodeError(err: Error): Uint8Array {
  return textEncoder.encode(JSON.stringify(serializeError(err)));
}

function decodeError(buf: Uint8Array): Error {
  if (buf.byteLength === 0) return new Error("unknown stream error");
  try {
    return deserializeError(JSON.parse(textDecoder.decode(buf)));
  } catch {
    return new Error(textDecoder.decode(buf));
  }
}
