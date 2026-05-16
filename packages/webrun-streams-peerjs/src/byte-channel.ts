import type { ByteChannel } from "@statewalker/webrun-streams";
import type { DataConnection } from "peerjs";

/**
 * Wrap an open PeerJS `DataConnection` into a `ByteChannel`. The connection
 * MUST be constructed with `{ serialization: "raw" }` so payloads arrive as
 * `Uint8Array` rather than PeerJS's own JSON envelopes.
 */
export function byteChannelFromPeerJs(conn: DataConnection): ByteChannel {
  const serialization = (conn as unknown as { serialization?: string }).serialization;
  if (serialization !== "raw") {
    throw new TypeError(
      `byteChannelFromPeerJs: DataConnection serialization is '${serialization}', expected 'raw'`,
    );
  }

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

  const onData = (data: unknown): void => {
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
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => deliver(new Uint8Array(buf)));
    }
  };

  const onClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    conn.off("data", onData);
    conn.off("close", onClose);
    if (pending) {
      const r = pending;
      pending = null;
      r({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    }
    closedResolve();
  };

  conn.on("data", onData);
  conn.on("close", onClose);

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
      if (!conn.open) return;
      conn.send(bytes);
    },
    recv,
    closed,
    close() {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      onClose();
    },
  };
}
