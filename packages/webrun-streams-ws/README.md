# @statewalker/webrun-streams-ws

## What it is

A WebSocket as a pipe of bytes for `@statewalker/webrun-rpc`'s port stack.
`messageTargetOverWebSocket(ws)` turns one open socket into `{ target, signal }`:
`target` is a `MessageTarget` whose messages are `Uint8Array`s, one WebSocket
message each, and `signal` aborts when the socket closes. Hand both to
`webrun-rpc`'s `overPipe` with `msgpackCodec`, and `webrun-rpc`'s `connect` /
`serve` run many concurrent calls over the socket, one port per call. The
handler is an ordinary `Duplex` (`(input) => AsyncGenerator<Uint8Array>`) and
never sees the socket.

## Why it exists

A raw WebSocket is one message pipe. It has no notion of a request, no
concurrency, no half-close, and no way to deliver the far end's exception as
an `Error`. `webrun-rpc`'s port stack supplies all of that over any pipe of
messages: `overPipe` invents a port per call on the pipe, and `connect` /
`serve` run one stream per port, with a producer never more than one chunk
ahead of its consumer. What it needs from a transport is the pipe, plus a
way to learn that the pipe died. A WebSocket says so only through its `close`
event, delivers binary messages in a form that depends on the runtime and on
`binaryType`, and has no drain event. This package handles those three things
and nothing else. Because the handler is a plain `Duplex`, the same function
runs over any other transport that implements the seam.

## How to use

```sh
pnpm add @statewalker/webrun-streams-ws @statewalker/webrun-rpc @statewalker/webrun-msgpack
```

The pipe imports nothing from this repository; `@statewalker/webrun-rpc` and
`@statewalker/webrun-msgpack` are what you run over it. No peer dependencies.
One entry point, `.`.

- **Browser and worker**: `openWebSocket` uses the global `WebSocket`.
- **Node**: pass a constructor as `WebSocketCtor`. The `ws` package works
  (`pnpm add ws`). On the server side there is no server object to hand over:
  call `messageTargetOverWebSocket` on each socket your server accepts, so it
  works with `ws`'s `WebSocketServer`, a runtime's built-in upgrade, or any
  other source of open sockets.

| Export | What it gives |
| --- | --- |
| `messageTargetOverWebSocket(ws)` | One open socket as a `WebSocketMessageTarget`, `{ target, signal }`: `target` is a `MessageTarget` of bytes (one WebSocket message each) with `bufferedAmount` and `whenDrained()`; `signal` aborts when the socket closes. Hand both to `overPipe` with `msgpackCodec`; see below. |
| `openWebSocket(params)` | Opens a socket and resolves once it is `OPEN`; rejects if it fails or closes first. `params` is `OpenWebSocketParams`. |
| `DRAIN_LOW_WATER` | `256 * 1024`. `whenDrained()` resolves once `bufferedAmount` is at most this. |
| `WebSocketLike` | Structural socket type accepted everywhere: `readyState`, optional `bufferedAmount` and `binaryType`, `send`, `close`, `addEventListener` / `removeEventListener` for `message`, `open`, `close`, `error`. Node's `ws` satisfies it as is; the DOM `WebSocket` satisfies it at runtime but needs a cast at the type level (see Internals). |
| `WS_READY_STATE` | `{ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }`. |
| `WebSocketMessageTarget`, `OpenWebSocketParams` | Types for the two functions above. |

`OpenWebSocketParams`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `string` | required | `ws://` or `wss://` URL. |
| `protocols` | `string \| string[]` | none | Subprotocols passed to the constructor. |
| `WebSocketCtor` | `new (url, protocols?) => WebSocketLike` | `globalThis.WebSocket` | Required where there is no global `WebSocket`. |

Both ends of a connection must run the port stack (`overPipe` with the same
codec); a plain WebSocket peer cannot talk to it.

## Examples

### Serve and call in Node

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import {
  messageTargetOverWebSocket,
  openWebSocket,
  type WebSocketLike,
} from "@statewalker/webrun-streams-ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

// server, per accepted socket
wss.on("connection", (socket) => {
  const { target, signal } = messageTargetOverWebSocket(socket as unknown as WebSocketLike);
  void serve(
    { mux: overPipe(target, { codec: msgpackCodec, side: "responder", signal }) },
    async function* echo(input) {
      for await (const chunk of input) yield chunk;
    },
  );
});

// client
const ws = await openWebSocket({
  url: "ws://127.0.0.1:8080",
  WebSocketCtor: NodeWebSocket as unknown as new (url: string) => WebSocketLike,
});
const pipe = messageTargetOverWebSocket(ws);
const { call, close } = await connect({
  mux: overPipe(pipe.target, { codec: msgpackCodec, side: "initiator", signal: pipe.signal }),
});

for await (const chunk of call([new TextEncoder().encode("hello")])) {
  console.log(new TextDecoder().decode(chunk)); // "hello"
}

await close();
wss.close();
```

Pass `signal`: a WebSocket that dies says so only through its `close` event,
and without it the multiplexer's ports stay open forever. No `maxMessageSize`
is reported, because WebSocket limits are deployment settings: the `ws` server
closes with 1009 past its `maxPayload` (100 MiB by default), and browsers and
proxies have their own. Without one, a chunk crosses as one message; set
`overPipe`'s `maxMessageSize` (256 bytes under the real limit) or `frameSize`
if your path has a smaller ceiling.

### Browser client, concurrent calls

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { messageTargetOverWebSocket, openWebSocket } from "@statewalker/webrun-streams-ws";

const { target, signal } = messageTargetOverWebSocket(
  await openWebSocket({ url: "wss://example.com/socket" }),
);
const { call, close } = await connect({
  mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal }),
});
const enc = new TextEncoder();

// Each call is an independent port on the same socket.
const [a, b] = await Promise.all([
  collectBytes(call([enc.encode("first")])),
  collectBytes(call([enc.encode("second")])),
]);
await close();
```

### HTTP over the socket

`@statewalker/webrun-http-streams` carries `Request` / `Response` over any
`Duplex`, so it runs on the `call` from the previous example:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/todo"));
```

## Internals

### One socket, one pipe, many ports

```
 client                                              server
 call(a) ──┐                                     ┌──> handler(a)
 call(b) ──┼─ overPipe ══ WebSocket ══ overPipe ─┼──> handler(b)
 call(c) ──┘  (initiator)            (responder) └──> handler(c)
       messageTargetOverWebSocket   messageTargetOverWebSocket
```

Each socket is one pipe. `overPipe` (`webrun-rpc`'s `multiplexPort` with a
codec) opens a port per call on it, and `webrun-rpc`'s `connect` / `serve`
run one stream per port. The two ends must pass opposite `side`s so they
allocate port ids from different sets. Framing, flow control, port lifetimes
and error propagation are `webrun-rpc`'s; see its README. This package only
maps the socket onto a `MessageTarget` and reports its death.

### Why there is no server object

`messageTargetOverWebSocket` takes one socket, whoever accepted it, so this
package has no dependency on a server library. It can be wired to `ws`, to a
runtime's built-in WebSocket upgrade, or to a custom accept loop. Tearing a
server down is two steps: the teardown `webrun-rpc`'s `serve` resolves to
closes that connection's multiplexer, failing its calls in flight; stop
accepting and close the sockets yourself (for example `wss.close()` plus
`terminate()` on each client with `ws`).

### How `messageTargetOverWebSocket` maps the socket

- The socket must be `OPEN`. Messages must arrive as bytes at once: a socket
  on `binaryType` "blob" (read asynchronously, so a later message could
  overtake it) or `ws`'s "fragments" is switched to "arraybuffer";
  "arraybuffer" and `ws`'s "nodebuffer" are left alone.
- Each WebSocket message is one `message` event whose `data` is a
  `Uint8Array`. `Uint8Array` (including Node `Buffer`), `ArrayBuffer` and
  other `ArrayBufferView`s are passed through without copying. A text message
  is delivered as its UTF-8 bytes. A message of any other kind ends the pipe
  with a `TypeError` and closes the socket instead of being dropped, since a
  lost envelope would hang its call. Messages that reach no listener are
  dropped, as on a `MessagePort`; one listener throwing does not stop
  delivery to the others.
- `postMessage` sends one binary message. It throws `TypeError` for anything
  but bytes, so a codec breaking its contract is not papered over. After the
  socket has closed it is a no-op: `signal` already says so.
- The socket's `close` event (a failing socket fires `error` and then always
  `close`) aborts `signal` with `webrun-streams-ws: the WebSocket closed (code
  <n>)`. `overPipe` closes the multiplexer on it, which fails every call in
  flight. `target.close()` closes the socket and aborts `signal` with
  `webrun-streams-ws: closed locally`.
- `bufferedAmount` is the socket's own. A WebSocket has no drain event, so
  `whenDrained()` polls it every 5 ms (with an unref'd timer, so a peer that
  stops reading never keeps Node alive) and resolves once it is at most
  `DRAIN_LOW_WATER`, or the socket has closed. Waiting for zero would make a
  sender that waits before every frame (`overPipe`'s `frameSize`) pause a poll
  interval per frame.

### WebSocketLike and the DOM type

`WebSocketLike` is structural so that the DOM `WebSocket` and Node's `ws`
both fit without this package depending on either. `ws`'s `WebSocket` type
checks as is. The DOM type does not: `WebSocketLike.send` accepts
`Uint8Array<ArrayBufferLike>`, which the current DOM `WebSocket.send` typing
(`BufferSource`) rejects, so passing a DOM socket to
`messageTargetOverWebSocket` or a DOM constructor as `WebSocketCtor` needs
`as unknown as WebSocketLike`. `openWebSocket` without `WebSocketCtor` uses
the global `WebSocket` and does the cast itself.

### Failure modes

| Situation | Error |
| --- | --- |
| No `WebSocketCtor` and no global `WebSocket` | `webrun-streams-ws: no WebSocket constructor available. Pass \`WebSocketCtor\` (e.g. the \`ws\` package's WebSocket in Node).` |
| Socket errors before opening | `WebSocket error before open` |
| Socket closes before opening | `WebSocket closed before it opened` |
| `messageTargetOverWebSocket` on a socket that is not open | `messageTargetOverWebSocket: WebSocket is in readyState <n>, expected OPEN (1)` |
| `postMessage` with something other than bytes | `TypeError: webrun-streams-ws: a byte pipe carries Uint8Array, ArrayBuffer or a view, got <type>` |
| A message arrives as something other than bytes or text | `signal` aborts with `TypeError: webrun-streams-ws: a message arrived as <type>; set binaryType to "arraybuffer" or "nodebuffer"` |
| Socket closes | `signal` aborts with `webrun-streams-ws: the WebSocket closed (code <n>)`; calls in flight fail through `webrun-rpc`. |

`openWebSocket` has no timeout of its own; a socket that never opens or fails
leaves the promise pending.

### Tests and measurements

`pnpm test` runs the shared conformance suite (L0 to L6) against an
in-process `ws` server over the port stack (`overPipe` + `msgpackCodec`).
L6 asserts the port stack's bound in both directions: a consumer that stops
reading lets the producer get at most 8 KiB ahead (measured 0). `message-target.test.ts`
pins the pipe's contract: bytes only (anything else is a `TypeError`), text
frames as UTF-8 bytes, `signal` aborted by a dead peer, `whenDrained`
resolving at the low-water mark, sockets on "fragments" or "blob" delivering
bytes in order, a dead peer failing the calls in flight over the multiplexer,
and `serve`'s teardown failing a call in flight on each connection.
`pnpm run test:bench` runs a separate measurement that compares a direct
WebSocket round trip with one bridged through a `MessageChannel`. It reports
numbers and does not gate on a threshold, because a timing threshold on
shared CI hardware is unreliable, and it is excluded from `pnpm test`.

### Dependencies

- None at runtime from this repository: `src/` imports nothing outside the
  package, and `messageTargetOverWebSocket` returns a `MessageTarget` by
  shape.
- `ws`, `@statewalker/webrun-rpc`, `@statewalker/webrun-msgpack` and
  `@statewalker/webrun-streams-conformance` are dev dependencies used only by
  the tests; consumers supply their own `webrun-rpc` and codec.

## License

MIT
