import { type ByteChannel, normalizeToUint8Array } from "@statewalker/webrun-streams";
import { type WebSocketLike, WS_READY_STATE } from "./websocket-like.js";

/**
 * Wrap an open `WebSocket` (or any `WebSocketLike` — Node `ws` works) into a
 * `ByteChannel` consumable by `emulateMux`. The socket MUST already be in the
 * `OPEN` state; the adapter does not perform handshakes.
 *
 * Inbound binary frames are normalised to `Uint8Array`. Text frames are also
 * accepted (rare on this transport) and surfaced as their UTF-8 bytes.
 */
export function byteChannelFromWebSocket(ws: WebSocketLike): ByteChannel {
  if (ws.readyState !== WS_READY_STATE.OPEN) {
    throw new Error(
      `byteChannelFromWebSocket: WebSocket is in readyState ${ws.readyState}, expected OPEN (1)`,
    );
  }

  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  let isClosed = false;

  // Inbound: queue of received chunks + pending next() resolver
  const queue: Uint8Array[] = [];
  let pending: ((value: IteratorResult<Uint8Array>) => void) | null = null;

  const onMessage = (event: MessageEvent): void => {
    if (isClosed) return;
    const data = event.data as unknown;
    let normalised: Uint8Array;
    if (data instanceof Uint8Array) {
      normalised = data;
    } else if (data instanceof ArrayBuffer) {
      normalised = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      normalised = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => deliver(new Uint8Array(buf)));
      return;
    } else if (typeof data === "string") {
      const n = normalizeToUint8Array(data);
      if (n instanceof Uint8Array) normalised = n;
      else {
        void n.then(deliver);
        return;
      }
    } else {
      return;
    }
    deliver(normalised);
  };

  const deliver = (bytes: Uint8Array): void => {
    if (isClosed) return;
    if (pending) {
      const r = pending;
      pending = null;
      r({ value: bytes, done: false });
    } else {
      queue.push(bytes);
    }
  };

  const onClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("close", onClose);
    if (pending) {
      const r = pending;
      pending = null;
      r({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    }
    closedResolve();
  };

  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);

  const recv: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as Uint8Array, done: false });
          }
          if (isClosed) {
            return Promise.resolve({
              value: undefined,
              done: true,
            } as IteratorResult<Uint8Array>);
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending = resolve;
          });
        },
      };
    },
  };

  return {
    send(bytes) {
      if (isClosed) return;
      if (ws.readyState !== WS_READY_STATE.OPEN) return;
      ws.send(bytes);
    },
    recv,
    closed,
    close() {
      if (isClosed) return;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      onClose();
    },
  };
}
