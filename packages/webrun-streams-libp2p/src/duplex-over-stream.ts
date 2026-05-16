import type { Stream } from "@libp2p/interface";

/**
 * Drive one `Duplex` over one libp2p `Stream`. libp2p streams are already
 * source/sink shaped, so this is much thinner than the WebRTC bridge — no
 * in-band framing, no half-close emulation. Yamux (the default multiplexer)
 * handles credit-window backpressure and head-of-line avoidance natively.
 *
 * `stream.source` yields `Uint8ArrayList` items; we normalise them to
 * `Uint8Array` so the seam stays byte-typed.
 */
export async function* duplexOverStream(
  stream: Stream,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  // Pump input → stream.sink in the background.
  const outbound = stream
    .sink(toAsyncIterable(input))
    .then(() => stream.closeWrite())
    .catch(() => {
      try {
        stream.abort(new Error("webrun-streams-libp2p: outbound aborted"));
      } catch {
        /* ignore */
      }
    });

  try {
    for await (const item of stream.source) {
      // libp2p yields Uint8ArrayList; both have a `subarray()` method.
      const asList = item as unknown as { subarray?: () => Uint8Array };
      if (typeof asList.subarray === "function") {
        yield new Uint8Array(asList.subarray());
      }
    }
  } finally {
    // Wait for outbound to settle to avoid truncating in-flight sink writes.
    await outbound;
  }
}

function toAsyncIterable(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if ((input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]) {
    return input as AsyncIterable<Uint8Array>;
  }
  const it = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(it.next()),
      };
    },
  };
}
