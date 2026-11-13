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
natively, there is no multiplexer on top: one call is one real libp2p stream.

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
| `PeerGoneError` | What a call fails with when the stream ended before both sides finished it: the peer died, the connection dropped, or the stream was reset after the peer's side ended. `cause` is libp2p's close error, if any. |
| `messageTargetOverStream(stream, options?)` | `{ target, signal }`: one stream as a pipe of `Uint8Array` messages for `multiplexPort` / `overPipe`, and an `AbortSignal` that aborts when the stream is over. `options.maxMessageBytes` caps one message. See below. |
| `libp2pPortMux(options)` | Native MessagePorts: a `webrun-rpc` `PortMux` (by shape) whose every port is its own libp2p stream, for `overPorts`. `options`: `node`, `codec` (a value codec: `{ encode: serialize, decode: deserialize }` from `webrun-msgpack`), `peer` (to open ports), `onPort(port, { remotePeer, connection })` (to accept them), `protocol`, `maxMessageSize`, stream limits. See "MessagePorts over libp2p" below. |
| `DEFAULT_PORT_PROTOCOL`, `DEFAULT_PORT_MAX_MESSAGE_SIZE` | `"/webrun-ports/1.0.0"`, 256 KiB. |
| `DEFAULT_PROTOCOL` | `"/webrun-streams/1.0.0"`. |
| `DEFAULT_DRAIN_TIMEOUT_MS` | `300_000` (5 minutes). |
| `DEFAULT_CLOSE_TIMEOUT_MS` | `300_000` (5 minutes), the bound on a graceful close. |
| `DEFAULT_MAX_MESSAGE_BYTES` | `67_108_864` (64 MiB), `messageTargetOverStream`'s cap on one message. |
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
- **The peer dies** (its process is killed, the network drops, the connection
  is aborted). The call's output throws `PeerGoneError`, `webrun-streams-libp2p:
  the stream ended before the call finished`, within milliseconds of libp2p
  noticing, whether or not the caller's input is still open. It never ends
  cleanly: a clean end requires the peer's own close-write
  (`remoteCloseWrite`), because when a connection dies libp2p closes the
  stream with no error and its iterator ends exactly as after a close-write.
  Without that rule a truncated response reads as a complete one. A peer
  that ended its side and then died while this side was still sending fails
  the same way; the input is returned instead of waited on. A peer that
  resets the stream before ending its side throws libp2p's `StreamResetError`;
  one that resets it after (a tunnel whose far end gave up) throws
  `PeerGoneError` with the `StreamResetError` as `cause`. Either way the
  error says the call is incomplete — `PeerGoneError` does not prove the
  peer died, only that the stream ended before both sides finished it.
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
  A caller that sent its whole request and then stopped reading the response
  (`.return()` mid-stream) is ordinary and is not logged.

### MessagePorts over libp2p, and the port stack on them

`connect` / `serve` above stream each call's bytes straight onto a libp2p
stream, and so inherit libp2p's buffering: a consumer that stops reading does
not slow its producer (see Tests, L6). `webrun-rpc`'s port stack does: each
call's chunk waits for the peer's confirmation that its consumer pulled the
last one, so a producer is never more than a chunk ahead, whatever the
transport buffers underneath. Two ways to put libp2p under it:

```ts
import { deserialize, msgpackCodec, serialize } from "@statewalker/webrun-msgpack";
import { connect, overPipe, overPorts, serve } from "@statewalker/webrun-rpc";
import { libp2pPortMux, messageTargetOverStream } from "@statewalker/webrun-streams-libp2p";

// 1. native ports: one libp2p stream per port, multiplexed by yamux
const codec = { encode: serialize, decode: deserialize };
await serve({ mux: overPorts((onPort) => libp2pPortMux({ node, codec, onPort })) }, handler);
const { call } = await connect({ mux: overPorts(() => libp2pPortMux({ node, codec, peer })) });

// 2. emulated ports: one libp2p stream, multiplexPort inventing the ports on it
const { target, signal } = messageTargetOverStream(await node.dialProtocol(peer, ["/my-mux/1.0.0"]));
const pipe = await connect({ mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal }) });
```

Both pass the shared conformance suite, including L6 at a one-chunk bound
(`tests/port-mux.test.ts`). Which to use:

| | native (`libp2pPortMux`) | emulated (`overPipe` on one stream) |
| --- | --- | --- |
| multiplexing | yamux: per-stream windows, scheduling | `multiplexPort`'s id table |
| a call costs | a stream open (a protocol negotiation) | nothing on the wire |
| limits | a stream per concurrent call: `maxInboundStreams` / `maxOutboundStreams`, 1024 by default here (libp2p's own default, 32, would reset the 33rd call) | `maxPorts` |
| one slow call | holds its own stream only | shares the stream; `frameSize` interleaves |
| who is calling | `onPort` gets `{ remotePeer, connection }` | the stream's connection, once |
| 4 MiB echo, in-process TCP, setup excluded (three runs) | 35–38 MiB/s (64 KiB chunks), 71–88 MiB/s (256 KiB) | 37–48 MiB/s, 79–87 MiB/s |

Each native port carries `closeSignal`, aborted when its stream ends, the peer
goes, or the port is closed here; `webrun-rpc`'s `getPortCloseSignal` reads it
from the port, so a call on a dead stream fails instead of waiting, and this
package still imports nothing from `webrun-rpc`. Ports are opened through the
same early-stream gate as `connect()`. A port `onPort` refuses (returns
`false`) is aborted: the opener's signal aborts with `PeerGoneError` and a call
on it fails. A frame the port's codec cannot decode (a peer speaking another
codec) aborts the port rather than vanish. `meta` is not sent: the
protocol says what a port is for. Messages are values (objects holding
`Uint8Array` chunks), so a port needs a value codec where `overPipe` needs a
`PortCodec`.

### A multiplexer over one stream closes with it

`multiplexPort` (from `@statewalker/webrun-rpc`) can run many ports over one
stream. A multiplexer cannot see its pipe die, so wire the stream's life to it:

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { multiplexPort } from "@statewalker/webrun-rpc";
import { messageTargetOverStream } from "@statewalker/webrun-streams-libp2p";

const { target, signal } = messageTargetOverStream(await node.dialProtocol(peer, ["/my-mux/1.0.0"]));
const mux = multiplexPort(target, { codec: msgpackCodec, side: "initiator", signal });
```

`signal` aborts on the stream's `close` (with `PeerGoneError` when the
connection died) and on the peer's close-write — after the read loop has
delivered every message the peer sent before it, so a reply followed by a
close is not lost to a multiplexer that tears down on `signal`. Unwired, every port and every
call on a dead stream waits forever. Wired, 100 ports on a SIGKILLed peer all
close within the test's 1 s bound. A stream closes when its connection does,
so this also covers a peer that dies while no data is flowing.

Frames are `[varint length][bytes]`. Reading starts at once, so attach the
`message` listener in the same tick (`multiplexPort` does). `postMessage`
does not wait for room, and libp2p resets a stream whose write buffer passes
`maxWriteBufferLength`. The target reports its state instead:
`bufferedAmount` is the stream's write buffer, and `whenDrained()` resolves
on libp2p's `drain` (or the stream's `close`, so no sender is left waiting),
at once when the stream has room. A sender that must not overrun the buffer
awaits it before posting more.

A length prefix that is not a valid varint, or one past `maxMessageBytes`
(default `DEFAULT_MAX_MESSAGE_BYTES`, 64 MiB), aborts the stream and `signal`
with `webrun-streams-libp2p: a malformed message length` or `… exceeds
maxMessageBytes`: a peer not speaking this framing would otherwise make the
reader buffer without bound. Raise it with
`messageTargetOverStream(stream, { maxMessageBytes })` for larger messages.

### Constraints

- On the serving side, request bytes are queued for the handler without a
  bound; backpressure applies to the handler's output, not to its input.
- `duplexOverStream` must start reading the stream without an intervening
  `await`: end of input arrives as an event, and one delivered before the
  iterator subscribes is lost. Every path inside the package keeps this.

### Tests

`pnpm test` runs the backpressure, drain and close timeout, cancellation,
identity, burst, stream-limit and serving-resilience tests against two real
in-process TCP nodes. `dead-peer.test.ts` kills the peer two ways, aborting
its connection in-process and SIGKILLing a forked server
(`tests/fixtures/greeting-server.ts`, run with `tsx`), with 100 open channels
each; every channel must fail with an error within 1 s. The shared conformance suite is opt-in because it spins
up more nodes: `WEBRUN_STREAMS_LIBP2P=1 pnpm test`. It runs with
`skipHugeBody`.

**Run-ahead is bounded for `connect` / `serve`** (spec D17, L6;
`tests/run-ahead.test.ts`, always on). L6 first found none: a consumer that
stopped reading let the producer run 22-24 MiB ahead until libp2p's 4 MiB read
buffer killed the stream. Two things buffered without limit:

- **libp2p's stream iterator** moves every message into an unbounded queue as
  it arrives, and **yamux grants its peer receive window on arrival**, not on
  consumption. The inbound side now reads through its own queue: past
  `readHighWaterBytes` (default 64 KiB) the stream is paused, which makes yamux
  withhold window updates, and it is resumed once the consumer has read half.
- **`serve` pushed every request chunk to the handler's input queue** without
  waiting. Past the same 64 KiB it now waits until the handler has read the
  queue back down. Once the handler's output has ended, input it never started
  to read is dropped instead of waited for; input it is reading (a background
  reader, say) keeps flowing at its pace. A handler that keeps its input
  iterator, stops reading it and keeps producing output now makes the caller's
  sends wait, and after `drainTimeoutMs` (5 minutes) abort the stream, where
  the input used to be buffered without limit.

The bound is then **two receive windows plus those queues**: a resume hands
over what libp2p held while paused (up to the window granted before the
pause) as one message, and the muxer grants a new window. Measured with a
1 MiB window: 1.06 MiB when the consumer stalls at once, 2.00 MiB when it
reads and stalls by turns; with yamux's default (16 MiB) up to 32 MiB per
stalled stream. Cap the window on nodes that serve or call with large
bodies: `yamux({ streamOptions: { maxStreamWindowSize: 1024 * 1024 } })` (the
option sits under `streamOptions`; set at the top level it is ignored, which is
why an earlier attempt to cap it "did not bound it"). yamux's default window
exceeds libp2p's default read buffer, so a paused stream raises its
`maxReadBufferLength` to the window plus the high-water mark rather than be
killed for buffering what it was allowed to receive. The pause is used only
where the muxer exposes its window (yamux's `maxStreamWindowSize`): on a
stream whose muxer does not withhold window when paused, pausing would only
move the data into libp2p's read buffer and get the stream aborted, so such a
stream is read as before, without a bound.

Review of #112 found, and tests now cover: a pause issued from inside
`resume()` (whose synchronous dispatch can refill the queue) was undone by the
muxer's own resume that follows it, leaving libp2p paused while yamux granted
window for every frame — run-ahead grew until the stream was aborted, with a
consumer that reads and stalls by turns; the message a resume dispatches (up
to a window) is now queued in high-water-sized pieces, so a frame parser
holding it does not hold a window outside the count; and a handler reading its
input after its output ended was cut off.

One-way throughput is unchanged (64 MiB over in-process TCP, 64 KiB chunks: up
105-113, down 129-163 MiB/s before and after; 256 KiB chunks: 156-179 /
184-219). An echo of 64 KiB chunks is slower (about 45 vs 65 MiB/s): it
profited from the server reading the whole request ahead, which is the
buffering removed. The port stack over libp2p (native or emulated ports,
above) stays bounded at one chunk.

Mutants, each killed by `tests/run-ahead.test.ts`: the reader never pauses (L6
past the bound), never resumes (the stalled transfer never completes), no
read-buffer raise (yamux's default window: the stream is aborted), `serve` not
waiting on the handler's queue (L6 request), no drop once the handler's output
ended (a handler that never reads its input hangs the call), a pause inside
`resume()` (reads and stalls by turns: aborted), the resumed message not split
(2.94 MiB past a 1 MiB window), input dropped although its reader started (a
background reader cut off). Not covered by a test: the pause skipped for a
muxer without a window (no such muxer in the test nodes).

`messageTargetOverStream` (review of the port work) now also aborts its
`signal` for a stream that ended before the target was attached: a peer that
reset the stream during protocol negotiation left its `close` event unseen and
the signal never aborted.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): the seam types and
  `serializeError` / `deserializeError`.
- `@libp2p/interface`, `@multiformats/multiaddr` (peers, types only) and
  `libp2p` (optional peer). Dev dependencies `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@libp2p/tcp` and `@libp2p/utils` build the test
  nodes; `@statewalker/webrun-rpc` and `@statewalker/webrun-msgpack` run the
  multiplexer tests, and `tsx` runs the forked server.

## License

MIT
