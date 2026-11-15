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
 *
 * Also the default stall bound of the port protocol (`connect`, `serve`,
 * `serveConnections`, `libp2pPortMux`): a write on a call's stream that has
 * waited for drain this long resets the stream (statewalker/webrun-wire#195).
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
 *
 * @deprecated The deprecated protocol's (statewalker/webrun-wire#153): kept for
 * one release, as the shim `connect`/`serve` run for older peers, then removed.
 */
export const DEFAULT_CLOSE_TIMEOUT_MS = DEFAULT_DRAIN_TIMEOUT_MS;

/**
 * Default for {@link DuplexOverStreamOptions.readHighWaterBytes}: received bytes
 * held for a consumer that is not reading before the stream is paused.
 */
export const DEFAULT_READ_HIGH_WATER_BYTES = 64 * 1024;

/**
 * Default for {@link DuplexOverStreamOptions.maxFrameBytes}: the largest frame payload accepted
 * from the peer. Generous, because a sender before this package's outbound chunking sent each
 * producer chunk as one frame; short of letting a peer declare a 4 GiB frame.
 */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * The largest payload this side puts in one outbound frame: a larger producer chunk crosses as
 * several frames (they are self-delimiting, so a receiver of any version reassembles the bytes).
 */
export const OUTBOUND_FRAME_BYTES = 64 * 1024;

/** The peer sent bytes that are not this framing: a malformed or oversized frame header. */
class FramingError extends Error {}

/**
 * The stream ended before the call finished: the peer died, the connection
 * dropped, or the stream was reset or refused before both sides ended it.
 * Distinct from a clean end on purpose — a response cut short must never read
 * as a complete one. `cause` is the stream's close error, when libp2p gave one.
 */
export class PeerGoneError extends Error {
  constructor(cause?: unknown) {
    super(
      `webrun-streams-libp2p: the stream ended before the call finished${
        cause instanceof Error ? ` (${cause.message})` : ""
      }`,
      { cause },
    );
    this.name = "PeerGoneError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Options for {@link duplexOverStream}. The `onPeerInputEnd` hook is the seam
 * that lets the server side close its input queue as soon as the peer's source
 * exhausts — without it, the server-side `serve` would deadlock waiting for the
 * outbound pump to finish, which itself waits for the handler, which waits for
 * inputQueue.done.
 *
 * @deprecated The deprecated protocol's (statewalker/webrun-wire#153): kept for
 * one release, as the shim `connect`/`serve` run for older peers, then removed.
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
  /**
   * Received bytes held for a consumer that is not reading before the stream
   * is paused (and resumed once half of them are read). A paused yamux stream
   * stops granting its peer receive window, so the peer's `send()` reports a
   * full buffer and its producer waits: run-ahead is bounded by two receive
   * windows (what libp2p held while paused, and the window granted on resume)
   * plus this — the receiving node's yamux `streamOptions.maxStreamWindowSize`,
   * 16 MiB by default; 1 MiB bounds it at about 2.25 MiB with no loss of
   * one-way throughput measured. Only where the muxer exposes its window.
   * Defaults to {@link DEFAULT_READ_HIGH_WATER_BYTES}.
   */
  readHighWaterBytes?: number;
  /**
   * The largest frame payload accepted from the peer, in bytes. A frame header past it — or one
   * whose length is not a valid varint — means the peer is not speaking this framing: the call
   * fails and the stream is aborted, rather than buffering without bound. Defaults to
   * {@link DEFAULT_MAX_FRAME_BYTES}.
   */
  maxFrameBytes?: number;
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
 *
 * @deprecated The deprecated protocol's (statewalker/webrun-wire#153): kept for
 * one release, as the shim `connect`/`serve` run for older peers, then removed.
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

  // A CLEAN END IS THE PEER'S OWN `remoteCloseWrite`, NOTHING ELSE. When the
  // connection dies (a killed process, a dropped network), libp2p closes the
  // stream WITHOUT an error and its iterator ends exactly as it does after the
  // peer's close — so a truncated response read as a complete one. Listened
  // for before the first pull below, like the iterator's own listener. A
  // generator's body runs only on the consumer's first `next()`, so the peer
  // may have closed already; its state is read for that case.
  let peerClosedWrite = stream.remoteWriteStatus === "closed";
  let closeError: unknown;
  let onStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    onStreamClosed = resolve;
  });
  const onRemoteCloseWrite = (): void => {
    peerClosedWrite = true;
  };
  const onClose = (evt: StreamCloseEvent): void => {
    closeError = evt.error;
    onStreamClosed();
  };
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  stream.addEventListener("close", onClose);

  // Set once every input chunk went out. A stream that closes before that lost
  // part of this side's input, which is not a complete call either.
  let inputSent = false;
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
      inputSent = true;
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
    let peerError: Error | undefined;
    try {
      for await (const frame of parseFrames(
        pacedSource(stream, opts.readHighWaterBytes ?? DEFAULT_READ_HIGH_WATER_BYTES),
        opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      )) {
        if (frame.type === TYPE_DATA) {
          yield frame.payload;
        } else if (frame.type === TYPE_ERROR) {
          peerError = decodeError(frame.payload);
          firePeerInputEnd(peerError);
          throw peerError;
        }
      }
    } catch (err) {
      if (err === peerError) throw err;
      if (err instanceof FramingError) {
        // the peer is not speaking this framing: fail the call (the stream is aborted below)
        firePeerInputEnd(err);
        throw err;
      }
      // The stream itself failed (reset, aborted, its connection dropped):
      // the call did not finish, whatever libp2p named the error.
      const gone = new PeerGoneError(err);
      firePeerInputEnd(gone);
      throw gone;
    }
    if (!peerClosedWrite) {
      const gone = new PeerGoneError(closeError);
      firePeerInputEnd(gone);
      throw gone;
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
      // The peer ended its side; ours may still be sending, waiting on an
      // input that is still open (a tunnel). If the stream dies first, stop
      // waiting for that input: it can never be sent now.
      await Promise.race([outbound, streamClosed]);
      if (!inputSent) {
        cancelInput();
        void Promise.resolve(outboundSource.return?.(undefined)).catch(() => undefined);
        void outbound.catch(() => undefined);
      } else {
        await outbound;
      }
    }
    stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    stream.removeEventListener("close", onClose);
  }
  // Reached only after a clean end from the peer.
  if (!inputSent) throw new PeerGoneError(closeError);
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
      // in bounded frames, so a receiver never reassembles one huge frame
      const chunk = normalizeChunk(next.value);
      for (let at = 0; at < chunk.byteLength; at += OUTBOUND_FRAME_BYTES) {
        yield frameData(chunk.subarray(at, Math.min(at + OUTBOUND_FRAME_BYTES, chunk.byteLength)));
      }
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

/**
 * The stream's inbound bytes, read at the consumer's pace. libp2p's own
 * iterator moves every message into an unbounded queue as it arrives, and
 * yamux grants its peer more receive window on arrival, not on consumption: a
 * consumer that stopped reading let the producer run 22-24 MiB ahead until
 * libp2p's read buffer killed the stream (L6). Here the queue is bounded: past
 * `highWater` bytes the stream is paused (yamux then withholds window updates,
 * libp2p keeps what still arrives in its read buffer, undispatched), and it is
 * resumed once the consumer has read the queue down to half.
 *
 * Ends as libp2p's iterator does: on the peer's `remoteCloseWrite`, or on
 * `close` (throwing its error, if any). Subscribes on the first pull, like it.
 */
async function* pacedSource(stream: Stream, highWater: number): AsyncGenerator<Uint8Array> {
  if (stream.readStatus !== "readable" && stream.readStatus !== "paused") return;
  // Pausing bounds anything only where the muxer then stops granting its peer
  // window (yamux, which exposes `maxStreamWindowSize`). Elsewhere a pause just
  // moves the data into libp2p's read buffer, which aborts the stream past
  // `maxReadBufferLength`: there the stream is read as libp2p's own iterator
  // reads it, without a bound.
  const window = (stream as { maxStreamWindowSize?: unknown }).maxStreamWindowSize;
  const paced = typeof window === "number";
  // While paused, libp2p holds what the peer may still send (at most the
  // window granted before the pause) and aborts the stream past
  // `maxReadBufferLength`. yamux's default window (16 MiB) exceeds libp2p's
  // default buffer (4 MiB), so the buffer is raised to the window plus what is
  // queued here; yamux itself refuses a peer that sends past its window.
  if (paced && stream.maxReadBufferLength < window + highWater) {
    stream.maxReadBufferLength = window + highWater;
  }
  const queue: Uint8Array[] = [];
  let queued = 0;
  let ended = false;
  let error: unknown;
  let resuming = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const pauseIfFull = (): void => {
    if (paced && queued >= highWater && stream.readStatus === "readable") {
      try {
        stream.pause();
      } catch {
        /* closing: nothing more will be granted anyway */
      }
    }
  };
  const onMessage = (evt: { data: unknown }): void => {
    const chunk = normalizeChunk(evt.data);
    if (chunk.byteLength === 0) return;
    // In pieces of at most `highWater` (views, not copies): a resume hands over
    // everything libp2p held as one message, up to a window, and a reader that
    // took it whole would hold that window outside this queue's count.
    for (let at = 0; at < chunk.byteLength; at += highWater) {
      queue.push(chunk.subarray(at, Math.min(at + highWater, chunk.byteLength)));
    }
    queued += chunk.byteLength;
    // Never from inside `resume()`: it dispatches what libp2p held first and
    // tells the muxer to grant window after, so a pause here would leave libp2p
    // paused and yamux granting window for every frame (review of #112).
    if (!resuming) pauseIfFull();
    notify();
  };
  const resume = (): void => {
    resuming = true;
    try {
      stream.resume(); // dispatches what libp2p held meanwhile, synchronously
    } catch {
      /* closing */
    } finally {
      resuming = false;
    }
    pauseIfFull(); // after the muxer's own resume, so the pause holds
  };
  const onClose = (evt: StreamCloseEvent): void => {
    ended = true;
    error ??= evt.error;
    notify();
  };
  const onRemoteCloseWrite = (): void => {
    ended = true;
    notify();
  };
  stream.addEventListener("message", onMessage);
  stream.addEventListener("close", onClose);
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  if (stream.readStatus === "paused") resume(); // paused by someone else: nothing here resumes it later
  try {
    for (;;) {
      const chunk = queue.shift();
      if (chunk) {
        queued -= chunk.byteLength;
        if (queued <= highWater / 2 && stream.readStatus === "paused") resume();
        yield chunk;
        continue;
      }
      if (ended) {
        if (error) throw error;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    stream.removeEventListener("message", onMessage);
    stream.removeEventListener("close", onClose);
    stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
  }
}

/**
 * Frames out of the stream's chunks, as they complete. Unread bytes sit in a {@link ByteBuffer},
 * which grows by doubling, so a large frame arriving in many chunks is copied a bounded number
 * of times. A header whose length is malformed or past `maxFrameBytes` throws a `FramingError`.
 */
export async function* parseFrames(
  source: AsyncIterable<unknown>,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): AsyncGenerator<{ type: number; payload: Uint8Array }> {
  const buf = new ByteBuffer();
  for await (const item of source) {
    const incoming = normalizeChunk(item);
    if (incoming.byteLength === 0) continue;
    buf.push(incoming);
    for (;;) {
      const bytes = buf.unread();
      if (bytes.byteLength < 2) break; // need at least type + 1 varint byte
      // biome-ignore lint/style/noNonNullAssertion: bytes.byteLength >= 2, checked above, so index 0 exists.
      const type = bytes[0]!;
      const header = readLength(bytes.subarray(1), "frame");
      if (header === undefined) break; // the length is not all here yet
      if (header.value > maxFrameBytes) {
        throw new FramingError(
          `webrun-streams-libp2p: a ${header.value}-byte frame exceeds maxFrameBytes (${maxFrameBytes})`,
        );
      }
      const total = 1 + header.offset + header.value;
      if (bytes.byteLength < total) break;
      const payload = bytes.slice(1 + header.offset, total);
      buf.consume(total);
      yield { type, payload };
    }
  }
}

/** Unread bytes `buf[start, end)` of a buffer that grows by doubling. */
export class ByteBuffer {
  private buf = new Uint8Array(0);
  private start = 0;
  private end = 0;

  push(incoming: Uint8Array): void {
    if (this.end + incoming.byteLength > this.buf.byteLength) {
      const size = this.end - this.start + incoming.byteLength;
      const next = new Uint8Array(Math.max(size, this.buf.byteLength * 2));
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.end -= this.start;
      this.start = 0;
    }
    this.buf.set(incoming, this.end);
    this.end += incoming.byteLength;
  }

  /** a view of the unread bytes, valid until the next `push` */
  unread(): Uint8Array {
    return this.buf.subarray(this.start, this.end);
  }

  consume(n: number): void {
    this.start += n;
    if (this.start === this.end) this.start = this.end = 0;
  }
}

/**
 * The varint length prefix at the start of `bytes`, or `undefined` while it is incomplete; throws
 * a `FramingError` when it is malformed (no varint of this framing runs past 5 bytes).
 */
export function readLength(
  bytes: Uint8Array,
  what: string,
): { value: number; offset: number } | undefined {
  try {
    return decodeVarint(bytes, 0);
  } catch (err) {
    if (bytes.byteLength < 5) return undefined;
    throw new FramingError(`webrun-streams-libp2p: a malformed ${what} length`, { cause: err });
  }
}

export function normalizeChunk(item: unknown): Uint8Array {
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

export function encodeVarint(value: number): Uint8Array {
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

export function decodeVarint(buf: Uint8Array, start: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    // biome-ignore lint/style/noNonNullAssertion: i < buf.length, checked by the while condition, so this index exists.
    const b = buf[i++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, offset: i };
    shift += 7;
    if (shift > 28) throw new Error("decodeVarint: too long");
  }
  throw new Error("decodeVarint: truncated");
}
