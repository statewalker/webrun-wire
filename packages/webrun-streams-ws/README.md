# @statewalker/webrun-streams-ws

## What it is

A WebSocket adapter for the `Duplex` seam from `@statewalker/webrun-streams`.
`connect` opens a WebSocket and returns a `call` function; `serve` binds a
handler to every inbound WebSocket. Each socket is wrapped as a `ByteChannel`
and run through `emulateMux`, so many concurrent calls share one socket. The
handler is an ordinary `Duplex`
(`(input) => AsyncGenerator<Uint8Array>`) and never sees the socket.

## Why it exists

A raw WebSocket is one message pipe. It has no notion of a request, no
concurrency, no half-close, and no way to deliver the far end's exception as
an `Error`. Everything above it would have to build framing, correlation and
teardown. This adapter wraps the socket as a `ByteChannel` and lets
`emulateMux` provide independent streams with backpressure, end-of-stream,
cancellation and error propagation. Because the handler is a plain `Duplex`,
the same function runs over any other adapter that implements the seam.

## How to use

```sh
pnpm add @statewalker/webrun-streams-ws
```

Runtime dependency: `@statewalker/webrun-streams`. No peer dependencies. One
entry point, `.`.

- **Browser and worker**: `connect` uses the global `WebSocket`.
- **Node**: pass a constructor as `WebSocketCtor`. The `ws` package works
  (`pnpm add ws`). On the server side, `serve` takes an `onConnection`
  subscription instead of a server object, so it works with `ws`'s
  `WebSocketServer` or any other source of open sockets.

| Export | What it gives |
| --- | --- |
| `connect(params)` | `Connect<ConnectWsParams>`. Opens a socket, waits for it to open, resolves `{ call, close }`. Each `call(input)` opens a new stream on the socket; `close()` closes the mux and the socket. |
| `serve(params, handler)` | `Serve<ServeWsParams>`. Wraps each socket from `onConnection` in its own `emulateMux` and binds `handler`. Resolves to an idempotent teardown. |
| `byteChannelFromWebSocket(ws)` | Wraps one open socket as a `ByteChannel`, for driving `emulateMux` yourself or reusing a socket you already own. |
| `WebSocketLike` | Structural socket type accepted everywhere: `readyState`, `send`, `close`, `addEventListener` / `removeEventListener` for `message`, `open`, `close`, `error`. Node's `ws` satisfies it as is; the DOM `WebSocket` satisfies it at runtime but needs a cast at the type level (see Internals). |
| `WS_READY_STATE` | `{ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }`. |
| `ConnectWsParams`, `ServeWsParams` | Parameter types, below. |

`ConnectWsParams`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `string` | required | `ws://` or `wss://` URL. |
| `protocols` | `string \| string[]` | none | Subprotocols passed to the constructor. |
| `WebSocketCtor` | `new (url, protocols?) => WebSocketLike` | `globalThis.WebSocket` | Required where there is no global `WebSocket`. |
| `mux` | `EmulateMuxOptions` | `emulateMux` defaults | `mtu`, `maxStreams`, `maxStreamBuffer`. `side` is always `"initiator"`. |

`ServeWsParams`:

| Field | Type | Meaning |
| --- | --- | --- |
| `onConnection` | `(cb: (ws: WebSocketLike) => void) => () => void` | Subscribes to inbound open sockets; returns an unsubscribe function. |
| `mux` | `EmulateMuxOptions` | As above. `side` is always `"responder"`. |

Both sides of a connection must run this package's `emulateMux` wire format;
a plain WebSocket peer cannot talk to it.

## Examples

### Serve and call in Node

```ts
import { connect, serve } from "@statewalker/webrun-streams-ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

const stop = await serve(
  {
    onConnection: (cb) => {
      wss.on("connection", cb);
      return () => wss.off("connection", cb);
    },
  },
  async function* echo(input) {
    for await (const chunk of input) yield chunk;
  },
);

const { call, close } = await connect({
  url: "ws://127.0.0.1:8080",
  WebSocketCtor: NodeWebSocket,
});

for await (const chunk of call([new TextEncoder().encode("hello")])) {
  console.log(new TextDecoder().decode(chunk)); // "hello"
}

await close();
await stop();
wss.close();
```

### Browser client, concurrent calls

```ts
import { collectBytes } from "@statewalker/webrun-streams";
import { connect } from "@statewalker/webrun-streams-ws";

const { call, close } = await connect({ url: "wss://example.com/socket" });
const enc = new TextEncoder();

// Each call is an independent stream on the same socket.
const [a, b] = await Promise.all([
  collectBytes(call([enc.encode("first")])),
  collectBytes(call([enc.encode("second")])),
]);
await close();
```

### HTTP over the socket

`@statewalker/webrun-http-streams` carries `Request` / `Response` over any
`Duplex`:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-ws";

const { call } = await connect({ url: "wss://example.com/socket" });
const response = await fetchOverDuplex(call, new Request("http://peer/api/todo"));
```

### Driving `emulateMux` on a socket you own

```ts
import { emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromWebSocket, type WebSocketLike } from "@statewalker/webrun-streams-ws";

declare const socket: WebSocket; // already open
// The cast is needed with current DOM typings; see "WebSocketLike and the DOM type" below.
const mux = emulateMux(byteChannelFromWebSocket(socket as unknown as WebSocketLike), {
  side: "initiator",
});
const response = mux.call([new TextEncoder().encode("ping")]);
```

## Internals

### One socket, one mux

```
 client                                     server
 call(a) ──┐                            ┌──> handler(a)
 call(b) ──┼─ emulateMux ══ WebSocket ══ emulateMux ─┼──> handler(b)
 call(c) ──┘  (initiator)               (responder) └──> handler(c)
              ByteChannel               ByteChannel
```

`connect` creates one socket and one `emulateMux` with `side: "initiator"`.
`serve` creates one `emulateMux` with `side: "responder"` per inbound socket,
and closes it when that socket closes. The sides are forced, overriding any
`mux.side`, so the two ends always allocate stream ids from different sets
(even and odd). Flow control, framing and stream lifetimes are `emulateMux`'s;
see `@statewalker/webrun-streams`.

### Why the server takes `onConnection` and not a server object

`serve` depends only on a subscription function, so this package has no
dependency on a server library. It can be wired to `ws`, to a runtime's
built-in WebSocket upgrade, or to a custom accept loop.

### How `byteChannelFromWebSocket` maps the socket

- Each WebSocket message is one `recv` item. `Uint8Array` (including Node
  `Buffer`), `ArrayBuffer` and other `ArrayBufferView`s are passed through
  without copying. A `Blob` is read asynchronously, which can reorder it
  relative to later messages; set `binaryType = "arraybuffer"` in the browser
  if that matters. Text messages are accepted and delivered as UTF-8 bytes.
  Anything else is ignored.
- `send` is silently dropped when the socket is not `OPEN` or the channel is
  closed; `emulateMux` learns about the failure from `closed`.
- The socket's `close` event ends `recv` and resolves `closed`, which fails
  every in-flight call with `TransportClosedError`.

### WebSocketLike and the DOM type

`WebSocketLike` is structural so that the DOM `WebSocket` and Node's `ws`
both fit without this package depending on either. `ws`'s `WebSocket` type
checks as is. The DOM type does not: `WebSocketLike.send` accepts
`Uint8Array<ArrayBufferLike>`, which the current DOM `WebSocket.send` typing
(`BufferSource`) rejects, so passing a DOM socket to
`byteChannelFromWebSocket` or a DOM constructor as `WebSocketCtor` needs
`as unknown as WebSocketLike`. `connect` without `WebSocketCtor` uses the
global `WebSocket` and does the cast itself.

### Failure modes

| Situation | Error |
| --- | --- |
| No `WebSocketCtor` and no global `WebSocket` | `webrun-streams-ws connect: no WebSocket constructor available. Pass \`params.WebSocketCtor\` (e.g. the \`ws\` package's WebSocket in Node).` |
| Socket errors before opening | `WebSocket error before open` |
| Socket closes before opening | `WebSocket closed before it opened` |
| `byteChannelFromWebSocket` on a socket that is not open | `byteChannelFromWebSocket: WebSocket is in readyState <n>, expected OPEN (1)` |
| Socket closes with calls in flight | `TransportClosedError` (`transport closed`) |

`connect` has no timeout of its own; a socket that never opens or fails leaves
the promise pending.

### Teardown is listener-only on the server

The function `serve` resolves to unsubscribes from `onConnection` and nothing
else. Muxes on sockets that are already connected keep running until their
socket closes. To drop live connections, close the sockets (for example
`wss.close()` plus `terminate()` on each client with `ws`).

### Tests and measurements

`pnpm test` runs the shared conformance suite (L0 to L6) against an in-process
`ws` server; the pair helper forwards L6's small window through `mux`.
`pnpm run test:bench` runs a separate measurement that compares a direct
WebSocket round trip with one bridged through a `MessageChannel`. It reports
numbers and does not gate on a threshold, because a timing threshold on
shared CI hardware is unreliable, and it is excluded from `pnpm test`.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): `emulateMux`, the
  `ByteChannel` / `Duplex` types and `normalizeToUint8Array`.
- No other runtime dependencies. `ws` is a dev dependency used only by the
  tests; consumers supply their own constructor.

## License

MIT
