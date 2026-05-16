import type { ByteChannel } from "@statewalker/webrun-streams";

/**
 * Wrap a `MessagePort` as a `ByteChannel`. Outbound bytes are emitted via
 * `port.postMessage(uint8Array)` (the structured-clone path); inbound bytes
 * are taken from `message` events whose `data` is a `Uint8Array` (or
 * coerceable byte-like value).
 *
 * The port must already be started (`port.start()` if manually constructed).
 * This adapter assumes the port carries only byte payloads — non-byte messages
 * are ignored.
 */
export function byteChannelFromMessagePort(port: MessagePort): ByteChannel {
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  let isClosed = false;

  const queue: Uint8Array[] = [];
  let pending: ((value: IteratorResult<Uint8Array>) => void) | null = null;

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

  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as unknown;
    if (data instanceof Uint8Array) {
      deliver(new Uint8Array(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      deliver(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      deliver(
        new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)),
      );
    }
  };

  // MessagePort doesn't fire a "close" event natively; consumers signal close
  // by calling the channel's close() (which we honour) or by tearing down the
  // underlying port (which they must observe themselves).
  port.addEventListener("message", onMessage as unknown as EventListener);
  port.start?.();

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
      try {
        port.postMessage(bytes);
      } catch {
        /* port closed by peer */
      }
    },
    recv,
    closed,
    close() {
      if (isClosed) return;
      isClosed = true;
      port.removeEventListener("message", onMessage as unknown as EventListener);
      try {
        port.close();
      } catch {
        /* ignore */
      }
      if (pending) {
        const r = pending;
        pending = null;
        r({ value: undefined, done: true } as IteratorResult<Uint8Array>);
      }
      closedResolve();
    },
  };
}
