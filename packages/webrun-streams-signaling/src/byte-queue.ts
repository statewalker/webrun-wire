/**
 * Minimal eager push/pull byte queue backing the `recv` side of the
 * {@link ByteChannel} adapters. "Eager" = bytes pushed before the consumer
 * starts iterating are buffered (not dropped), which the signaling adapters
 * need because a channel can receive data the instant it opens, before the
 * caller wires up its `for await`.
 */
export function makeByteQueue(): {
  recv: AsyncIterable<Uint8Array>;
  push: (bytes: Uint8Array) => void;
  done: () => void;
} {
  const chunks: Uint8Array[] = [];
  let pending: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  let ended = false;

  const push = (bytes: Uint8Array): void => {
    if (ended) return;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve({ value: bytes, done: false });
    } else {
      chunks.push(bytes);
    }
  };

  const done = (): void => {
    if (ended) return;
    ended = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    }
  };

  const recv: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (chunks.length > 0) {
            return Promise.resolve({ value: chunks.shift() as Uint8Array, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true } as IteratorResult<Uint8Array>);
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending = resolve;
          });
        },
      };
    },
  };

  return { recv, push, done };
}

/** Coerce a message payload (Uint8Array / ArrayBuffer / view) to a Uint8Array copy. */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  throw new TypeError("byte channel received a non-byte payload");
}
