# @statewalker/webrun-streams-ws

WebSocket-backed `Connect` / `Serve` adapter in the `webrun-streams-*` family.

## What this is

A binding between a `WebSocket` and the [`webrun-streams`](../webrun-streams)
`Duplex` seam. One `WebSocket` becomes one
[`ByteChannel`](../webrun-streams#the-duplex-seam); `emulateMux` layers many
concurrent logical calls on top of that single socket.

The point is that your handler never mentions WebSockets. It is an ordinary
`Duplex` — `(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>` —
so the same function runs unchanged over a `MessagePort`, a WebRTC data
channel, libp2p, or an in-process pipe. Swapping transports is swapping the
import.

## Why it exists

A raw `WebSocket` gives you one unordered-in-practice message pipe with no
notion of a request, no concurrency, no half-close, and no way to propagate an
error from the far end as an `Error`. Everything above it has to reinvent
framing, correlation and teardown.

This adapter supplies the missing piece exactly once: it wraps the socket as a
`ByteChannel`, and `emulateMux` turns that into as many independent
back-pressured byte streams as you need — each with proper end-of-stream,
mid-stream cancellation, and error propagation.

## Install

```sh
npm install @statewalker/webrun-streams-ws
```

In the browser the global `WebSocket` is used automatically. In Node, supply a
constructor — the [`ws`](https://www.npmjs.com/package/ws) package works as-is:

```sh
npm install ws
```

## Getting started

Serve a handler over an in-process `WebSocketServer` and call it:

```ts
import { connect, serve } from "@statewalker/webrun-streams-ws";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

// The handler is a plain Duplex: bytes in, bytes out.
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
  url: "ws://localhost:8080",
  WebSocketCtor: NodeWebSocket, // omit in the browser
});

for await (const chunk of call([new TextEncoder().encode("hello")])) {
  console.log(new TextDecoder().decode(chunk)); // "hello"
}

await close();
await stop();
```

In a browser the client side is just:

```ts
const { call, close } = await connect({ url: "wss://example.com/socket" });
```

### Concurrent calls

Each `call(...)` is an independent stream over the same socket. They interleave
without interfering:

```ts
import { collectBytes } from "@statewalker/webrun-streams";

const [a, b] = await Promise.all([
  collectBytes(call(requestA)),
  collectBytes(call(requestB)),
]);
```

### Carrying HTTP over it

Pair with [`webrun-http-streams`](../webrun-http-streams) to move real
`Request` / `Response` objects across the socket:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://x/api/todo"));
```

## API

### `connect(params): Promise<{ call, close }>`

Opens a `WebSocket` and resolves once it is open. Type: `Connect<ConnectWsParams>`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `string` | — | WebSocket URL (`ws://` or `wss://`). |
| `protocols` | `string \| string[]` | — | Subprotocol(s) passed to the constructor. |
| `WebSocketCtor` | constructor | global `WebSocket` | Constructor to use. Required where there is no global `WebSocket` (Node). |
| `mux` | `EmulateMuxOptions` | `emulateMux`'s own | Flow-control tuning (`mtu`, `maxStreamBuffer`) forwarded to `emulateMux`. `side` is always `"initiator"` regardless of `mux.side`. |

Resolves to `{ call: Duplex, close: () => Promise<void> }`. Each `call(input)`
opens a fresh logical stream; `close()` tears down the socket and every stream
on it.

### `serve(params, handler): Promise<() => Promise<void>>`

Registers `handler` against a source of inbound sockets. Type: `Serve<ServeWsParams>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `onConnection` | `(cb: (ws: WebSocketLike) => void) => () => void` | Subscribes to inbound connections; returns an unsubscribe function. |
| `mux` | `EmulateMuxOptions` | Flow-control tuning (`mtu`, `maxStreamBuffer`) forwarded to `emulateMux`. `side` is always `"responder"` regardless of `mux.side`. |

The indirection means this package never depends on a particular server
library — wire it to `ws`, to a Deno/Bun handler, or to your own accept loop.
Returns an idempotent teardown.

### `byteChannelFromWebSocket(ws): ByteChannel`

Wraps a single socket as a `ByteChannel` (`send` / `recv` / `closed` / `close`).
Use this when you want to drive `emulateMux` yourself, or reuse a socket you
already own.

### `WebSocketLike` / `WS_READY_STATE`

The structural socket interface this package accepts, and the
`CONNECTING`/`OPEN`/`CLOSING`/`CLOSED` constants. Typing against `WebSocketLike`
rather than the DOM `WebSocket` is what lets the same code accept Node's `ws`.

## Conformance

Passes every level (L0–L6) of
[`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance)
against an in-process `WebSocketServer`: body sizes up to 10 MiB, concurrent
calls, half-close, mid-stream cancellation, error propagation with stack and
custom fields preserved, idempotent teardown, and flow control against a slow
consumer at a small advertised window.

```sh
pnpm --filter @statewalker/webrun-streams-ws test
```

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |
| `ws` | dev / your choice | Only for the Node tests. Consumers pass their own constructor. |

No other runtime dependencies. ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
