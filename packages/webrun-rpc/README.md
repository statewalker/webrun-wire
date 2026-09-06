# @statewalker/webrun-rpc

Ports and RPC over them, in the `webrun-streams-*` family: a port multiplexer
that turns one `MessageTarget` into many, a `MessagePort`-backed `Connect` /
`Serve` adapter, and a typed-JSON RPC tier that now runs over any
`MessageTarget`.

## What this is

Three pieces, one dependency:

- **Port multiplexing** (`multiplexPort` / `PortMux`) — turns one
  `MessageTarget` into many virtual ones. Each virtual port is itself a
  `MessageTarget`, so a multiplexer composes over another multiplexer's port,
  and the RPC tier below can run directly on top of it. See
  [Port multiplexing](#port-multiplexing).
- **Byte-stream tier** (`connect` / `serve`) — the canonical
  [`webrun-streams`](../webrun-streams) `Duplex` seam over a `MessagePort`. One
  port becomes one `ByteChannel`; `emulateMux` provides multi-stream. Use this
  when you want the same handler to run over a port today and a WebSocket
  tomorrow.
- **Typed-JSON RPC tier** (`callPort` / `listenPort` / `callBidi` /
  `listenBidi` / `ioSend` / `ioHandle` / `send` / `recieve`) — request/response
  with typed JSON arguments per call, relocated here from the retired
  `webrun-streams-port` package. It types against `MessageTarget` rather than
  `MessagePort`, so it also runs directly over a virtual port from
  `multiplexPort` — one raw port fans out into many independent RPC channels
  with no byte-stream layer in between. Use this when you want plain JSON
  messaging and do not need byte-stream semantics.

All three are exported from the package root. The only runtime dependency is
[`@statewalker/webrun-streams`](../webrun-streams).

## Why it exists

`MessagePort` is the browser's universal in-process seam — Workers,
SharedWorkers, ServiceWorkers, iframes, `MessageChannel` pipes between two
modules in the same tab. It is also the most primitive: `postMessage` fires and
forgets. There is no request, no correlation, no backpressure, no half-close,
and an exception on the far side simply never arrives.

The byte-stream tier makes a port indistinguishable from any other transport in
this family, which is what lets an in-browser back-end be tested in-process and
then moved behind a real socket unchanged. The RPC tier exists because a lot of
port traffic is not a byte stream at all — it is one typed call with one typed
answer, and forcing that through a `Duplex` is more machinery than the job
needs. The multiplexer exists because a single `MessagePort` is usually the
only pipe you're handed — one `MessageChannel` per logical stream doesn't
scale — so `multiplexPort` fans it out into as many independent
`MessageTarget`s as the RPC tier or byte-stream tier need.

## Install

```sh
npm install @statewalker/webrun-rpc
```

No peer dependencies. `MessagePort` and `MessageChannel` are platform globals in
browsers and in Node ≥ 15 (`node:worker_threads`).

## Getting started

### Byte-stream tier

```ts
import { connect, serve } from "@statewalker/webrun-rpc";

const channel = new MessageChannel();

const stop = await serve({ port: channel.port2 }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});

const { call, close } = await connect({ port: channel.port1 });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
await stop();
```

Across a Worker boundary, transfer one end and keep the other:

```ts
const { port1, port2 } = new MessageChannel();
worker.postMessage({ port: port2 }, [port2]);
const { call } = await connect({ port: port1 });
```

#### Stream-id sides

Both `connect` and `serve` accept `side: "initiator" | "responder"` — the
`emulateMux` stream-id allocation side. It defaults asymmetrically
(`"initiator"` on `connect`, `"responder"` on `serve`), so the ordinary pairing
above needs no configuration. Set it explicitly only when both ends of a port
are `connect`s, or both are `serve`s.

### Typed-JSON RPC tier

```ts
import { callPort, listenPort } from "@statewalker/webrun-rpc";

// Responder
const off = listenPort(port2, async ({ a, b }) => ({ sum: a + b }));

// Caller
const { sum } = await callPort(port1, { a: 2, b: 3 }, { timeout: 2000 });
```

`callBidi` / `listenBidi` extend this to a streaming outer call, and `ioSend` /
`ioHandle` carry an async iterator across the port.

### Carrying HTTP over a port

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://local/api/todo"));
```

## API

### Byte-stream tier — exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `connect(params)` | `Connect<PortParams>` | Resolves `{ call, close }` over the port. |
| `serve(params, handler)` | `Serve<PortParams>` | Registers a `Duplex` handler. Returns an idempotent teardown. |
| `byteChannelFromMessagePort(port)` | function | Wraps a port as a `ByteChannel` for driving `emulateMux` yourself. |
| `PortParams` | type | `{ port: MessagePort; side?: "initiator" \| "responder"; mux?: EmulateMuxOptions }`. `mux` forwards flow-control tuning (`mtu`, `maxStreamBuffer`) to `emulateMux`; `side` always wins over `mux.side`. |

### Typed-JSON RPC tier — exports

| Export | Purpose |
| --- | --- |
| `callPort(port, args, options?)` | One typed call, one typed answer. |
| `listenPort(port, handler, options?)` | Answer `callPort` requests. Returns an unsubscribe. |
| `callBidi(port, args)` / `listenBidi(port, handler)` | Streaming outer call in both directions. |
| `ioSend(...)` / `ioHandle(...)` | Ship an async iterator across the port. |
| `send(...)` / `recieve(...)` | The low-level message primitives underneath. |
| `CallPortOptions` | `timeout` (default 1000 ms), `channelName`, `log`, `newCallId`, `signal`. |
| `CallBidiOptions` / `CallBidiArgs` | `bidiTimeout` for the outer stream. |
| `ListenPortOptions`, `PortHandler`, `BidiHandler`, `IoSendOptions`, `RecieveOptions`, `SendOptions` | Supporting types. |

### Cancellation and close signalling

| Export | Purpose |
| --- | --- |
| `postCancelChannel(...)` / `listenCancelChannel(...)` | Out-of-band cancellation for an in-flight call. |
| `CANCEL_CHANNEL_TYPE` | The reserved message type used for it. |
| `setPortCloseSignal(port, signal)` / `getPortCloseSignal(port)` | Attach an `AbortSignal` that marks a port as closed, so pending calls reject instead of hanging. |

## Port multiplexing

`multiplexPort` turns one message port into many. Each virtual port is itself a
`MessageTarget` — the same shape as a `MessagePort` — so whatever runs on top
cannot tell a virtual port from a real one, and a multiplexer composes over
another multiplexer's port.

**A port sends and receives messages. That is all.** No backpressure,
acknowledgements, credit or buffering ceiling — deliberately, matching
`MessagePort` semantics. Waiting strategies belong above. The one safety
property it does hold: **a message for a port with no consumer is dropped, never
queued**, so a peer flooding an unaccepted port cannot grow memory here.

### `multiplexPort(port, options): PortMux`

The default implementation, which emulates multiplexing over a single port. A
transport that already multiplexes natively supplies its own `PortMux` instead.

| option | type | meaning |
| --- | --- | --- |
| `codec` | `PortCodec` | How envelopes reach the wire. Required. |
| `onPort` | `(port, meta?) => boolean \| undefined` | Called when the peer opens a port. Return `false` to reject. **Without it, inbound ports are rejected.** |
| `side` | `"initiator" \| "responder"` | Id parity — initiator allocates even, responder odd, so both ends may open concurrently. Defaults to `"initiator"`. |
| `maxPorts` | `number` | Ceiling on **concurrently** open ports. Defaults to `1024`. Closing a port frees its slot immediately, so a long-lived mux can open unboundedly many over its lifetime — this bounds the id table, never the total. It also never delays a message. |
| `maxMessageSize` | `number` | Largest message this transport can carry, if it has a limit. Reported, not enforced — the layer above chunks to it. |

### `PortMux`

| member | meaning |
| --- | --- |
| `openPort(meta?)` | Allocate a port, announce it, and return the local end. **Asynchronous** — a natively multiplexed transport cannot produce a port synchronously, and the two must share a shape. Does not wait for the peer to accept. **Rejects** with `RangeError` past `maxPorts`, and rejects on a closed mux — it does not throw synchronously, so a bare `try`/`catch` around the call will not catch either. |
| `close()` | Close every virtual port, then release the underlying port. |
| `maxMessageSize` | See above. |

`openPort` returning a promise that resolves before acceptance is deliberate:
it keeps layer 1 free of round trips. Messages posted before the peer accepts
are sent, and dropped at the far end if it rejects; the port becomes inert.
Guard failures — `maxPorts` exceeded, the mux already closed — reject the
returned promise rather than throwing synchronously, so a caller wrapping a
bare `openPort(...)` call in `try`/`catch` will not catch them.

**No close is observable at this layer — not a rejection, and not an orderly close
either.** `MessageTarget` has no close event and the port you hold exposes no
queryable state, so when a port closes its listeners are simply cleared and
`postMessage` becomes a silent no-op. You get no event, no error, and no callback,
and a `close` envelope's `reason` is discarded rather than delivered. A closed port
is indistinguishable from a working one that nobody is answering.

This is deliberate — a real `MessagePort` behaves the same way, and a close event
would make this something other than a port — but it means **the layer above must
carry its own end-of-stream signal** as an ordinary message, sent before the port
closes, rather than relying on the close being seen.

### `structuredCodec`

For ports whose messages are structured values. Envelopes pass through
unencoded, so nothing is serialised and `ArrayBuffer`s move zero-copy through the
transfer list.

A byte transport needs a codec that encodes; that one ships with
`@statewalker/webrun-msgpack`, so this package keeps no dependencies.

### `PortEnvelope`

What crosses the wire: `{ type: "open", id, meta? }`, `{ type: "message", id,
payload }`, `{ type: "close", id, reason? }`.

`reason` is opaque: layer 1 never inspects it — and, as implemented, never surfaces
it either. Setting one accomplishes nothing observable at this layer today; it
exists so the wire format does not have to change when a layer above starts
carrying it.

## Message passing

| Export | Kind | Purpose |
| --- | --- | --- |
| `MessageTarget` | interface | Full-duplex structural view of a message endpoint — a `MessagePort`, a `Worker`, or a ServiceWorker bridge. Extends `MessageSource` and `MessageSink`. |
| `MessageSource` | interface | `addEventListener`/`removeEventListener` for `"message"`, plus optional `start()`. |
| `MessageSink` | interface | `postMessage(message, transfer?)`. |
| `MessageListener` | type | `(event: MessageEvent) => void \| Promise<void>`. |

These are types only — no runtime code — so pulling in just the RPC tier costs
nothing extra. A `MessagePort` satisfies `MessageTarget` structurally; no
adapter is needed.

## Conformance

Passes every level (L0–L6) of
[`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance)
against a `MessageChannel` pair.

```sh
pnpm --filter @statewalker/webrun-rpc test
```

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |

No runtime dependencies outside the workspace, no peer dependencies. ESM only
(`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
