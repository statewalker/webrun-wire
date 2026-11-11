import {
  deserializeError,
  serializeError,
  TransportClosedError,
  toChunks,
} from "@statewalker/webrun-streams";

const TYPE_DATA = 0x00;
const TYPE_END = 0x01;
const TYPE_ERROR = 0x02;
const TYPE_CREDIT = 0x03;

const DC_MTU = 16 * 1024; // conservative across browsers

/**
 * Send-side backpressure: a sender waits while the DataChannel holds more than this many bytes
 * unsent (`bufferedAmount`), until it drains to {@link LOW_WATER_MARK} (`bufferedamountlow`).
 * Without it a fast producer fills the browser's send queue (Chrome fails `send` past 16 MiB).
 */
export const HIGH_WATER_MARK = 1024 * 1024;
export const LOW_WATER_MARK = 256 * 1024;
/**
 * Receive-side backpressure: a sender may have at most this many payload bytes outstanding that
 * the receiving consumer has not yet pulled. The receiver returns credit (`CREDIT` frames) as its
 * consumer pulls, half a window at a time. A DataChannel delivers every message as it arrives,
 * whether or not anyone reads, so without credit a slow reader's queue grows without bound. The
 * window is larger than the send buffer's high-water mark so a long round trip does not throttle a
 * fast link: the buffer limit is what bounds the sender's memory.
 */
export const RECEIVE_WINDOW = 4 * 1024 * 1024;
const FRAME_OVERHEAD = 1; // 1-byte type tag

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Drive one `Duplex` over one `RTCDataChannel`. The DataChannel hosts a tiny
 * in-band framing protocol:
 *
 *     [1-byte type][payload bytes...]
 *
 * Types are `DATA` (0x00, body bytes), `END` (0x01, signals half-close — the
 * sender is done emitting; the channel stays open for the other direction),
 * `ERROR` (0x02, followed by a serialised `Error`) and `CREDIT` (0x03, a
 * big-endian u32: payload bytes the receiver's consumer has pulled, which the
 * sender may now send again; see {@link RECEIVE_WINDOW}).
 *
 * `RTCDataChannel` has no native half-close, so `END` is emitted by the
 * sender once its input iterator exhausts; the channel is only physically
 * closed once both sides have ended.
 */
export function duplexOverDataChannel(
  dc: RTCDataChannel,
  input: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  return runStream(dc, input);
}

async function* runStream(
  dc: RTCDataChannel,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  dc.binaryType = "arraybuffer";

  const incoming = makeInboundQueue();
  let peerEnded = false;
  let localEnded = false;

  // flow control: what the peer still lets us send, and what our consumer has pulled
  let credit = RECEIVE_WINDOW;
  let pulled = 0;
  let wakeSender: (() => void) | null = null;
  const nudge = (): void => {
    const w = wakeSender;
    wakeSender = null;
    w?.();
  };
  const stalled = (): Promise<void> =>
    new Promise<void>((r) => {
      wakeSender = r;
    });
  dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
  const sendRaw = (bytes: Uint8Array): void => {
    (dc as unknown as { send: (data: Uint8Array) => void }).send(bytes);
  };
  /** waits for credit for `n` bytes and room in the send buffer; false once the channel is gone */
  const room = async (n: number): Promise<boolean> => {
    while (dc.readyState === "open" && (credit < n || dc.bufferedAmount > HIGH_WATER_MARK))
      await stalled();
    return dc.readyState === "open";
  };
  /** returns credit for what our consumer pulled, half a window at a time */
  const consumed = (n: number): void => {
    pulled += n;
    if (pulled < RECEIVE_WINDOW / 2 || dc.readyState !== "open") return;
    const frame = new Uint8Array(5);
    frame[0] = TYPE_CREDIT;
    new DataView(frame.buffer).setUint32(1, pulled);
    pulled = 0;
    try {
      sendRaw(frame);
    } catch {
      /* closing */
    }
  };

  const maybeClose = (): void => {
    if (peerEnded && localEnded) {
      try {
        dc.close();
      } catch {
        /* ignore */
      }
    }
  };

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as unknown;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data instanceof Uint8Array) bytes = data;
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    } else return;
    if (bytes.byteLength === 0) return;
    const type = bytes[0];
    const payload = bytes.subarray(1);
    if (type === TYPE_DATA) {
      incoming.push(new Uint8Array(payload));
    } else if (type === TYPE_END) {
      peerEnded = true;
      incoming.done();
      maybeClose();
    } else if (type === TYPE_CREDIT && payload.byteLength >= 4) {
      credit += new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
      nudge();
    } else if (type === TYPE_ERROR) {
      let err: Error;
      try {
        err = deserializeError(JSON.parse(textDecoder.decode(payload)));
      } catch {
        err = new Error(textDecoder.decode(payload));
      }
      peerEnded = true;
      incoming.done(err);
      maybeClose();
    }
  };

  const onClose = (): void => {
    nudge();
    if (!peerEnded) {
      incoming.done(new TransportClosedError());
      peerEnded = true;
    }
  };

  dc.addEventListener("message", onMessage);
  dc.addEventListener("close", onClose);
  dc.addEventListener("bufferedamountlow", nudge);

  // Outbound pump runs in parallel with inbound iteration.
  const outbound = (async () => {
    try {
      for await (const chunk of toChunks(DC_MTU - FRAME_OVERHEAD)(input)) {
        if (!(await room(chunk.byteLength))) return;
        credit -= chunk.byteLength;
        const framed = new Uint8Array(chunk.byteLength + 1);
        framed[0] = TYPE_DATA;
        framed.set(chunk, 1);
        sendRaw(framed);
      }
      if (dc.readyState === "open") {
        const end = new Uint8Array([TYPE_END]);
        (dc as unknown as { send: (data: Uint8Array) => void }).send(end);
      }
    } catch (err) {
      if (dc.readyState === "open") {
        const e = err instanceof Error ? err : new Error(String(err));
        const payload = textEncoder.encode(JSON.stringify(serializeError(e)));
        const framed = new Uint8Array(payload.byteLength + 1);
        framed[0] = TYPE_ERROR;
        framed.set(payload, 1);
        try {
          (dc as unknown as { send: (data: Uint8Array) => void }).send(framed);
        } catch {
          /* ignore */
        }
      }
    } finally {
      localEnded = true;
      maybeClose();
    }
  })();

  let inboundDrained = false;
  try {
    for await (const chunk of incoming.iterate()) {
      yield chunk;
      consumed(chunk.byteLength); // pulled: the peer may send that much again
    }
    inboundDrained = true;
  } finally {
    dc.removeEventListener("message", onMessage);
    dc.removeEventListener("close", onClose);
    // Wait for outbound to settle so an early exit doesn't truncate in-flight
    // sends — but ONLY on an early exit.
    //
    // Awaiting it unconditionally deadlocks a responder. `serve` feeds the
    // handler from the values this generator yields and closes the handler's
    // input only once this generator completes. So on a normal finish the
    // cycle is: inbound ends -> we await outbound -> outbound is draining the
    // handler's output -> the handler is blocked on its input -> its input is
    // closed only after we return. Nothing moves, and every test that runs a
    // request to completion hangs.
    //
    // When inbound drained on its own the peer has already said it is done, so
    // there is nothing of theirs left to truncate; outbound keeps running on
    // its own and `maybeClose` still closes the channel once both halves end.
    if (!inboundDrained) {
      await outbound.catch(() => {});
      // The consumer walked away mid-response (`.return()` on the generator),
      // or the peer errored. Either way this call is over while the peer may
      // still be producing, and a DataChannel has no half-close to say so —
      // `TYPE_END` means "I am done sending", which the outbound pump has
      // already said and which the peer answers by carrying on. Closing the
      // channel is the only cancellation signal available: the responder's
      // `onClose` then ends its inbound queue, which closes the handler's
      // input and runs the handler's `finally`. Without this, cancellation is
      // silently local and the handler leaks until the connection drops.
      try {
        dc.close();
      } catch {
        /* already closing */
      }
    }
  }
}

interface InboundQueue {
  push(chunk: Uint8Array): void;
  done(err?: Error): void;
  iterate(): AsyncGenerator<Uint8Array>;
}

function makeInboundQueue(): InboundQueue {
  type Slot = { type: "value"; value: Uint8Array } | { type: "done"; err?: Error };
  const slots: Slot[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(chunk: Uint8Array): void {
      if (closed) return;
      slots.push({ type: "value", value: chunk });
      wake?.();
    },
    done(err?: Error): void {
      if (closed) return;
      slots.push({ type: "done", err });
      wake?.();
    },
    iterate(): AsyncGenerator<Uint8Array> {
      return (async function* () {
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
              if (slot.err) throw slot.err;
              return;
            }
            yield slot.value;
          }
        } finally {
          closed = true;
          slots.length = 0;
        }
      })();
    },
  };
}
