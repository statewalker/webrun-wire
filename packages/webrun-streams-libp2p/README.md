# @statewalker/webrun-streams-libp2p

## What it is

A libp2p adapter for the `Duplex` seam from `@statewalker/webrun-streams`.
Each `call(input)` is one port of a windowed native port mux: one new libp2p
`Stream`, negotiating `<protocol>/ports/window`, over which `webrun-rpc`'s
stream tier runs the call. The serving side handles that protocol and runs a
handler per call. The default `protocol` is `/webrun-streams/1.0.0`. It targets
libp2p 3.x. `serveConnections` additionally tells the handler which peer libp2p
authenticated on the connection.

Releases up to 0.6.0 ran each call straight on a stream negotiating `protocol`
itself, with their own flow control. That protocol is **deprecated** and kept,
on both ends, for one release: a new server still answers old callers on it,
and a new caller falls back to it against an old server (see "Compatibility
with 0.6.0 and older").

## Why it exists

libp2p solves transport negotiation, NAT traversal, relaying and authenticated
peer identity. What it gives an application is a `Stream`, not a request. This
adapter binds a stream to the `Duplex` shape, so a handler written once runs
over libp2p as it does over any other adapter. Because libp2p multiplexes
natively, there is no multiplexer on top: one call is one real libp2p stream.

What the adapter adds on top of a raw stream:

- **One flow control, bounded.** The port's credit window (default 4 MiB) is
  the only flow control: up to a window is in flight per round trip, and a
  producer never runs more than about a window ahead of a consumer that stopped
  reading, whatever libp2p buffers (statewalker/webrun-wire#153). It is the
  same stack every other `webrun-rpc` transport runs.
- **A bounded send-ahead, and a stall bound** (statewalker/webrun-wire#195). A
  sender runs at most min(the peer's window, its own window) ahead, whatever
  window the peer announces (up to 4 GiB), and writes nothing while the stream
  needs to drain, so a peer that stops reading at the transport holds about one
  frame of this end's memory. A write that has waited for drain longer than
  `drainTimeoutMs` (default 5 minutes) resets the stream; a quiet call (an event
  stream between events) is never timed out.
- **Error fidelity.** A handler's `Error` reaches the caller with `message`,
  `stack` and custom fields.
- **Cancellation** in both directions: a caller's `.return()` ends the call at
  once, and the handler's `finally` runs.
- **A guard against a burst of calls on a fresh connection**, which would
  otherwise kill the connection's muxer.
- **Caller identity** for the serving side, through `serveConnections`.

## How to use

```sh
pnpm add @statewalker/webrun-streams-libp2p @libp2p/interface @multiformats/multiaddr
```

Runtime dependencies: `@statewalker/webrun-streams`, `@statewalker/webrun-rpc`
(the port stack `connect`/`serve` run) and `@statewalker/webrun-msgpack` (the
calls' wire codec). Peer dependencies:

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
| `connect(params)` | `Connect<ConnectLibp2pParams>`. Resolves `{ call, close }` immediately (no dial yet). Each `call(input)` opens one port (one stream). `close()` closes every port this `connect` still holds open. |
| `serve(params, handler)` | `Serve<ServeLibp2pParams>`. Handles `<protocol>/ports` (with and without `/window`) and, deprecated, `protocol`; runs `handler` per call. Resolves to an idempotent teardown that unhandles all of them. |
| `serveConnections(params, makeHandler)` | Like `serve`, but `makeHandler(context)` is called once per call with `{ remotePeer }`, and returns that call's `Duplex`. |
| `DEFAULT_WINDOW` | `4194304` (4 MiB), the port window `connect`/`serve` grant unless told otherwise. See "Sizing the window". |
| `portProtocolOf(protocol)` | `protocol + "/ports"`: what a call's stream negotiates (with `/window` appended between two windowed ends). |
| `DEFAULT_PROTOCOL` | `"/webrun-streams/1.0.0"`. |
| `duplexOverStream(stream, input, options?)` | **Deprecated.** The deprecated protocol's primitive: runs one call over one libp2p `Stream`. Removed in the next release. |
| `PeerGoneError` | What a call fails with when its stream ended before the call finished: the peer died, the connection dropped, or the stream was reset. `cause` is libp2p's close error, if any. |
| `messageTargetOverStream(stream, options?)` | `{ target, signal }`: one stream as a pipe of `Uint8Array` messages for `multiplexPort` / `overPipe`, and an `AbortSignal` that aborts when the stream is over. `options.maxMessageBytes` caps one message. See below. |
| `libp2pPortMux(options)` | Native MessagePorts: a `webrun-rpc` `PortMux` (by shape) whose every port is its own libp2p stream, for `overPorts`; what `connect`/`serve` run on. `options`: `node`, `codec` (a value codec: `{ encode: serialize, decode: deserialize }` from `webrun-msgpack`), `peer` (to open ports), `onPort(port, { remotePeer, connection })` (to accept them), `protocol`, `maxMessageSize`, stream limits, `window`, `drainTimeoutMs` (default `DEFAULT_DRAIN_TIMEOUT_MS`). The port lifecycle (codec wrapping, messages held until a port's first listener, close signals, accept/refuse, the caller's signal, close-all) is the shared `newNativePortMux` from `@statewalker/webrun-streams`; `describePortMux` (`webrun-streams-conformance`) is its contract, run against this transport too. See "MessagePorts over libp2p" below. |
| `DEFAULT_PORT_PROTOCOL`, `DEFAULT_PORT_MAX_MESSAGE_SIZE` | `"/webrun-ports/1.0.0"`, 256 KiB. |
| `DEFAULT_DRAIN_TIMEOUT_MS` | `300_000` (5 minutes): how long a write waits for a stream to drain before the stream is reset (`drainTimeoutMs`). |
| `DEFAULT_CLOSE_TIMEOUT_MS` | **Deprecated** (the deprecated protocol only). `300_000` (5 minutes), the bound on a graceful close. |
| `DEFAULT_MAX_MESSAGE_BYTES` | `67_108_864` (64 MiB), `messageTargetOverStream`'s cap on one message. |
| `DEFAULT_MAX_FRAME_BYTES` | `67_108_864` (64 MiB), the default cap on one inbound frame (`maxFrameBytes`). |
| `ConnectLibp2pParams`, `ServeLibp2pParams`, `ConnectionContext`, `ServeConnectionsHandler`, `DuplexOverStreamOptions` | Types, below. |

`ConnectLibp2pParams`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `node` | `Libp2p` | required | The local node. Only `dialProtocol` is required; `getConnections` is used when present. |
| `peer` | `PeerId \| Multiaddr` | required | Who to dial. |
| `protocol` | `string` | `DEFAULT_PROTOCOL` | The protocol id both ends are configured with. Calls negotiate `portProtocolOf(protocol)`; `protocol` itself is the deprecated fallback. |
| `window` | `number` | `DEFAULT_WINDOW` (4 MiB) | The port window in bytes, at least 64 KiB: the most this end holds of a response delivered and not yet read, and the most it sends ahead of the server (min of both ends' windows). See "Sizing the window". |
| `timeout` | `number` | none | Per-call inactivity timeout in ms, reset by any chunk in either direction. Unset, a slow consumer is throttled, never failed. |
| `maxFrameBytes` | `number` | `DEFAULT_MAX_FRAME_BYTES` | The largest frame accepted from the peer. Past it, or on a malformed frame length, the call fails and the stream is aborted. |
| `maxOutboundStreams` | `number` | libp2p's (64) | Passed to `dialProtocol`. |
| `runOnLimitedConnection` | `boolean` | unset | Passed to `dialProtocol`. Allows relayed or otherwise limited connections. |
| `drainTimeoutMs` | `number` | `DEFAULT_DRAIN_TIMEOUT_MS` (5 min) | How long a write may wait for the stream to drain before the stream is reset and the call fails. Only a write blocked on drain counts. Both protocols. |
| `readHighWaterBytes` | `number` | 64 KiB | **Deprecated**: the deprecated protocol only (an older server). |

`ServeLibp2pParams`: `node`, `protocol`, `window`, `timeout`, `maxFrameBytes`,
`maxOutboundStreams` and `runOnLimitedConnection` as above (passed to
`node.handle` for each served protocol), plus `maxInboundStreams` (libp2p
default 32), `drainTimeoutMs` as above (a stalled caller is dropped after it),
and the deprecated `readHighWaterBytes` (older callers only). The server's
`window` bounds what a call sends ahead of the handler, and what a response
runs ahead of its caller, whatever window the caller announces.

`ConnectionContext`: `{ remotePeer: PeerId }`.
`ServeConnectionsHandler`: `(context: ConnectionContext) => Duplex`.

`DuplexOverStreamOptions` (**deprecated**, with `duplexOverStream`):

| Field | Meaning |
| --- | --- |
| `onPeerInputEnd?(err?)` | Called once when the peer's side ends: closed, `ERROR` frame (passed as `err`) or torn down. |
| `onSourceCompleted?()` | Called only when the peer's side ended normally. |
| `drainTimeoutMs?` | How long a backpressured send waits for `'drain'`. |
| `readHighWaterBytes?` | Received bytes held for a consumer that is not reading before the stream is paused. |
| `maxFrameBytes?` | As above. |

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

### A call is a port

`connect` builds a `libp2pPortMux` for `portProtocolOf(protocol)` with
`window` (default `DEFAULT_WINDOW`) and hands it to `webrun-rpc`'s `connect`
through `overPorts`; `serve` does the same with `webrun-rpc`'s `serve`. So one
call is one port, one port is one libp2p stream, and the stream tier
(`duplexOverPort`) runs the call: its chunks (at most 256 KiB each) go as
msgpack messages, pipelined up to the peer's window, and the window's credit
is their confirmation. yamux still multiplexes the streams, but its windows no
longer bound anything this package promises: the port's credit bounds what is
in flight per call. There is no flow control of this package's own any more;
the bespoke yamux pause/resume run-ahead bound of the deprecated protocol goes
with it in the next release.

Both ends of a call between two releases from this one on always run the
window, so a call's stream negotiates `<protocol>/ports/window`; the mux also
serves (and dials, second) `<protocol>/ports`, unwindowed.

### Sizing the window

A call moves at most one window per round trip, so its throughput is capped at
`window / RTT`, and a producer runs at most about one window (plus a chunk at
each end) ahead of a consumer that stopped reading. Size it at least to the
link's bandwidth-delay product:

| Link | BDP | Window |
| --- | --- | --- |
| LAN, 1 Gbit/s at 1 ms | 125 KB | the 64 KiB floor would cap it; 1 MiB is ample |
| 70 Mbit/s at 11 ms | 96 KB | 1 MiB |
| 200 Mbit/s at 100 ms | 2.5 MB | the 4 MiB default |
| 1 Gbit/s at 100 ms | 12.5 MB | 16 MiB |

Measured over an emulated 100 ms / 200 Mbit/s link (statewalker/webrun-wire#153):
a 1 MiB window capped a 16 MiB echo at 7.4 MiB/s, the 4 MiB window reached
15 MiB/s, as fast as the deprecated protocol. Far above the bottleneck's queue a
window only adds latency (bufferbloat): on an 11 ms link 4 MiB was slower than
1 MiB. Both ends set their own window: the caller's bounds the response, the
server's the request. Memory per call is bounded by the window, so a server
with many concurrent calls may want a smaller one.

### Compatibility with 0.6.0 and older

Deprecated shims, on both ends, for one release; removed in the next one:

- **New server, old caller.** `serve`/`serveConnections` also handle
  `protocol` itself with the deprecated protocol (`legacy-connect-serve.ts`),
  so an old `connect` keeps working.
- **New caller, old server.** An old server refuses `<protocol>/ports…`
  (libp2p's `UnsupportedProtocolError`, before any of the call's input is
  read), and the call runs on `protocol` instead. The node remembers the
  refusal per peer and protocol for that connection, so later calls, from any
  `connect()` on the node, dial `protocol` directly; a new connection (the peer
  restarted, perhaps upgraded) is probed again. The first call to an old server
  costs one extra protocol negotiation.

`tests/interop-0-6.test.ts` runs the conformance suite (L0–L6) and the cases
above against the published 0.6.0 in both directions.

Behaviour that differs from the deprecated protocol:

- **A call ends with the peer's output.** When the handler's output ends, the
  call ends: input the caller has not sent yet is abandoned, and a handler
  still reading its input is told the caller abandoned the stream. The
  deprecated protocol kept sending until the input ended too.
- **The drain timeout counts only a blocked write.** A peer that stops
  consuming holds at most a window per call (its credit stops); one that stops
  reading at the transport holds about one frame, and is dropped after
  `drainTimeoutMs`. Set `timeout` to fail idle calls. `readHighWaterBytes`
  applies to the deprecated protocol only.
- **Chunks.** A response arrives in chunks of up to 256 KiB (64 KiB before).
- **Failures on the serving side are not logged**: they reach the handler
  (its input throws) and the caller.

### The deprecated protocol

The sections below describe the deprecated protocol, which `serve` still
answers and `connect` falls back to until the next release.

#### Frames on the stream

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

A producer chunk larger than 64 KiB is sent as several `DATA` frames of at most
64 KiB each. Frames are self-delimiting and a receiver yields each `DATA`
payload as it completes, so a receiver of any version reassembles the same
bytes; only the chunk boundaries the consumer sees change. The receiver keeps
unread bytes in a buffer that grows by doubling, so a large frame arriving in
many pieces is copied a bounded number of times. A frame length past
`maxFrameBytes` (default 64 MiB), or one that is not a valid varint, fails the
call with `webrun-streams-libp2p: a <n>-byte frame exceeds maxFrameBytes (<cap>)`
or `webrun-streams-libp2p: a malformed frame length`, and aborts the stream:
a peer not speaking this framing would otherwise make the receiver buffer
without bound. On the serving side the handler's input throws that error.

#### Why identity reaches the handler by closure

`Duplex` is bytes-only, so `serveConnections` passes identity to a factory
instead of to the handler. `remotePeer` is `connection.remotePeer`, the peer id
libp2p proved when the connection was encrypted. It is the one identity claim
on the serving side that a request payload cannot forge, and no caller can
influence it. `makeHandler` runs once per inbound stream; keep per-peer state
inside it. Reusing one handler built outside it for every connection is how
identity-by-closure gets broken. `serve` is `serveConnections` with the context
ignored, so both share framing, teardown and failure handling.

#### Why sends wait for the `'drain'` event

libp2p 3.x streams are push-based: `stream.send(chunk)` returns `false` when
the write buffer is full, and the stream emits `'drain'` when it can take
more. The outbound pump honours that return value and waits for the real
`'drain'` event. It does not use `stream.onDrain()`: in `@libp2p/utils` (7.4.1
at the time of writing) that method creates one promise and never clears it,
so after the first backpressure cycle it resolves immediately while the buffer
is still full, and a write loop built on it fills the buffer without bound.
`tests/backpressure.test.ts` covers this.

#### Why both timeouts are minutes, not seconds

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

#### How calls end

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

### MessagePorts over libp2p, and the port stack on them

`connect` / `serve` above are the first of the two ways below, with a window
and msgpack set for you. Use the port mux directly to choose the codec, the
chunk size or the multiplexing, or to put other port users on the same node.
`webrun-rpc`'s port stack bounds a producer to its consumer whatever the
transport buffers underneath: each chunk waits for the peer's confirmation, or,
on a windowed port, for the window's credit. Two ways to put libp2p under it:

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

**A window per port.** By default the stream tier waits for each chunk's
confirmation on a native port, so one call moves one chunk (256 KiB) per round
trip. With `window: n` (bytes) on both ends, a port's stream negotiates
`windowProtocolOf(protocol)` (`protocol` + `/window`), each end grants the other
`n` bytes of messages delivered and not yet consumed, and the stream tier
pipelines its chunks up to the peer's window (statewalker/webrun-wire#153). A
mux with `window` dials the windowed protocol first and falls back to
`protocol`, and serves both, so it works against an older peer, unwindowed.
`describePortWindow` (`webrun-streams-conformance`) and L6 at the window's bound
run against it (`tests/port-window.test.ts`).

Each native port carries `closeSignal`, aborted when its stream ends, the peer
goes, or the port is closed here; `webrun-rpc`'s `getPortCloseSignal` reads it
from the port, so a call on a dead stream fails instead of waiting, and
`libp2pPortMux` itself imports nothing from `webrun-rpc`. Ports are opened through the
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
takes a `Uint8Array`, an `ArrayBuffer` or another view, and throws `TypeError`
for anything else, as the other adapters' byte pipes do. It does not wait for
room, and libp2p resets a stream whose write buffer passes
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

The two below concern the deprecated protocol.

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
each; every channel must fail with an error within 1 s. The shared conformance
suite (`tests/conformance.test.ts`, about 7 s) runs in the same `pnpm test`, with
`skipHugeBody`, for `connect`/`serve` and for the deprecated protocol on both
ends.

**`connect`/`serve` over the windowed port mux** (`tests/connect-over-ports.test.ts`):
the protocol ids negotiated, the 4 MiB default window and a 1 MiB `window`
option holding a producer to the window (L6, in both directions, over yamux's
16 MiB stream window), identity per call, and the window floor.
**Interop** (`tests/interop-0-6.test.ts`): the conformance suite L0–L6 and the
fallback cases between this release and the published 0.6.0
(`webrun-streams-libp2p-0-6`, an npm alias), old caller to new server and new
caller to old server.

**Run-ahead is bounded for the deprecated protocol** (spec D17, L6;
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

- `@statewalker/webrun-streams` (`workspace:^`): the seam types, the native
  port mux and `serializeError` / `deserializeError`.
- `@statewalker/webrun-rpc` (`workspace:^`): the port stack `connect`/`serve`
  run (`connect`, `serve`, `overPorts`).
- `@statewalker/webrun-msgpack` (`workspace:^`): the calls' value codec.
- `@libp2p/interface`, `@multiformats/multiaddr` (peers, types only) and
  `libp2p` (optional peer). Dev dependencies `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@libp2p/tcp` and `@libp2p/utils` build the test
  nodes, `webrun-streams-libp2p-0-6` (the published 0.6.0) is the old peer of
  the interop tests, and `tsx` runs the forked server.

## License

MIT
