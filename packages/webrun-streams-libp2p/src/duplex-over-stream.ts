import type { Stream, StreamCloseEvent } from "@libp2p/interface";
import { deserializeError, serializeError } from "@statewalker/webrun-streams";

const TYPE_DATA = 0x00;
const TYPE_ERROR = 0x02;

/**
 * Default bound for {@link waitForDrain}'s wait for the peer to make room in
 * its receive window. Without a bound, a peer that requests something and then
 * simply stops reading — alive, so no `close` event ever fires — parks the
 * serving side's outbound pump forever, holding the stream, the handler and
 * whatever the handler buffered. On the serving side there is no escape hatch:
 * `connect`'s `.return`/abort override is a *caller*-side affordance.
 *
 * The number is deliberately generous, because a bound that is too tight
 * resets a slow-but-alive peer mid-transfer — exactly what backpressure exists
 * to avoid. Five minutes covers a peer draining a full yamux receive window
 * (256 KiB by default) at under 1 KiB/s, i.e. slower than any link on which
 * the transfer would complete anyway; a peer slower than that is
 * indistinguishable from one that has stopped reading altogether. Override via
 * `drainTimeoutMs` when a deployment knows better.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 300_000;

/**
 * Default bound for {@link closeStream}'s wait for a graceful close.
 *
 * WHY THIS IS MINUTES AND NOT SECONDS. `stream.close()` waits for the write
 * queue to DRAIN, and that queue is shared with every other stream on the same
 * muxer. Draining one stream is therefore not a function of that stream alone:
 * with many concurrent transfers it legitimately takes far longer than it would
 * in isolation. When the bound trips, {@link closeStream} falls back to
 * `abort()`, which resets the stream and truncates whatever was still in
 * flight — so a bound tuned for an idle link silently corrupts healthy
 * transfers under load.
 *
 * It did. This was 5000ms, matching libp2p 2.x's `DEFAULT_SEND_CLOSE_WRITE_TIMEOUT`
 * — a number adopted for fidelity rather than reasoned about. Eighteen
 * concurrent 3.5 MB fetches over one connection produced five complete
 * responses out of twenty-two; the rest arrived truncated and rendered as
 * broken images, with nothing but this module's own warning to say why.
 *
 * The bound's actual purpose is to catch a peer that has stopped reading and
 * will never close, so the caller is not parked forever. Minutes serve that
 * purpose exactly as well as seconds, and match {@link DEFAULT_DRAIN_TIMEOUT_MS},
 * whose comment reasons about the identical hazard: *"a bound that is too tight
 * resets a slow-but-alive peer mid-transfer — exactly what backpressure exists
 * to avoid."* The two guard the same thing and should not disagree by a factor
 * of sixty.
 *
 * Exported so a deployment that knows its links can lower it deliberately.
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = DEFAULT_DRAIN_TIMEOUT_MS;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Options for {@link duplexOverStream}. The `onPeerInputEnd` hook is the seam
 * that lets the server side close its input queue as soon as the peer's source
 * exhausts — without it, the server-side `serve` would deadlock waiting for the
 * outbound pump to finish, which itself waits for the handler, which waits for
 * inputQueue.done.
 */
export interface DuplexOverStreamOptions {
  /**
   * Fired when the peer's source ends (peer closed write, sent an ERROR frame,
   * or the stream itself was torn down). Idempotent. The optional `err`
   * argument carries the deserialized error from an ERROR frame, if any.
   */
  onPeerInputEnd?(err?: Error): void;
  /**
   * Fired only when the peer's source ended naturally — i.e., consumer did not
   * `.return()` mid-stream. Connect/serve uses this to decide whether to
   * gracefully close vs forcibly abort the underlying stream on teardown.
   */
  onSourceCompleted?(): void;
  /**
   * How long to wait for a backpressured stream to drain before giving up on
   * the peer. Defaults to {@link DEFAULT_DRAIN_TIMEOUT_MS}.
   */
  drainTimeoutMs?: number;
}

/**
 * Drive one `Duplex` over one libp2p `Stream` using a small in-band framing
 * protocol:
 *
 *     [1-byte type][varint length][payload bytes]
 *
 * Types are `DATA` (0x00, body bytes) and `ERROR` (0x02, followed by a
 * JSON-serialised `Error`). Normal end-of-input is signalled by libp2p's
 * `close()`. The frame layer exists so we can preserve `Error` fidelity
 * across the wire (yamux's native stream reset only carries "stream reset").
 */
export async function* duplexOverStream(
  stream: Stream,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  opts: DuplexOverStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  let peerEndedCalled = false;
  const firePeerInputEnd = (err?: Error): void => {
    if (peerEndedCalled) return;
    peerEndedCalled = true;
    opts.onPeerInputEnd?.(err);
  };

  // Acquire the producer's iterator ONCE, so teardown can cancel the producer
  // itself rather than the wrapper around it — see `framedOutbound`.
  const inputIterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> =
    (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]?.() ??
    (input as Iterable<Uint8Array>)[Symbol.iterator]();
  const cancelInput = (): void => {
    void Promise.resolve((inputIterator as AsyncIterator<Uint8Array>).return?.(undefined)).catch(
      () => undefined,
    );
  };

  const outboundSource = framedOutbound(inputIterator);
  const outbound = (async () => {
    try {
      // libp2p 3.x streams are push-based (`send()` + drain) rather than
      // the pull-based `sink(AsyncIterable)` of 2.x, so we pump the framed
      // outbound generator by hand and honour backpressure by waiting for
      // the stream's `'drain'` event whenever `send()` reports its buffer
      // is full. We deliberately do NOT use `stream.onDrain()`: it
      // memoises a single promise for the stream's whole lifetime and
      // never clears it (`@libp2p/utils@7.3.2/dist/src/abstract-message-stream.js`),
      // so past the first backpressure cycle it resolves instantly while
      // the buffer is still full, defeating flow control entirely.
      for await (const chunk of outboundSource) {
        const canAcceptMore = stream.send(chunk);
        if (!canAcceptMore) {
          await waitForDrain(stream, opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
        }
      }
      await closeStream(stream);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        stream.abort(e);
      } catch {
        /* ignore */
      }
    } finally {
      // Always return the framed-outbound generator so its `input` (often a
      // handler async generator) sees `.return()` and runs its finally —
      // otherwise an unbounded handler keeps running after the transport dies.
      try {
        await outboundSource.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
  })();

  let sourceCompleted = false;
  try {
    // libp2p 3.x `Stream` is itself the readable `AsyncIterable` (it no
    // longer exposes a separate `.source`).
    // INVARIANT: nothing may `await` between acquiring `stream` and the first pull
    // below. In libp2p 3.x end-of-inbound is an EVENT ('remoteCloseWrite'), and the
    // async iterator only subscribes on its first next(). Buffered payload bytes are
    // re-dispatched on subscribe, but a 'remoteCloseWrite' delivered before we
    // subscribe is lost and this loop would never end. Every current path from
    // dialProtocol/onStream to here is microtask-only, so a socket FIN cannot
    // interleave. Inserting an await above would break that.
    for await (const frame of parseFrames(stream)) {
      if (frame.type === TYPE_DATA) {
        yield frame.payload;
      } else if (frame.type === TYPE_ERROR) {
        const err = decodeError(frame.payload);
        firePeerInputEnd(err);
        throw err;
      }
    }
    sourceCompleted = true;
    firePeerInputEnd();
    opts.onSourceCompleted?.();
  } finally {
    firePeerInputEnd();
    // If the consumer aborted before the source completed, cut the outbound
    // generator short. On natural source completion we DO NOT: the peer
    // closing its write half does not entitle us to silence our own writes.
    //
    // NEITHER CALL IS AWAITED, AND THAT IS THE FIX.
    //
    // `.return()` on an async generator that is PARKED AWAITING ITS OWN
    // SOURCE is queued behind that pending `next()` — it is not preemptive.
    // For a long-lived session, waiting inside `next()` is where the pump
    // spends its entire life, so the old `await outboundSource.return()`
    // never settled, and the `await outbound` behind it never settled either:
    // tearing down a duplex whose input was still open hung for ever. Two
    // consumers of this package hit it and both worked around it with
    // `close()`, which is a defect report, not a usage pattern.
    //
    // Cancelling without waiting keeps the contract a consumer is entitled to
    // — `.return()` settles promptly, and a well-behaved producer still sees
    // its `finally` — while a producer that cannot be woken is simply
    // abandoned rather than allowed to hold the caller hostage. The stream is
    // aborted below, so the peer is told rather than left guessing.
    if (!sourceCompleted) {
      // The producer first — this is the call that actually runs its
      // `finally` — then the wrapper, which may be parked behind it.
      cancelInput();
      void Promise.resolve(outboundSource.return?.(undefined)).catch(() => undefined);
      // The pump may be parked in `next()` or in `waitForDrain`; aborting the
      // stream is what unblocks the latter and tells the peer this call is
      // over. `closeStream`'s graceful path belongs to a completed call.
      try {
        stream.abort(new Error("duplexOverStream: consumer cancelled"));
      } catch {
        /* already gone */
      }
      void outbound.catch(() => undefined);
    } else {
      await outbound;
    }
  }
}

/**
 * Wait for `stream` to signal it can accept more data, per the real
 * `'drain'` event rather than the broken {@link Stream.onDrain}. Rejects if
 * the stream closes first (including a remote reset) so a peer that goes
 * away while we're backpressured unwinds into the caller's existing
 * `catch` instead of hanging forever — and rejects after `timeoutMs` for the
 * peer that neither reads nor closes, which produces no event at all. The
 * expiry is loud (a `console.warn` naming the protocol and the bound) rather
 * than a silent stall, per this project's "silent failures deserve loud
 * guards" rule; the rejection itself reaches the outbound pump's `catch`,
 * which aborts the stream so the peer learns it was dropped.
 */
function waitForDrain(stream: Stream, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeEventListener("drain", onDrain);
      stream.removeEventListener("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (evt: StreamCloseEvent): void => {
      cleanup();
      reject(evt.error ?? new Error("stream closed"));
    };
    const timer = setTimeout(() => {
      cleanup();
      const message =
        `[webrun-streams-libp2p] waitForDrain: peer on protocol ${stream.protocol} ` +
        `did not accept more data within ${timeoutMs}ms and never closed the stream; ` +
        `dropping it so this side's pump is not parked forever`;
      console.warn(message);
      reject(new Error(message));
    }, timeoutMs);
    stream.addEventListener("drain", onDrain);
    stream.addEventListener("close", onClose);
  });
}

/**
 * Close a `Stream`'s writable end, bounded by `timeoutMs`. Plain
 * `stream.close()` awaits the write queue draining and the peer
 * acknowledging with no bound of its own — a peer that stops reading
 * without resetting (a suspended tab, a paused container, `SIGSTOP`) means
 * it never settles, which would otherwise hang every caller waiting on it
 * (the outbound pump here, and `connect`/`serve`'s teardown in
 * `connect-serve.ts`). On timeout we fall back to a hard `abort()` so the
 * caller is never left hanging.
 */
export async function closeStream(
  stream: Stream,
  timeoutMs: number = DEFAULT_CLOSE_TIMEOUT_MS,
): Promise<void> {
  try {
    await stream.close({ signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // The bound tripped (or close() otherwise failed): fall back to a hard
    // abort so the caller is never left hanging. That abort sends a reset to
    // the peer, silently truncating whatever was still in flight — this
    // side must not report clean completion without a trace of that, per
    // this project's own "silent failures deserve loud guards" rule. Not
    // rethrown: closeStream is called from `finally` blocks, and throwing
    // here would mask whatever error the caller was already unwinding from.
    console.warn(
      `[webrun-streams-libp2p] closeStream: graceful close of protocol ${stream.protocol} ` +
        `failed (bound ${timeoutMs}ms), aborting instead (peer may see truncated data): ${e.message}`,
    );
    try {
      stream.abort(e);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Frame the caller's outbound chunks.
 *
 * TAKES AN ITERATOR, NOT AN ITERABLE, so the caller can cancel the PRODUCER
 * directly. Returning this wrapper generator is not enough: while it is
 * parked awaiting the producer's `next()`, a `.return()` on the wrapper is
 * queued behind that pending call and reaches the producer only once the
 * producer yields — which a long-lived session never does. Teardown therefore
 * needs a handle on the producer itself, and acquiring the iterator once (in
 * `duplexOverStream`) is what provides it.
 */
async function* framedOutbound(
  iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) return;
      yield frameData(normalizeChunk(next.value));
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    yield frameError(e);
  } finally {
    // PROPAGATE CANCELLATION TO THE PRODUCER, and do not wait for it.
    //
    // `for await (… of input)` used to do this implicitly: returning this
    // generator ran the loop's cleanup, which returned the producer. Driving
    // the iterator by hand (needed so teardown can hold a handle on the
    // producer) removes that, and removing it silently stopped a server-side
    // handler from ever being told its caller had gone — a regression caught
    // by `cancel-server-handler.test.ts`.
    //
    // Not awaited: `.return()` on a producer parked at an `await` is queued
    // behind it, so awaiting here would reintroduce the very hang this file's
    // teardown was fixed to avoid.
    void Promise.resolve((iterator as AsyncIterator<Uint8Array>).return?.(undefined)).catch(
      () => undefined,
    );
  }
}

async function* parseFrames(
  source: AsyncIterable<unknown>,
): AsyncGenerator<{ type: number; payload: Uint8Array }> {
  let buf = new Uint8Array(0);
  for await (const item of source) {
    const incoming = normalizeChunk(item);
    if (incoming.byteLength === 0) continue;
    if (buf.byteLength === 0) {
      buf = new Uint8Array(incoming);
    } else {
      const merged = new Uint8Array(buf.byteLength + incoming.byteLength);
      merged.set(buf, 0);
      merged.set(incoming, buf.byteLength);
      buf = merged;
    }
    while (buf.byteLength > 0) {
      if (buf.byteLength < 2) break; // need at least type + 1 varint byte
      const type = buf[0]!; // buf.byteLength >= 2, checked above, so index 0 exists
      let lenInfo: { value: number; offset: number };
      try {
        lenInfo = decodeVarint(buf, 1);
      } catch {
        break; // varint truncated, need more bytes
      }
      const total = lenInfo.offset + lenInfo.value;
      if (buf.byteLength < total) break;
      const payload = new Uint8Array(buf.subarray(lenInfo.offset, total));
      yield { type, payload };
      buf = buf.byteLength === total ? new Uint8Array(0) : new Uint8Array(buf.subarray(total));
    }
  }
}

function normalizeChunk(item: unknown): Uint8Array {
  if (item instanceof Uint8Array) return item;
  const asList = item as { subarray?: () => Uint8Array };
  if (typeof asList.subarray === "function") {
    return new Uint8Array(asList.subarray());
  }
  return new Uint8Array(0);
}

function frameData(payload: Uint8Array): Uint8Array {
  const lenEnc = encodeVarint(payload.byteLength);
  const out = new Uint8Array(1 + lenEnc.byteLength + payload.byteLength);
  out[0] = TYPE_DATA;
  out.set(lenEnc, 1);
  out.set(payload, 1 + lenEnc.byteLength);
  return out;
}

function frameError(err: Error): Uint8Array {
  const payload = textEncoder.encode(JSON.stringify(serializeError(err)));
  const lenEnc = encodeVarint(payload.byteLength);
  const out = new Uint8Array(1 + lenEnc.byteLength + payload.byteLength);
  out[0] = TYPE_ERROR;
  out.set(lenEnc, 1);
  out.set(payload, 1 + lenEnc.byteLength);
  return out;
}

function decodeError(payload: Uint8Array): Error {
  if (payload.byteLength === 0) return new Error("unknown stream error");
  try {
    return deserializeError(JSON.parse(textDecoder.decode(payload)));
  } catch {
    return new Error(textDecoder.decode(payload));
  }
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
    const b = buf[i++]!; // i < buf.length, checked by the while condition, so this index exists
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, offset: i };
    shift += 7;
    if (shift > 28) throw new Error("decodeVarint: too long");
  }
  throw new Error("decodeVarint: truncated");
}
