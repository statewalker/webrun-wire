# @statewalker/webrun-streams-port

`MessagePort`-backed `Connect` / `Serve` adapter — plus a typed-JSON RPC tier —
in the `webrun-streams-*` family.

## What this is

Two independent layers over the same `MessagePort`:

- **Byte-stream tier** (`connect` / `serve`) — the canonical
  [`webrun-streams`](../webrun-streams) `Duplex` seam. One port becomes one
  `ByteChannel`; `emulateMux` provides multi-stream. Use this when you want the
  same handler to run over a port today and a WebSocket tomorrow.
- **Typed-JSON RPC tier** (`callPort` / `listenPort` / `callBidi` /
  `listenBidi` / `ioSend` / `ioHandle`) — request/response with typed JSON
  arguments per call, relocated here from the retired `webrun-ports` package.
  Use this when you want plain JSON messaging and do not need byte-stream
  semantics.

Both tiers are exported from the package root; pick one per port.

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
needs.

## Install

```sh
npm install @statewalker/webrun-streams-port
```

No peer dependencies. `MessagePort` and `MessageChannel` are platform globals in
browsers and in Node ≥ 15 (`node:worker_threads`).

## Getting started

### Byte-stream tier

```ts
import { connect, serve } from "@statewalker/webrun-streams-port";

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
import { callPort, listenPort } from "@statewalker/webrun-streams-port";

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
| `PortParams` | type | `{ port: MessagePort; side?: "initiator" \| "responder" }`. |

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

## Conformance

Passes every level (L0–L5) of
[`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance)
against a `MessageChannel` pair.

```sh
pnpm --filter @statewalker/webrun-streams-port test
```

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |

No runtime dependencies outside the workspace, no peer dependencies. ESM only
(`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
