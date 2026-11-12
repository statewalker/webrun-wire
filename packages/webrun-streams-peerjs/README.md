# @statewalker/webrun-streams-peerjs

## What it is

A `Connect` / `Serve` adapter that runs `@statewalker/webrun-streams` `Duplex` calls over a PeerJS
[`DataConnection`](https://peerjs.com/docs/#dataconnection). One connection becomes one
`ByteChannel`, and `webrun-streams`' `emulateMux` runs many concurrent calls over it. Your handler
is an ordinary `Duplex`, `(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>`, the
same function you would run over a WebSocket or a `MessagePort`.

## Why it exists

PeerJS is the least-effort route to a browser-to-browser connection: it ships a public broker, so
you get a working peer link without running signalling infrastructure. What it hands you is one
message pipe with no request framing, no concurrency, no half-close and no error propagation. This
adapter supplies those, so the transport becomes a detail: a handler prototyped over PeerJS runs
unchanged over any other `webrun-streams` adapter.

## How to use

```sh
pnpm add @statewalker/webrun-streams-peerjs peerjs
```

`peerjs` is a required peer dependency (`^1.5.5`). You create and own the `Peer`, its broker
configuration and its connections. Browser only in practice: PeerJS needs WebRTC. One entry point,
`.`, ESM only.

**Connections must use `serialization: "raw"`.** Otherwise PeerJS encodes the bytes itself and the
mux framing does not survive. The adapter checks and throws
`TypeError: byteChannelFromPeerJs: DataConnection serialization is '<value>', expected 'raw'`.

| Export | Purpose |
| --- | --- |
| `connect(params: ConnectPeerJsParams)` | `Connect`. Takes one open `DataConnection`. Resolves `{ call, close }`; each `call(input)` opens a new logical stream. `close()` ends the mux and closes the connection. |
| `serve(params: ServePeerJsParams, handler)` | `Serve`. Takes a `Peer`, serves `handler` on every inbound connection. Resolves an idempotent teardown. |
| `ConnectPeerJsParams` | `{ conn: DataConnection; mux?: EmulateMuxOptions }`. |
| `ServePeerJsParams` | `{ peer: Peer; mux?: EmulateMuxOptions }`. |
| `byteChannelFromPeerJs(conn)` | The `ByteChannel` both use, for driving `emulateMux` yourself. |
| `messageTargetOverPeerJs(conn, options?)` | **The port stack (Plan C2).** One open raw connection as `{ target, signal, maxMessageSize }`: a `MessageTarget` of bytes (one data channel message each) with `bufferedAmount` / `whenDrained()`, a signal that aborts when the connection closes or fails, and the payload ceiling to give `overPipe`. See below. |
| `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_MESSAGE_SIZE`, `DRAIN_LOW_WATER` | 16 KiB, 16 KiB − 256, 256 KiB: the defaults of the above. |

`mux` is forwarded to `emulateMux` (`mtu`, `maxStreamBuffer`, `maxStreams`, with `webrun-streams`'
defaults: 64 KiB, 8 MiB, 256). `side` is fixed by the function you call — `"initiator"` for
`connect`, `"responder"` for `serve` — and overrides `mux.side`.

`serve` takes the `Peer` because it accepts many inbound connections; `connect` takes one
connection you already opened.

## Examples

### Serving

```ts
import { Peer } from "peerjs";
import { serve } from "@statewalker/webrun-streams-peerjs";

const peer = new Peer("my-server-id");
await new Promise((resolve) => peer.on("open", resolve));

const stop = await serve({ peer }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});

// later: stop accepting, close every served connection's mux
await stop();
```

### Calling

```ts
import { Peer } from "peerjs";
import { connect } from "@statewalker/webrun-streams-peerjs";

const peer = new Peer();
await new Promise((resolve) => peer.on("open", resolve));

const conn = peer.connect("my-server-id", { serialization: "raw" });
await new Promise((resolve) => conn.on("open", resolve));

const { call, close } = await connect({ conn });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
```

### HTTP over the connection

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/todo"));
```

### The port stack over a connection

`connect` / `serve` above run `emulateMux`, which goes away in Plan C3. Its
replacement is `webrun-rpc`'s port stack: the connection is one pipe, `overPipe`
invents a port per call, and a producer stays at most one chunk ahead of its
consumer.

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { messageTargetOverPeerJs } from "@statewalker/webrun-streams-peerjs";

const conn = peer.connect(remoteId, { serialization: "raw", reliable: true });
// ...once conn is open:
const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
const { call, close } = await connect({
  mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
});
```

The responder does the same per inbound connection with `side: "responder"` and
`webrun-rpc`'s `serve`. Pass all three: `signal` closes the multiplexer when the
connection dies, and `maxMessageSize` chunks bodies under the frame limit.

**The message ceiling (measured).** PeerJS hands a raw message to the data
channel unchanged. Between two Chromiums a message of 262,143 bytes arrives; one
of 262,145 arrives as nothing, with no throw and no error event, and the
connection silently closes (`tests/message-ceiling.test.ts`, `test:browser`).
Firefox to Chrome cuts off at 16,384, as PeerJS itself records. So the pipe
defaults to `maxFrameBytes` 16 KiB, reports `maxMessageSize` 256 bytes under it
(the port stack's framing adds up to 134), and a post past `maxFrameBytes` ends
the pipe with a `RangeError` instead of vanishing. Raise `maxFrameBytes` only
for peers known to allow more.

Inbound data that is not bytes ends the pipe with a `TypeError`; dropping it
would lose an envelope and hang its call. `whenDrained()` resolves once PeerJS's
own queue is empty and `bufferedAmount` is at most 256 KiB.

### Driving the mux yourself

```ts
import { emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromPeerJs } from "@statewalker/webrun-streams-peerjs";

const channel = byteChannelFromPeerJs(conn); // conn opened with serialization: "raw"
const mux = emulateMux(channel, { side: "initiator" });
// mux.call(input), mux.serve(handler), mux.close()
```

## Internals

```
 handler / caller (Duplex)
          │
   emulateMux (webrun-streams): framed streams, credit flow control
          │
   byteChannelFromPeerJs: one ByteChannel per DataConnection
          │  out: conn.send(bytes)        in: "data" events
          ▼
   PeerJS DataConnection (serialization: "raw") ── WebRTC data channel
```

### What the channel accepts, and what it drops

Inbound `data` may be a `Uint8Array`, an `ArrayBuffer`, any `ArrayBufferView` or a `Blob` (read
asynchronously); each is copied into a fresh `Uint8Array`. Anything else is ignored. Outbound
`send` is a silent no-op while `conn.open` is false, so **wait for the connection's `open` event
before `connect`**; bytes sent earlier are lost without an error.

### What closes the channel, and what you see

The channel closes on the connection's `close` event or when its `close()` is called. In-flight
and later calls then fail with `webrun-streams`' `TransportClosedError`. On the serving side each
inbound connection gets its own mux, created when the connection opens and closed when the
connection closes. A connection that arrives without `serialization: "raw"` makes the adapter
throw the `TypeError` above inside the connection's `open` handler, and that connection is not
served.

The serve teardown removes the `connection` listener and closes every mux it created. Muxes are
kept in a list until then, including those whose connection already closed.

### Conformance runs in a browser against a local broker

```sh
pnpm --filter @statewalker/webrun-streams-peerjs test:browser   # runs the suite
pnpm --filter @statewalker/webrun-streams-peerjs test           # reports it skipped
```

The `@statewalker/webrun-streams-conformance` suite runs in headless Chromium through Playwright.
A Vitest global setup starts the reference broker (the [`peer`](https://www.npmjs.com/package/peer)
package's `PeerServer`) on a loopback port in a child process, so runs need no internet access.
The broker runs out of process because, hosted in-process, it keeps the test run alive after the
last test: its `close()` waits on the browser's WebSockets and it holds client-expiry timers with
no public way to clear them. Under plain `pnpm test` (Node) the suite is skipped: the full PeerJS
handshake hangs there. The browser run includes the suite a second time over
the port stack (`overPipe` + `msgpackCodec`), where L6 is an integrity check
until D17, and the message-ceiling measurement. `message-target.test.ts` runs in
Node against a structural fake connection and pins the pipe's contract.

### Dependencies

- `@statewalker/webrun-streams` (runtime): the `Duplex` / `Connect` / `Serve` / `ByteChannel`
  types and `emulateMux`.
- `peerjs` (peer): you supply and own the `Peer`.
- `messageTargetOverPeerJs` imports nothing from this repository: its target is a `MessageTarget`
  by shape. `@statewalker/webrun-rpc` and `@statewalker/webrun-msgpack` are dev dependencies of
  the tests.
- Dev only: `peer` (the local broker), `@vitest/browser-playwright` and `playwright` (the browser
  run), `@statewalker/webrun-streams-conformance` (the suite).

## License

MIT
