# @statewalker/webrun-streams-libp2p

libp2p native multi-stream `Connect` / `Serve` adapter. Each `call(input)` opens a new libp2p `Stream` via `node.dialProtocol(peer, [protocol])`; the responder registers via `node.handle(protocol, ...)`. Default protocol id: `/webrun-streams/1.0.0`. Targets libp2p 3.x.

```ts
import { connect, serve } from "@statewalker/webrun-streams-libp2p";

const { call, close } = await connect({ node, peer, protocol: "/my-app/1.0.0" });
const stop = await serve({ node, protocol: "/my-app/1.0.0" }, handler);
```

## Knowing who is calling

`Duplex` is bytes-only and gains no new parameter, so the serving side exposes identity through a separate entry point: `serveConnections` builds a handler **per inbound stream** and hands it the connection libp2p authenticated.

```ts
import { serveConnections } from "@statewalker/webrun-streams-libp2p";

const stop = await serveConnections({ node }, (context) => {
  const who = context.remotePeer; // PeerId, from the Noise handshake
  return async function* handler(input) {
    for await (const chunk of input) yield respondTo(who, chunk);
  };
});
```

`context.remotePeer` is `connection.remotePeer` — the peer id libp2p proved when the connection was encrypted. It is the one identity claim on the serving side a request payload cannot forge, and it reaches the handler by closure rather than by argument, so no caller can influence it. Build any per-peer state inside `makeHandler`, not outside it: the function runs once per stream, and reusing one handler for every connection is exactly how identity-by-closure gets broken.

`serve` is `serveConnections` with the context ignored, so both share the same framing, teardown and failure handling.

## Framing

The adapter puts a small frame on top of the libp2p stream:

    [type:1][length:varint][payload]

`DATA` (`0x00`) carries body bytes; `ERROR` (`0x02`) carries a JSON-serialised `Error`. The error frame exists because yamux's native `StreamResetError` discards the message — without it, a handler that throws reaches the caller as an anonymous reset. Normal end-of-input is libp2p's own `close()`, not a frame.

## Flow control, and what libp2p 3.x does not give you for free

libp2p 3.x streams are **push-based**: `stream.send(chunk)` returns `false` when the write buffer is full, and the stream emits `'drain'` when it can take more. (2.x's pull-based `sink(AsyncIterable)` is gone, and with it the illusion that yamux's credit window applies backpressure to a source on its own.) The outbound pump therefore honours `send()`'s return value and waits for the real `'drain'` event.

It deliberately does **not** use `stream.onDrain()`: that method memoises one promise for the stream's whole lifetime and never clears it (`@libp2p/utils@7.3.2`), so past the first backpressure cycle it resolves immediately while the buffer is still full — a write loop built on it floods the buffer without bound. `tests/backpressure.test.ts` is a regression test for exactly that.

Two bounds keep a misbehaving peer from parking a long-lived server:

- **Drain timeout** — `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes), overridable per connection via `drainTimeoutMs` on `connect`/`serve`/`serveConnections` params. A peer that requests something and then stops reading, without closing or resetting, produces no event at all; unbounded, it parks the serving side's pump, the handler and everything buffered behind it forever. The bound is generous on purpose — resetting a slow-but-alive peer is the thing backpressure exists to avoid — and expiry is logged, then unwound by aborting the stream.
- **Close timeout** — 5 s (2.x's own `DEFAULT_SEND_CLOSE_WRITE_TIMEOUT`) around the graceful `stream.close()`, falling back to `abort()`. Because the pump awaits drain before every `send()`, at most the final chunk is outstanding at close time. A trip is logged, including that the peer may see truncated data.

## Failure handling

One inbound stream failing never takes down the serving process. `duplexOverStream` rejects on the read side when a peer sends an `ERROR` frame or resets mid-request — which happens in ordinary use, a browser tab closed mid-request being enough — and `serveConnections` catches that per stream and logs it. Callers see their own errors as usual: cancelling a `call` (i.e. `.return()` on the returned generator) sends a reset, and `close()` on the connection aborts every stream it still holds open.

## Tests

```bash
pnpm test                              # backpressure, drain timeout, identity, resilience
WEBRUN_STREAMS_LIBP2P=1 pnpm test      # + the framing/conformance suite
```

The conformance suite is opt-in because it spins up two real libp2p TCP nodes in-process.

## License

MIT
