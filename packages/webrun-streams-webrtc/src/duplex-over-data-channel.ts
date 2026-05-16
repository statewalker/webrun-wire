import {
  deserializeError,
  serializeError,
  TransportClosedError,
  toChunks,
} from "@statewalker/webrun-streams";

const TYPE_DATA = 0x00;
const TYPE_END = 0x01;
const TYPE_ERROR = 0x02;

const DC_MTU = 16 * 1024; // conservative across browsers
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
 * and `ERROR` (0x02, followed by a serialised `Error`).
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
    if (!peerEnded) {
      incoming.done(new TransportClosedError());
      peerEnded = true;
    }
  };

  dc.addEventListener("message", onMessage);
  dc.addEventListener("close", onClose);

  // Outbound pump runs in parallel with inbound iteration.
  const outbound = (async () => {
    try {
      for await (const chunk of toChunks(DC_MTU - FRAME_OVERHEAD)(input)) {
        if (dc.readyState !== "open") return;
        const framed = new Uint8Array(chunk.byteLength + 1);
        framed[0] = TYPE_DATA;
        framed.set(chunk, 1);
        (dc as unknown as { send: (data: Uint8Array) => void }).send(framed);
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

  try {
    for await (const chunk of incoming.iterate()) {
      yield chunk;
    }
  } finally {
    dc.removeEventListener("message", onMessage);
    dc.removeEventListener("close", onClose);
    // Wait for outbound to settle so close() doesn't truncate in-flight sends.
    await outbound.catch(() => {});
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
