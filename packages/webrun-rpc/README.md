# @statewalker/webrun-rpc

## What it is

Ports and RPC over them. The package has four layers, all exported from the root: **port
multiplexers** (`multiplexPort`, `transferPortMux`) that turn one `MessageTarget` into many virtual
ones; a **stream tier** (`duplexOverPort` / `serveDuplexOverPort`) that runs one
`@statewalker/webrun-streams` `Duplex` over one port with backpressure built into the protocol; a
**`connect` / `serve` adapter** that plugs a source of ports into the `webrun-streams` `Connect` /
`Serve` shape; and a **typed-JSON RPC tier** (`callPort` / `listenPort`, `callBidi` / `listenBidi`,
`ioSend` / `ioHandle`, `send` / `recieve`) for request/response and iterator exchange over any
`MessageTarget`.

## Why it exists

`MessagePort` is the browser's universal in-process seam: Workers, SharedWorkers, ServiceWorkers,
iframes, a `MessageChannel` between two modules in one tab. It is also the most primitive one.
`postMessage` fires and forgets. There is no request, no correlation, no backpressure, no
half-close, and an exception on the far side never arrives.

- The **stream tier** makes a port behave like any other `webrun-streams` transport, so a back-end
  running in a worker can be tested in-process and later moved behind a real socket unchanged.
- The **multiplexer** exists because one port is usually all you are handed. One `MessageChannel`
  per logical stream does not scale, and over a WebSocket or a data channel there is no second
  channel to be had.
- The **RPC tier** exists because much port traffic is not a byte stream at all. It is one typed
  call with one typed answer, and a `Duplex` is more machinery than that needs. It types against
  `MessageTarget`, not `MessagePort`, so it runs directly over a virtual port too.

## How to use

```sh
pnpm add @statewalker/webrun-rpc
```

No peer dependencies. ESM only. One entry point, `.`. Runs in browsers, workers and Node: the
examples use the global `MessageChannel`, which Node also provides. `transferPortMux` needs
structured clone with transferables, so it works only where real `MessagePort`s can be transferred
(browsers, workers, iframes, Node `worker_threads`).

### Choosing a source of ports

`connect` and `serve` take a **port factory** (`PortMuxFactory`), not a port. They ask it for one
port per call and run one stream on it. How ports are made belongs to whoever knows the transport:

| Transport | Factory | Id table? |
| --- | --- | --- |
| one pipe (`MessagePort`, worker, WebSocket, data channel) | `overPipe(pipe, { codec })` | yes: there is no second port to be had |
| a transferable boundary | `overPorts((onPort) => transferPortMux(target, { onPort }))` | no: the platform moves real ports |
| a transport that multiplexes already | `overPorts((onPort) => yourMux({ onPort }))` | no: the transport did the work |

`codec` is `structuredCodec` (exported here) where messages are structured values, or
`msgpackCodec` from `@statewalker/webrun-msgpack` where they are bytes.

### Exports

Stream tier and adapter:

| Export | Purpose |
| --- | --- |
| `connect(params: PortParams)` | Resolves `{ call, close }`. One port per call, opened on the consumer's first pull. |
| `serve(params: PortParams, handler)` | Registers a `Duplex` handler. Resolves an idempotent teardown that abandons live streams, then closes the mux. |
| `PortParams` | `{ mux: PortMuxFactory; timeout?: number }`. |
| `PortMuxFactory`, `OnPort` | `(onPort?: OnPort) => PortMux \| Promise<PortMux>`; `(port, meta?) => boolean \| undefined`, `false` rejects. |
| `overPipe(pipe, options: OverPipeOptions)` | A factory over one pipe via `multiplexPort`. Options: `codec`, `side`, `maxPorts`, `maxMessageSize`. |
| `overPorts(factory)` | Pass-through, for a mux this package knows nothing about. |
| `duplexOverPort(port, options?)` | A `Duplex` running one stream on `port`. |
| `serveDuplexOverPort(port, handler, options?)` | The serving half. Returns an idempotent teardown that abandons the stream and notifies the peer. |
| `DuplexOverPortOptions` | `maxMessageSize`, `timeout`, `log`. |
| `STREAM_ABORT` | `"webrun-rpc:stream-abort"`, the `type` of the abandonment notice. |

Port multiplexing:

| Export | Purpose |
| --- | --- |
| `multiplexPort(port, options: PortMuxOptions)` | Emulated multiplexing over one port. |
| `transferPortMux(target, options?: TransferPortMuxOptions)` | Multiplexing with real transferred `MessagePort`s. |
| `PortMux` | `openPort(meta?)`, `close()`, `maxMessageSize`. |
| `PortCodec`, `PortEnvelope` | The wire seam: `post(port, envelope, transfer?)`, `read(event)`. |
| `structuredCodec` | Envelopes passed through unencoded. |
| `DEFAULT_MAX_PORTS` | `1024`. |
| `PORT_TRANSFER` | `"webrun-rpc:port-transfer"`, the `type` of the message that carries a port. |

Typed-JSON RPC:

| Export | Purpose |
| --- | --- |
| `callPort(port, params, options?)` | One typed call, one typed answer. |
| `listenPort(port, handler, options?)` | Answers `callPort`. Returns an unsubscribe. |
| `callBidi(port, input, args?)` / `listenBidi(port, action, accept?)` | Streaming call: send an iterable, receive an async generator. |
| `ioSend(port, output, options?)` / `ioHandle(port, handler, options?)` | The full-duplex iterator exchange `callBidi` / `listenBidi` run on. |
| `send(port, output, options?)` / `recieve(port, options?)` | One `callPort` per iterator chunk, and its receiving side. |
| `NO_TIMEOUT` | `Number.POSITIVE_INFINITY`; as `callPort`'s `timeout`, installs no deadline. |
| `CallPortOptions` | `timeout` (default 1000 ms), `channelName`, `log`, `newCallId`, `signal`. |
| `CallBidiOptions`, `CallBidiArgs` | Adds `bidiTimeout` (default 2147483647 ms) for the outer call. |
| `ListenPortOptions`, `PortHandler`, `BidiHandler`, `IoSendOptions`, `RecieveOptions`, `SendOptions` | Supporting types. |
| `postCancelChannel(port, channelName)` / `listenCancelChannel(port, channelName, onCancel)` / `CANCEL_CHANNEL_TYPE` | The `"cancel-channel"` message `ioSend` posts when its consumer stops early. |
| `getPortCloseSignal(port)` / `setPortCloseSignal(port, signal)` | An `AbortSignal` per port that marks its transport closed; `callPort` combines it with its own `signal`. |

Message passing (types only): `MessageTarget` (`MessageSource` + `MessageSink` + optional
`close()`), `MessageSource` (`addEventListener` / `removeEventListener` for `"message"`, optional
`start()`), `MessageSink` (`postMessage(message, transfer?)`), `MessageListener`. A `MessagePort`
satisfies `MessageTarget` structurally.

`byteChannelFromMessagePort(port)` wraps a `MessageTarget` as a `webrun-streams` `ByteChannel`
(bytes out through `postMessage`, `Uint8Array` / `ArrayBuffer` / views in, everything else
ignored), for driving `webrun-streams`' `emulateMux` yourself. Nothing else in this package uses
it.

## Examples

### `connect` and `serve` over a `MessageChannel`

```ts
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";

const channel = new MessageChannel();
const codec = structuredCodec;

const stop = await serve(
  { mux: overPipe(channel.port2, { codec, side: "responder" }) },
  async function* echo(input) {
    for await (const chunk of input) yield chunk;
  },
);

const { call, close } = await connect({
  mux: overPipe(channel.port1, { codec, side: "initiator" }),
});

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
const { call } = await connect({ mux: overPipe(port1, { codec: structuredCodec }) });
// inside the worker: serve({ mux: overPipe(port, { codec: structuredCodec, side: "responder" }) }, handler)
```

### A stream over a virtual port, wired by hand

```ts
import {
  duplexOverPort,
  multiplexPort,
  serveDuplexOverPort,
  structuredCodec,
} from "@statewalker/webrun-rpc";

const channel = new MessageChannel();

// The serving end: every stream port the peer opens runs one echo handler.
const server = multiplexPort(channel.port2, {
  codec: structuredCodec,
  side: "responder",
  onPort: (port) => {
    serveDuplexOverPort(port, async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });
  },
});

// The calling end: one port per stream.
const client = multiplexPort(channel.port1, { codec: structuredCodec, side: "initiator" });
const streamPort = await client.openPort({ kind: "stream" });
const call = duplexOverPort(streamPort, { maxMessageSize: client.maxMessageSize });

const parts: string[] = [];
for await (const chunk of call([new TextEncoder().encode("ping")])) {
  parts.push(new TextDecoder().decode(chunk));
}
console.log(parts.join("")); // "ping"

await client.close();
await server.close();
```

### Real transferred ports

```ts
import { duplexOverPort, serveDuplexOverPort, transferPortMux } from "@statewalker/webrun-rpc";

const { port1, port2 } = new MessageChannel();

const server = transferPortMux(port2, {
  onPort: (port, meta) => {
    // `meta` is `unknown`: the mux never inspects it, so you narrow it.
    if ((meta as { kind?: string } | undefined)?.kind !== "stream") return false; // reject
    serveDuplexOverPort(port, async function* (input) {
      for await (const chunk of input) yield chunk;
    });
  },
});

const client = transferPortMux(port1);
const port = await client.openPort({ kind: "stream" });
for await (const chunk of duplexOverPort(port)([new Uint8Array([1, 2, 3])])) {
  console.log(chunk); // Uint8Array [1, 2, 3]
}

await client.close();
await server.close();
```

### One typed call

```ts
import { callPort, listenPort } from "@statewalker/webrun-rpc";

const { port1, port2 } = new MessageChannel();
port1.start();
port2.start();

const off = listenPort<{ a: number; b: number }, { sum: number }>(port2, async ({ a, b }) => ({
  sum: a + b,
}));

const { sum } = await callPort<{ sum: number }>(port1, { a: 2, b: 3 }, { timeout: 2000 });
console.log(sum); // 5

off();
```

A handler that throws rejects the caller with the deserialised error. A call with no reply rejects
after `timeout` with `Call timeout. CallId: "<id>".`

### A streaming call

```ts
import { callBidi, listenBidi } from "@statewalker/webrun-rpc";

const { port1, port2 } = new MessageChannel();
port1.start();
port2.start();

const off = listenBidi<number, number>(port2, async function* (input, params) {
  for await (const n of input) yield n * (params.factor as number);
});

for await (const n of callBidi<number, number>(port1, [1, 2, 3], { factor: 10 })) {
  console.log(n); // 10, 20, 30
}

off();
```

`callBidi`'s third argument is the parameter bag the handler receives; `options` inside it is
reserved for `CallBidiOptions`. The optional `accept(params)` predicate on `listenBidi` declines
calls.

## Internals

### Layers

```
  your code ── Connect / Serve ─────────────────────────────┐
                    │ connect / serve                       │
  stream tier ──────┤ duplexOverPort / serveDuplexOverPort  │  layer 2
                    │ one callPort per chunk, "in" / "out"  │
  RPC tier ─────────┘ callPort / listenPort                 ┘
                    │ MessageTarget (a virtual port)
  port mux ──────── multiplexPort (id table + PortCodec)    ┐  layer 1
                    or transferPortMux (real MessagePorts)  ┘
                    │ MessageTarget
  transport ─────── MessagePort, worker, WebSocket, data channel, ...
```

Each virtual port is itself a `MessageTarget`, so a multiplexer composes over another
multiplexer's port, and the RPC tier runs over a virtual port with no byte-stream layer between.

### A port sends and receives messages, nothing more

`multiplexPort` has no backpressure, acknowledgements, credit or buffer ceiling. That matches
`MessagePort` semantics; waiting strategies belong above. The one safety property it holds: **a
message for a port with no consumer is dropped, never queued**, so a peer flooding an unaccepted
port cannot grow memory here.

`multiplexPort` options:

| option | meaning |
| --- | --- |
| `codec` | Required. How envelopes reach the wire. |
| `onPort` | Called when the peer opens a port; return `false` to reject. A throw also rejects. **Without it, inbound ports are rejected**: a port nobody holds has no consumer. |
| `side` | `"initiator"` (default) allocates even ids, `"responder"` odd, so both ends can open concurrently with no negotiation. The two ends of one pipe must disagree. |
| `maxPorts` | Ceiling on concurrently open ports, default `DEFAULT_MAX_PORTS` (1024). Closing a port frees its slot. It bounds the id table, never the total over time, and never delays a message. A peer `open` past the limit is answered with `close` reason `"max-ports"`. |
| `maxMessageSize` | Largest payload a chunk may carry, if the transport has a limit. Reported to the stream tier, never enforced. See below. |

`openPort(meta?)` allocates a port, announces it and returns the local end without waiting for the
peer to accept. That keeps layer 1 free of round trips: messages posted before a rejection are
dropped at the far end and the port goes inert. It is asynchronous because a natively multiplexed
transport cannot produce a port synchronously and both must share one shape. Its guard failures
are rejections, not synchronous throws: `RangeError: webrun-rpc: maxPorts (<n>) reached` and
`Error: webrun-rpc: the multiplexer is closed`. A duplicate `open` id from the peer is ignored
rather than replacing a live port, and a local `openPort` skips ids the peer already claimed with
the wrong parity.

`PortEnvelope` is `{ type: "open", id, meta? }`, `{ type: "message", id, payload }` or
`{ type: "close", id, reason? }`. `structuredCodec.read` accepts only objects with a non-negative
integer `id` and one of those three types, so other traffic on a shared port is ignored.
`structuredCodec` passes envelopes through unencoded, so `ArrayBuffer`s move zero-copy through the
transfer list; it omits an empty transfer list because some implementations reject one.

### No close is observable at layer 1

`MessageTarget` has no close event and a virtual port exposes no state. When a port closes, its
listeners are cleared and `postMessage` becomes a no-op. There is no event, no error, and the
`close` envelope's `reason` is discarded rather than delivered. A closed port is indistinguishable
from a working one that nobody answers. A real `MessagePort` behaves the same way, so **the layer
above carries its own end-of-stream signal** as an ordinary message.

### Why `connect` / `serve` take a factory and not a `PortMux`

Every mux decides accept-or-reject synchronously, inside the `open` envelope, and tells the peer
on the spot. A mux handed over already built would have a window between its construction and its
handler being attached, and a port arriving in that window is rejected outright: measured, zero
messages delivered and the peer told `rejected`. A factory closes the window by construction
(`tests/port-factory-no-race.test.ts`). `connect` calls the factory with no handler, which is how a
caller declines inbound ports. Whichever side called the factory owns the mux and closes it.

`connect` opens the port on the consumer's first pull, not when `call` is invoked, so a stream
that is built and dropped costs the peer nothing. Every port it opens carries `meta`
`{ kind: "stream" }`, so a peer running other things over the same mux can tell stream ports apart.

### Flow control is a window of one chunk

`duplexOverPort` sends each direction as one `callPort` per chunk on its own channel (`"in"` for
the caller's input, `"out"` for the handler's output). The reply to a chunk call is the
confirmation that the consumer pulled past it, and the next chunk is not sent until then. So **one
open port holds at most one chunk** in each direction, and there is no buffer size to tune. Over
`multiplexPort` that bounds the whole mux at `maxPorts × one chunk`. `transferPortMux` has no
`maxPorts`, so bounding how many ports you open is up to you.
`tests/connect-serve-backpressure.test.ts` measures it: a 5000-chunk producer against a handler
that reads one chunk and stops gets exactly one chunk out.

A peer that sends a second chunk before the first is confirmed gets `response:error` with
`webrun-rpc: peer sent a second unconfirmed chunk; the stream port is closed`, and that port is
closed. Other ports on the mux are untouched.

The cost: single-stream throughput is `chunk ÷ RTT`. In-process that is negligible; over a 50 ms
round trip, a 10 MiB body in 12 KiB chunks is 854 sequential round trips, about 43 s. Concurrency
comes from running many streams, one port each, not from pipelining one.

**One stream per port.** Nothing enforces it: invoking the same `duplexOverPort` result twice on
one port makes both invocations cross-talk on the same two channel names. Open a port per call.

### `maxMessageSize` bounds the payload, not the frame

The stream tier splits payloads to `maxMessageSize` with `toChunks`; the chunk wrapper, the
`callPort` request, the mux envelope and the codec are added on top. Over `msgpackCodec` that
framing measured 123–128 bytes (modelled ceiling 134), varying per chunk with the call id's
length. **Set it at least 256 bytes below the transport's real limit.** Set to the limit exactly,
a full-size chunk overruns it; a 12 KiB setting produced 12,413-byte frames, and on LiveKit an
oversized message delivered a body as zero bytes with no error on either side. A transport with no
ceiling leaves it unset, and nothing is split.

### There is no timeout by default

A per-chunk deadline fails a consumer that is merely slow, so the stream tier calls `callPort`
with `NO_TIMEOUT` for every chunk. The `timeout` option (on `duplexOverPort`, `serveDuplexOverPort`
and `connect` / `serve`) is an inactivity timeout for the whole stream: any chunk in either
direction resets it, and elapsing aborts the stream with `webrun-rpc: stream idle for <n> ms`.
Unset, zero or non-finite means none.

Know what you buy if you set it. The clock resets only when a chunk call returns, and that reply
is withheld until the consumer has pulled past the value. The clock cannot tell "slow" from "dead":
a consumer slower than the timeout **is** failed.

### How an abandoned stream is reported

Because close is invisible at layer 1, a side that abandons a stream posts an out-of-band
`{ type: STREAM_ABORT }` message on the port. It is posted from exactly two places: the teardown
returned by `serveDuplexOverPort` (and so `serve`'s teardown), and the caller's `finally` as its
generator unwinds.

| what ends the stream | notice posted? | what the peer observes |
| --- | --- | --- |
| the caller stops iterating (`break`, `return`, `throw`) | yes | `STREAM_ABORT`; the handler unwinds through `iter.return()` |
| the caller's `timeout` elapses | yes, from the caller's `finally` | `STREAM_ABORT` |
| the serve-side teardown is called | yes | the caller's stream rejects with `webrun-rpc: the peer abandoned the stream` |
| the serve side's `timeout` elapses | **no** | nothing on `"out"`: a caller waiting there waits forever. A caller still sending gets `webrun-rpc: the stream is closed` on its chunk calls, but `duplexOverPort` surfaces only the inbound half, so its consumer never sees it |
| a window violation, on either side | **no** | the offender gets the `response:error` above; the enforcer closes the port, which the other half cannot see, so a peer waiting on the other half waits forever |

The notice makes cooperative abandonment observable. It is not a liveness mechanism: **give the
side that must not hang its own `timeout`.** A caller with a `timeout` detects both silent rows; a
caller without one does not.

An abort unwinds a producing handler through `iter.return()`, not by throwing into it. A handler's
`catch` never sees the abort reason; only `finally` runs. Put cleanup in `finally`.

### `transferPortMux` moves real ports

Each `openPort` creates a `MessageChannel`, posts `{ type: PORT_TRANSFER, meta }` with one end in
the transfer list, and returns the other end. There is no id table, no `maxPorts` and no
per-message envelope, because the platform does the multiplexing. A transferred port can cross an
origin or worker boundary and be handed to code that never saw `target`, which an emulated port id
cannot. A `PORT_TRANSFER` message without an attached port is dropped. `onPort` returning `false`
(or throwing) closes the port; no `onPort` rejects every inbound port. The caller picks this mux
explicitly; nothing sniffs capabilities. `target` must be a full `MessageTarget`; a send-only
`MessageSink` such as a `ServiceWorkerClient` is not supported.

**The issued-port set never shrinks.** Every port opened or accepted is kept until `close()`, and
nothing removes a port when it closes. Bounding it needs a per-port `close` event listener, a newer
platform surface this implementation avoids. Nothing fails; the set just grows. Scope the mux to the
lifetime of the thing it multiplexes — a worker, an iframe, a connection — not to the process.

### The typed-JSON RPC tier on the wire

`callPort` posts `{ type: "request", channelName, callId, params }` and waits for
`{ type: "response:result" | "response:error", channelName, callId, ... }`. `channelName`
(default `""`) lets several conversations share one port; `callId` defaults to
`` `call-${Date.now()}-${random}` ``. The default `timeout` is 1000 ms; any value that is not a
finite number above zero installs no deadline. Errors cross as `webrun-streams`' serialised form
(`message`, `stack`, and every own enumerable property) and are rebuilt as `Error`s.

`callPort` rejects early when its `signal` aborts, or when the port's close signal fires.
`getPortCloseSignal(port)` returns the `AbortSignal` registered with `setPortCloseSignal`, or
`undefined`. A raw `MessagePort` never reports its peer closing, so an adapter that does know when
its transport closed can register a signal and pending calls reject instead of waiting for their
timeout. Nothing in this package registers one.

`send` sends an iterable as one `callPort` per chunk and ends with `{ done: true }`; `recieve`
yields one async generator per inbound stream and never ends on its own. `ioSend` / `ioHandle`
pair them in both directions, and `ioSend` posts `{ type: "cancel-channel", channelName }` when
its consumer stops early so the producer stops without waiting for timeouts. `callBidi` picks a
random sub-channel, announces it with an outer `callPort` (timeout `bidiTimeout`), and runs
`ioSend` on it; if the outer call rejects, the inner stream is cancelled and the error rethrown.

### Conformance

The unmodified L0–L6 suite of `@statewalker/webrun-streams-conformance` runs against two entry
points into the same stack: `connect` / `serve` over a `MessageChannel` pair
(`tests/conformance.test.ts`) and `multiplexPort` + `duplexOverPort` wired by hand
(`tests/conformance-new-stack.test.ts`).

```sh
pnpm --filter @statewalker/webrun-rpc test
```

L6 does not prove flow control on either run. The suite's `PairTuning` is a credit window (`mtu`,
`maxStreamBuffer`), and this stack has none to size. The `connect` / `serve` run maps `mtu` to
`maxMessageSize`, so its 256 KiB body crosses as 64 frames; the hand-wired run ignores tuning, so
its body crosses as one chunk each way. Bounded memory is measured in
`tests/connect-serve-backpressure.test.ts`, `tests/backpressure-both-directions.test.ts`,
`tests/duplex-over-port-timeout.test.ts` and `tests/duplex-over-port-hostile.test.ts`.

### Dependencies

One runtime dependency, `@statewalker/webrun-streams`: the `Duplex` / `Connect` / `Serve` types,
the iterator primitives under the stream and RPC tiers (`sendIterator`, `recieveIterator`,
`toChunks`), error serialisation, and the `ByteChannel` type for `byteChannelFromMessagePort`. No
peer dependencies. The byte-transport codec lives in `@statewalker/webrun-msgpack`, so this package
stays free of an encoder.

## License

MIT
