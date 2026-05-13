import type { Stream } from "@libp2p/interface";
import { bindBytesToPort } from "@statewalker/webrun-port-core";

/**
 * The libp2p protocol id used by `webrun-port-libp2p`. Both peers must agree
 * on the same id; the responder calls `libp2p.handle(PROTOCOL_ID, ...)` and the
 * initiator opens a stream with `connection.newStream([PROTOCOL_ID])`.
 */
export const WEBRUN_PORT_LIBP2P_PROTOCOL = "/webrun/port-bytes/1.0.0";

/**
 * Conservative MTU for libp2p streams. The yamux multiplexer defaults to a
 * receive window of 256 KiB per stream; staying well below that keeps the
 * window from clogging on a single huge frame.
 */
const DEFAULT_LIBP2P_MTU = 32 * 1024;

export interface CreateLibp2pPortOptions {
  /** Override the per-frame byte budget. Default ~32 KiB. */
  mtu?: number;
}

/**
 * Wrap an established libp2p `Stream` into a real `MessagePort`. The far end
 * of the port lives at the peer holding the other half of the stream.
 *
 * The stream must already be opened (`connection.newStream([protocol])` on the
 * initiator side, or the inbound stream supplied by a `libp2p.handle` handler
 * on the responder side).
 */
export function createLibp2pStreamPort(
  stream: Stream,
  options: CreateLibp2pPortOptions = {},
): MessagePort {
  let chunkHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;

  const deliver = (bytes: Uint8Array): void => {
    const h = chunkHandler;
    if (h) h(bytes);
  };

  const fireClose = (): void => {
    const h = closeHandler;
    if (h) h();
  };

  // Pump inbound chunks from stream.source into the chunk handler.
  void (async () => {
    try {
      for await (const item of stream.source) {
        if (closed) break;
        // Stream source yields Uint8ArrayList; copy to a fresh Uint8Array.
        const asList = item as unknown as { subarray?: () => Uint8Array };
        if (typeof asList.subarray === "function") {
          deliver(new Uint8Array(asList.subarray()));
        }
      }
    } catch {
      // Source errored — close.
    } finally {
      if (!closed) fireClose();
    }
  })();

  // Outbound — pump from our queue into stream.sink.
  const outboundQueue: Uint8Array[] = [];
  let outboundResolve: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let sinkDone = false;

  const outboundIterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (sinkDone) {
            return Promise.resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>);
          }
          if (outboundQueue.length > 0) {
            const value = outboundQueue.shift();
            return Promise.resolve({ value: value as Uint8Array, done: false });
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            outboundResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          sinkDone = true;
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>);
        },
      };
    },
  };

  void stream.sink(outboundIterable).catch(() => {
    // Sink errored — close detected via source side.
  });

  return bindBytesToPort({
    postChunk(bytes) {
      if (closed || sinkDone) return;
      const resolver = outboundResolve;
      if (resolver) {
        outboundResolve = null;
        resolver({ value: bytes, done: false });
        return;
      }
      outboundQueue.push(bytes);
    },
    onChunk(handler) {
      chunkHandler = handler;
      return () => {
        if (chunkHandler === handler) chunkHandler = null;
      };
    },
    onClose(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      sinkDone = true;
      const resolver = outboundResolve;
      if (resolver) {
        outboundResolve = null;
        resolver({ value: undefined, done: true } as IteratorResult<Uint8Array>);
      }
      try {
        void stream.close();
      } catch {
        // ignore
      }
    },
    mtu: options.mtu ?? DEFAULT_LIBP2P_MTU,
  });
}
