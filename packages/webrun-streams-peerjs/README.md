# @statewalker/webrun-streams-peerjs

## What it is

A PeerJS [`DataConnection`](https://peerjs.com/docs/#dataconnection) as a pipe of bytes for
`@statewalker/webrun-rpc`'s port stack. `messageTargetOverPeerJs(conn)` turns one open raw
connection into `{ target, signal, maxMessageSize }`: a `MessageTarget` whose messages are
`Uint8Array`s (one data channel message each), a signal that aborts when the connection closes or
fails, and the payload ceiling the connection can carry. Hand all three to `webrun-rpc`'s
`overPipe` with `msgpackCodec`, and `webrun-rpc`'s `connect` / `serve` run many concurrent calls
over the connection, one port per call. Your handler is an ordinary `Duplex`,
`(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>`, the same function you would
run over a WebSocket or a `MessagePort`.

## Why it exists

PeerJS is the least-effort route to a browser-to-browser connection: it ships a public broker, so
you get a working peer link without running signalling infrastructure. What it hands you is one
message pipe with no request framing, no concurrency, no half-close and no error propagation.
`webrun-rpc`'s port stack supplies those over any pipe of messages. What it needs from the
transport is the pipe, word of the pipe's death, and the largest message that survives the trip.
A PeerJS connection gets the last one wrong silently: a message past the data channel's ceiling
arrives as nothing, with no error on either side. This package supplies all three, checks the
connection options that would otherwise corrupt streams without an error, and nothing else. A
handler prototyped over PeerJS runs unchanged over any other transport.

## How to use

```sh
pnpm add @statewalker/webrun-streams-peerjs peerjs @statewalker/webrun-rpc @statewalker/webrun-msgpack
```

`peerjs` is a required peer dependency (`^1.5.5`). You create and own the `Peer`, its broker
configuration and its connections. Browser only in practice: PeerJS needs WebRTC. One entry point,
`.`, ESM only.

**Connections must be open, use `serialization: "raw"` and be `reliable: true`.** With any other
serialization PeerJS encodes the bytes itself; PeerJS's default `reliable: false` means unordered
delivery, which would reorder envelopes and corrupt every stream without an error; a connection
that is not yet open would drop posts, and one already closed would never abort the signal.
`messageTargetOverPeerJs` checks all three and throws.

| Export | Purpose |
| --- | --- |
| `messageTargetOverPeerJs(conn, options?)` | One open raw, reliable connection as a `PeerJsMessageTarget`, `{ target, signal, maxMessageSize }`: a `MessageTarget` of bytes with `bufferedAmount` / `whenDrained()`, a signal that aborts when the connection closes or fails or a post exceeds `maxFrameBytes`, and the payload ceiling to give `overPipe`. |
| `MessageTargetOverPeerJsOptions` | `maxFrameBytes` (the largest message the connection carries; default `DEFAULT_MAX_FRAME_BYTES`) and `maxMessageSize` (the payload ceiling to report; default `maxFrameBytes` − 256). |
| `PeerJsMessageTarget` | The result type above. |
| `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_MESSAGE_SIZE`, `DRAIN_LOW_WATER` | 16 KiB, 16 KiB − 256, 256 KiB: the defaults of the above. |

Both ends must run the port stack with the same codec. Pass all three of `target`, `signal` and
`maxMessageSize` to `overPipe`: `signal` closes the multiplexer when the connection dies, and
`maxMessageSize` chunks bodies under the frame limit.

## Examples

### Serving

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { overPipe, serve } from "@statewalker/webrun-rpc";
import { messageTargetOverPeerJs } from "@statewalker/webrun-streams-peerjs";
import { Peer } from "peerjs";

const peer = new Peer("my-server-id");
await new Promise((resolve) => peer.on("open", resolve));

async function* echo(input: AsyncIterable<Uint8Array>) {
  for await (const chunk of input) yield chunk;
}

peer.on("connection", (conn) => {
  const ready = () => {
    const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
    void serve(
      { mux: overPipe(target, { codec: msgpackCodec, side: "responder", signal, maxMessageSize }) },
      echo,
    );
  };
  if (conn.open) ready();
  else conn.on("open", ready);
});
```

The caller must open the connection raw and reliable; one opened otherwise makes
`messageTargetOverPeerJs` throw inside `ready`, and that connection is not served.

### Calling

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { messageTargetOverPeerJs } from "@statewalker/webrun-streams-peerjs";
import { Peer } from "peerjs";

const peer = new Peer();
await new Promise((resolve) => peer.on("open", resolve));

const conn = peer.connect("my-server-id", { serialization: "raw", reliable: true });
await new Promise((resolve) => conn.on("open", resolve));

const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
const { call, close } = await connect({
  mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
});

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

## Internals

```
 handler / caller (Duplex)
          │
   webrun-rpc connect / serve: one stream per port
          │
   overPipe + msgpackCodec (webrun-rpc): a port per call, framing, chunking to maxMessageSize
          │
   messageTargetOverPeerJs: one MessageTarget per DataConnection
          │  out: conn.send(bytes)        in: "data" events
          ▼
   PeerJS DataConnection (serialization: "raw", reliable) ── WebRTC data channel
```

### The message ceiling (measured)

PeerJS hands a raw message to the data channel unchanged. Between two Chromiums a message of
262,143 bytes arrives; one of 262,145 arrives as nothing, with no throw and no error event, and
the connection silently closes (`tests/message-ceiling.test.ts`, `test:browser`). Firefox to
Chrome cuts off at 16,384, as PeerJS itself records. So the pipe defaults to `maxFrameBytes`
16 KiB, reports `maxMessageSize` 256 bytes under it (the port stack's framing adds up to 134), and
a post past `maxFrameBytes` ends the pipe and throws a `RangeError` instead of vanishing. Raise
`maxFrameBytes` only for peers known to allow more.

### What the pipe accepts, and what it refuses

Inbound `data` may be a `Uint8Array`, an `ArrayBuffer` or any `ArrayBufferView`; each is copied
into a fresh `Uint8Array`, since PeerJS may reuse the buffer it hands out. Anything else (a
`Blob`, a string) ends the pipe with a `TypeError` and closes the connection: dropping it would
lose an envelope and hang its call. Messages that reach no listener are dropped, as on a
`MessagePort`.

Outbound, `postMessage` throws a `TypeError` for anything but bytes, so a codec breaking its
contract is not papered over. After the connection has closed it is a no-op: `signal` already says
so. Each message is copied before `conn.send`, because PeerJS may queue it past its own buffer
threshold.

### What closes the pipe, and what you see

`signal` aborts on the connection's `close` event (`webrun-streams-peerjs: the connection
closed`), on its `error` event (`webrun-streams-peerjs: the connection failed: <message>`), on an
oversized post, or on inbound data that is not bytes. `overPipe` closes the multiplexer on it,
which fails every call in flight.

`target.close()` waits up to 5 s for PeerJS's queue and the data channel's `bufferedAmount` to
empty before calling `conn.close()`, because `conn.close()` tears the peer connection down at once
and discards what they still hold, the multiplexer's last close envelopes among it.
`whenDrained()` polls the same two (neither reports emptying) every 5 ms and resolves once
PeerJS's queue is empty and `bufferedAmount` is at most `DRAIN_LOW_WATER`, or the pipe ended.

### Conformance runs in a browser against a local broker

```sh
pnpm --filter @statewalker/webrun-streams-peerjs test:browser   # runs the suite
pnpm --filter @statewalker/webrun-streams-peerjs test           # reports it skipped
```

The `@statewalker/webrun-streams-conformance` suite runs in headless Chromium through Playwright,
over the port stack (`overPipe` + `msgpackCodec`, with the pipe's 16 KiB-safe `maxMessageSize`, so
L6's 256 KiB body crosses as chunks under the cross-browser frame limit). The pair ignores
`PairTuning`, as every port-stack pair does, so L6 is an integrity check until D17 redefines it.
A Vitest global setup starts the reference broker (the [`peer`](https://www.npmjs.com/package/peer)
package's `PeerServer`) on a loopback port in a child process, so runs need no internet access.
The broker runs out of process because, hosted in-process, it keeps the test run alive after the
last test: its `close()` waits on the browser's WebSockets and it holds client-expiry timers with
no public way to clear them. Under plain `pnpm test` (Node) the suite is skipped: the full PeerJS
handshake hangs there. The browser run also includes the message-ceiling measurement.
`message-target.test.ts` runs in Node against a structural fake connection and pins the pipe's
contract.

### Dependencies

- `peerjs` (peer): you supply and own the `Peer`. `src/` imports only its `DataConnection` type.
- Nothing from this repository at runtime: the target is a `MessageTarget` by shape.
  `@statewalker/webrun-rpc`, `@statewalker/webrun-msgpack` and `@statewalker/webrun-streams` are
  dev dependencies of the tests; consumers supply their own `webrun-rpc` and codec.
- Dev only: `peer` (the local broker), `@vitest/browser-playwright` and `playwright` (the browser
  run), `@statewalker/webrun-streams-conformance` (the suite).

## License

MIT
