# @statewalker/webrun-streams-libp2p

## What it is

A libp2p adapter for the `Duplex` seam from `@statewalker/webrun-streams`.
Each `call(input)` opens one new libp2p `Stream` with
`node.dialProtocol(peer, [protocol])`; the serving side registers with
`node.handle(protocol, …)` and runs a handler per inbound stream. The default
protocol id is `/webrun-streams/1.0.0`. It targets libp2p 3.x. `serveConnections`
additionally tells the handler which peer libp2p authenticated on the
connection.

## Why it exists

libp2p solves transport negotiation, NAT traversal, relaying and authenticated
peer identity. What it gives an application is a `Stream`, not a request. This
adapter binds a stream to the `Duplex` shape, so a handler written once runs
over libp2p as it does over any other adapter. Because libp2p multiplexes
natively, there is no `emulateMux`: one call is one real libp2p stream.

What the adapter adds on top of a raw stream:

- **Error fidelity.** A yamux reset carries no message. An in-band `ERROR`
  frame carries the handler's `Error` with `message`, `stack` and custom
  fields.
- **Backpressure** that follows libp2p 3.x's push-based `send()` / `'drain'`
  model, with a bound for peers that stop reading.
- **Cancellation** in both directions: a caller's `.return()` resets the
  stream, and the handler's `finally` runs.
- **A guard against a burst of calls on a fresh connection**, which would
  otherwise kill the connection's muxer.
- **Caller identity** for the serving side, through `serveConnections`.

## How to use

```sh
pnpm add @statewalker/webrun-streams-libp2p @libp2p/interface @multiformats/multiaddr
```

Runtime dependency: `@statewalker/webrun-streams`. Peer dependencies:

| Peer | Range | Required |
| --- | --- | --- |
| `@libp2p/interface` | `^3.0.0` | yes (types: `Libp2p`, `PeerId`, `Stream`, `Connection`) |
| `@multiformats/multiaddr` | `^13.0.0` | yes (type: `Multiaddr` dial targets) |
| `libp2p` | `^3.0.0` | optional; you build and own the node, with its transports, encryption and muxers |

Both required peers are used for types only; at runtime the package calls the
node you pass in. One entry point, `.`. It runs wherever your libp2p node
runs (Node or browser).

| Export | What it gives |
| --- | --- |
| `connect(params)` | `Connect<ConnectLibp2pParams>`. Resolves `{ call, close }` immediately (no dial yet). Each `call(input)` dials one stream. `close()` aborts every stream this `connect` still holds open. |
| `serve(params, handler)` | `Serve<ServeLibp2pParams>`. `node.handle(protocol)`; runs `handler` per inbound stream. Resolves to an idempotent teardown that calls `node.unhandle(protocol)`. |
| `serveConnections(params, makeHandler)` | Like `serve`, but `makeHandler(context)` is called once per inbound stream with `{ remotePeer }`, and returns that stream's `Duplex`. |
| `duplexOverStream(stream, input, options?)` | The primitive under both: runs one call over one libp2p `Stream`. Returns an `AsyncGenerator<Uint8Array>` of the peer's bytes. |
| `DEFAULT_PROTOCOL` | `"/webrun-streams/1.0.0"`. |
| `DEFAULT_DRAIN_TIMEOUT_MS` | `300_000` (5 minutes). |
| `DEFAULT_CLOSE_TIMEOUT_MS` | `300_000` (5 minutes), the bound on a graceful close. |
| `ConnectLibp2pParams`, `ServeLibp2pParams`, `ConnectionContext`, `ServeConnectionsHandler`, `DuplexOverStreamOptions` | Types, below. |

`ConnectLibp2pParams`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `node` | `Libp2p` | required | The local node. Only `dialProtocol` is required; `getConnections` is used when present. |
| `peer` | `PeerId \| Multiaddr` | required | Who to dial. |
| `protocol` | `string` | `DEFAULT_PROTOCOL` | Protocol id. |
| `drainTimeoutMs` | `number` | `300_000` | How long a backpressured send waits for `'drain'`. |
| `maxOutboundStreams` | `number` | libp2p's (64) | Passed to `dialProtocol`. |
| `runOnLimitedConnection` | `boolean` | unset | Passed to `dialProtocol`. Allows relayed or otherwise limited connections. |

`ServeLibp2pParams`: `node`, `protocol`, `drainTimeoutMs`,
`maxOutboundStreams` and `runOnLimitedConnection` as above (passed to
`node.handle`), plus `maxInboundStreams` (libp2p default 32).

`ConnectionContext`: `{ remotePeer: PeerId }`.
`ServeConnectionsHandler`: `(context: ConnectionContext) => Duplex`.

`DuplexOverStreamOptions`:

| Field | Meaning |
| --- | --- |
| `onPeerInputEnd?(err?)` | Called once when the peer's side ends: closed, `ERROR` frame (passed as `err`) or torn down. `serveConnections` uses it to end the handler's input. |
| `onSourceCompleted?()` | Called only when the peer's side ended normally. `connect` uses it to choose a graceful close over an abort. |
| `drainTimeoutMs?` | As above. |

## Examples

### Serve and call between two nodes

```ts
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";
import { collectBytes } from "@statewalker/webrun-streams";
import { connect, serve } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";

const options = { transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()] };
const server = await createLibp2p({ ...options, addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } });
const client = await createLibp2p(options);

const stop = await serve({ node: server }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});

const { call, close } = await connect({ node: client, peer: server.getMultiaddrs()[0] });
const reply = await collectBytes(call([new TextEncoder().encode("ping")]));
console.log(new TextDecoder().decode(reply)); // "ping"

await close();
await stop();
await client.stop();
await server.stop();
```

### Knowing who is calling

```ts
import { serveConnections } from "@statewalker/webrun-streams-libp2p";
import type { Libp2p } from "@libp2p/interface";

declare const node: Libp2p;

const stop = await serveConnections({ node }, ({ remotePeer }) => {
  const who = remotePeer.toString(); // proven by the connection's encryption handshake
  return async function* handler(input) {
    for await (const _ of input) {
      /* read the request */
    }
    yield new TextEncoder().encode(`hello ${who}`);
  };
});
```

### Raising stream limits

```ts
import { connect, serve } from "@statewalker/webrun-streams-libp2p";
import type { Libp2p, PeerId } from "@libp2p/interface";
import type { Duplex } from "@statewalker/webrun-streams";

declare const node: Libp2p;
declare const peer: PeerId;
declare const handler: Duplex;

const stop = await serve({ node, protocol: "/my-app/1.0.0", maxInboundStreams: 128 }, handler);
const { call } = await connect({ node, peer, protocol: "/my-app/1.0.0", maxOutboundStreams: 128 });
```

## Internals

### Frames on the stream

```
+--------+-----------------+-----------------+
| type   | length          | payload         |
| 1 byte | varint (LEB128) | length bytes    |
+--------+-----------------+-----------------+

DATA  0x00  body bytes
ERROR 0x02  JSON of serializeError(err)
```

A libp2p stream is a byte stream, so frames carry a length and are reassembled
from whatever chunks arrive. Normal end of input is libp2p's own
`close()` (close-write), not a frame. The `ERROR` frame exists because a yamux
reset carries only "stream reset"; without it, a handler that throws would
reach the caller as an anonymous reset. Frames of other types are skipped.

### Why identity reaches the handler by closure

`Duplex` is bytes-only, so `serveConnections` passes identity to a factory
instead of to the handler. `remotePeer` is `connection.remotePeer`, the peer id
libp2p proved when the connection was encrypted. It is the one identity claim
on the serving side that a request payload cannot forge, and no caller can
influence it. `makeHandler` runs once per inbound stream; keep per-peer state
inside it. Reusing one handler built outside it for every connection is how
identity-by-closure gets broken. `serve` is `serveConnections` with the context
ignored, so both share framing, teardown and failure handling.

### Why sends wait for the `'drain'` event

libp2p 3.x streams are push-based: `stream.send(chunk)` returns `false` when
the write buffer is full, and the stream emits `'drain'` when it can take
more. The outbound pump honours that return value and waits for the real
`'drain'` event. It does not use `stream.onDrain()`: in `@libp2p/utils` (7.4.1
at the time of writing) that method creates one promise and never clears it,
so after the first backpressure cycle it resolves immediately while the buffer
is still full, and a write loop built on it fills the buffer without bound.
`tests/backpressure.test.ts` covers this.

### Why both timeouts are minutes, not seconds

- **Drain timeout** (`DEFAULT_DRAIN_TIMEOUT_MS`, 5 minutes, `drainTimeoutMs`
  per call site). A peer that requests something and then stops reading,
  without closing or resetting, produces no event. Unbounded, it would park
  the serving side's pump, the handler and everything buffered behind it.
  5 minutes covers a peer draining a full yamux receive window (256 KiB by
  default) at under 1 KiB/s; a tighter bound would reset slow but alive peers,
  which is what backpressure exists to avoid. On expiry it logs
  `[webrun-streams-libp2p] waitForDrain: peer on protocol <p> did not accept more data within <ms>ms and never closed the stream; dropping it so this side's pump is not parked forever`
  and aborts the stream.
- **Close timeout** (`DEFAULT_CLOSE_TIMEOUT_MS`, 5 minutes). `stream.close()`
  waits for the write queue to drain, and that queue is shared by every stream
  on the muxer, so under many concurrent transfers a healthy close can take a
  long time. When the bound trips the stream is aborted, which truncates data
  in flight. With a 5-second bound, 18 concurrent 3.5 MB transfers over one
  connection mostly arrived truncated; minutes catch a peer that will never
  close just as well. On a trip it logs
  `[webrun-streams-libp2p] closeStream: graceful close of protocol <p> failed (bound <ms>ms), aborting instead (peer may see truncated data): <reason>`.
  The close timeout is not configurable through `connect` / `serve` params.

### Why a burst of calls is serialised on a fresh connection

With no connection to the peer yet, every call dials and they all share the
one connection libp2p establishes. Their streams can reach the remote while it
is still upgrading that connection. yamux counts those as early streams and,
past `maxEarlyStreams` (10 by default), aborts the whole muxer: every stream
on the connection dies, the remote sees EOF during protocol negotiation, and
this side sees `StreamResetError`. Raising the limit on your own nodes would
not help against other peers.

So until one stream has negotiated its protocol on an open connection, calls
open their streams one at a time; after that they open concurrently. If the
proven connection closes, the next burst is gated again (this re-check needs
`node.getConnections`; a node that offers only `dialProtocol` stays proven
after its first stream). The state is shared by every `connect()` to the same
peer from the same node, because callers often `connect()` per request.

### Stream limits

libp2p caps the number of open streams for one protocol per connection, and
past the cap a new stream is reset, not queued. One call is one stream, so a
caller with more concurrent calls than the cap sees calls rejected with no
other symptom. `maxInboundStreams`, `maxOutboundStreams` and
`runOnLimitedConnection` are passed through unchanged; an unset option is left
out of the options object so libp2p's own default applies (inbound 32,
outbound 64, limited connections refused). `tests/stream-limits.test.ts`
checks both that a raised `maxInboundStreams` admits more than 32 concurrent
streams and that an unconfigured server stops at 32.

### How calls end

- **Normal end.** Both sides finished: the stream is closed gracefully,
  bounded by the close timeout.
- **Caller cancels** (`.return()` on the call's generator). The adapter aborts
  the stream with `call cancelled` before the generator's own cleanup runs,
  because by then the stream is already marked closed and `abort` would do
  nothing. The caller's input iterator is returned without waiting: `.return()`
  on a generator parked in its own `next()` is queued behind that `next()`, and
  awaiting it would hang teardown.
- **Consumer of `duplexOverStream` stops early.** The stream is aborted with
  `duplexOverStream: consumer cancelled`, and the input is returned without
  waiting, as above.
- **Handler throws.** The error is sent as an `ERROR` frame; the caller's
  `for await` throws it with `message`, `stack` and custom fields.
- **Caller leaves mid-request on the serving side** (a tab closed, a reset).
  `serveConnections` catches the failure per stream and logs
  `[webrun-streams-libp2p] serve: inbound stream on protocol <p> failed: <message>`,
  so one failed stream never becomes an unhandled rejection that terminates
  the serving process. The handler's output is returned, so its `finally` runs.

### Constraints

- On the serving side, request bytes are queued for the handler without a
  bound; backpressure applies to the handler's output, not to its input.
- `duplexOverStream` must start reading the stream without an intervening
  `await`: end of input arrives as an event, and one delivered before the
  iterator subscribes is lost. Every path inside the package keeps this.

### Tests

`pnpm test` runs the backpressure, drain and close timeout, cancellation,
identity, burst, stream-limit and serving-resilience tests against two real
in-process TCP nodes. The shared conformance suite is opt-in because it spins
up more nodes: `WEBRUN_STREAMS_LIBP2P=1 pnpm test`. It runs with
`skipHugeBody`, and L6's small window does not apply (there is no
`emulateMux`), so L6 is an integrity check.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): the seam types and
  `serializeError` / `deserializeError`.
- `@libp2p/interface`, `@multiformats/multiaddr` (peers, types only) and
  `libp2p` (optional peer). Dev dependencies `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@libp2p/tcp` and `@libp2p/utils` build the test
  nodes.

## License

MIT
