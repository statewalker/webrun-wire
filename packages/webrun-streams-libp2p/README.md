# @statewalker/webrun-streams-libp2p

libp2p native multi-stream `Connect` / `Serve` adapter. Each `call(input)` opens a new libp2p `Stream` via `node.dialProtocol(peer, [protocol])`; the responder registers via `node.handle(protocol, ...)`. Default protocol id: `/webrun-streams/1.0.0`. Targets libp2p 3.x.

## Why it exists

libp2p already solves the hard parts of peer-to-peer — transport negotiation,
NAT traversal, circuit relaying, and an authenticated peer identity from the
Noise handshake. What it hands an application is a `Stream`, not a request.

This adapter binds that stream to the [`webrun-streams`](../webrun-streams)
`Duplex` seam, so a handler written for a `MessagePort` or a WebSocket runs
unchanged across a libp2p network. Because libp2p multiplexes natively, this
adapter is one of two in the family (with
[`webrun-streams-webrtc`](../webrun-streams-webrtc)) that needs no `emulateMux`
— one `call` is one real libp2p stream.

## Install

```sh
npm install @statewalker/webrun-streams-libp2p libp2p @libp2p/interface @multiformats/multiaddr
```

`libp2p` (`^3.0.0`), `@libp2p/interface` (`^3.0.0`) and `@multiformats/multiaddr`
(`^13.0.0`) are **peer dependencies** — you build and own the node, including
its transports, encryption and muxers.

## Getting started

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

## Stream limits

libp2p caps how many streams for one protocol may be open at once **per connection**, and past the cap a new stream is reset rather than queued. This adapter opens one stream per `call`, so a caller with more concurrent requests than the cap starts seeing rejected calls with no other symptom. The three knobs below are passed straight through to `node.dialProtocol` / `node.handle` — this package sets no defaults of its own, and an option left unset is omitted from the options object entirely so libp2p's own default applies.

| Option | On | libp2p default (3.3.8) |
| --- | --- | --- |
| `maxInboundStreams` | `serve` / `serveConnections` | **32** |
| `maxOutboundStreams` | `connect`, `serve` / `serveConnections` | **64** |
| `runOnLimitedConnection` | `connect`, `serve` / `serveConnections` | unset — libp2p refuses this protocol on a limited connection |

```ts
const stop = await serve({ node, maxInboundStreams: 128 }, handler);
const { call } = await connect({ node, peer, maxOutboundStreams: 128 });
```

`runOnLimitedConnection` opts in to running over a connection with limits on how much data can be transferred or how long it can stay open — a relayed circuit being the usual case. This package does not decide that trade-off for you; it only exposes the knob. `tests/stream-limits.test.ts` pins both halves: a raised `maxInboundStreams` really does admit more than 32 concurrent streams, and an unconfigured server still stops at exactly 32.

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

## API

| Export | Kind | Purpose |
| --- | --- | --- |
| `connect(params)` | `Connect<ConnectLibp2pParams>` | Dials `peer` and resolves `{ call, close }`. Each `call` opens one libp2p stream. |
| `serve(params, handler)` | `Serve<ServeLibp2pParams>` | Registers `handler` on `protocol`. Returns an idempotent teardown. |
| `serveConnections(params, makeHandler)` | function | Like `serve`, but builds a handler per inbound stream and passes it the authenticated `ConnectionContext`. |
| `ServeConnectionsHandler` | type | `(context: ConnectionContext) => Duplex` — the factory `serveConnections` takes. |
| `duplexOverStream(stream, options?)` | function | Wraps one libp2p `Stream` as a `Duplex`, applying the framing and flow control described above. |
| `closeStream(stream, ...)` | function | The graceful-close-then-abort sequence, with the 5 s close timeout. |
| `DEFAULT_PROTOCOL` | const | `"/webrun-streams/1.0.0"` — used when `protocol` is unset. |
| `DEFAULT_DRAIN_TIMEOUT_MS` | const | `300_000` — the default drain bound (5 minutes). |

### `ConnectLibp2pParams`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `node` | `Libp2p` | — | The local node. |
| `peer` | `PeerId \| Multiaddr` | — | Who to dial. |
| `protocol` | `string` | `DEFAULT_PROTOCOL` | libp2p protocol id. |
| `drainTimeoutMs` | `number` | `300_000` | Backpressure drain bound before dropping the peer. |
| `maxOutboundStreams` | `number` | libp2p's (64) | Passed through to `dialProtocol`. |
| `runOnLimitedConnection` | `boolean` | unset | Opt in to relayed / limited connections. |

### `ServeLibp2pParams`

As above minus `peer`, plus `maxInboundStreams` (libp2p default **32**).

### `ConnectionContext`

| Field | Type | Meaning |
| --- | --- | --- |
| `remotePeer` | `PeerId` | The peer id proved by the Noise handshake. Unforgeable by the request payload. |

### `DuplexOverStreamOptions`

`onPeerInputEnd(err?)`, `onSourceCompleted()` and `drainTimeoutMs` — see
[Flow control](#flow-control-and-what-libp2p-3x-does-not-give-you-for-free).

## Tests

```bash
pnpm test                              # backpressure, drain timeout, identity, resilience
WEBRUN_STREAMS_LIBP2P=1 pnpm test      # + the framing/conformance suite
```

The conformance suite is opt-in because it spins up two real libp2p TCP nodes in-process.

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` seam and error serialisation. |
| `libp2p` | **peer** (`^3.0.0`) | The node you build and own. |
| `@libp2p/interface` | **peer** (`^3.0.0`) | `Libp2p`, `PeerId`, `Stream` types. |
| `@multiformats/multiaddr` | **peer** (`^13.0.0`) | `Multiaddr` dial targets. |
| `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`, `@libp2p/tcp`, `@libp2p/utils` | dev | Two real in-process nodes for the test suite. |

No runtime dependencies outside the workspace. ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
