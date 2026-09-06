# @statewalker/webrun-rpc

Ports and RPC over them, in the `webrun-streams-*` family: two port
multiplexers that turn one `MessageTarget` into many, a `Duplex` stream tier
that runs one stream over one port, a legacy `MessagePort`-backed `Connect` /
`Serve` adapter, and a typed-JSON RPC tier that runs over any `MessageTarget`.

## What this is

Four pieces, one dependency:

- **Port multiplexing** (`multiplexPort` / `PortMux`, and `transferPortMux`) —
  turns one `MessageTarget` into many virtual ones. Each virtual port is itself
  a `MessageTarget`, so a multiplexer composes over another multiplexer's port,
  and everything below can run directly on top of it. `multiplexPort` emulates
  multiplexing over any single port; `transferPortMux` hands the peer real
  transferred `MessagePort`s where the platform provides them. See
  [Port multiplexing](#port-multiplexing) and
  [Transferring ports](#transferring-ports).
- **Stream tier** (`duplexOverPort` / `serveDuplexOverPort`) — one
  [`webrun-streams`](../webrun-streams) `Duplex` over one port, with
  backpressure that is a property of the protocol rather than a configured
  buffer. **This is what new code should use.** See
  [Streams over a port](#streams-over-a-port).
- **Legacy byte-stream tier** (`connect` / `serve`) — the same `Duplex` seam
  over a `MessagePort`, but built on `emulateMux`: one port becomes one
  `ByteChannel`, and `emulateMux` provides multi-stream inside it. **This is
  the tier Plan C removes**, along with `emulateMux`,
  `byteChannelFromMessagePort` and `ByteChannel` as a public seam. It still
  works and is still tested; do not build new code on it.
- **Typed-JSON RPC tier** (`callPort` / `listenPort` / `callBidi` /
  `listenBidi` / `ioSend` / `ioHandle` / `send` / `recieve`) — request/response
  with typed JSON arguments per call, relocated here from the retired
  `webrun-streams-port` package. It types against `MessageTarget` rather than
  `MessagePort`, so it also runs directly over a virtual port from
  `multiplexPort` — one raw port fans out into many independent RPC channels
  with no byte-stream layer in between. Use this when you want plain JSON
  messaging and do not need byte-stream semantics.

All four are exported from the package root. The only runtime dependency is
[`@statewalker/webrun-streams`](../webrun-streams).

## Why it exists

`MessagePort` is the browser's universal in-process seam — Workers,
SharedWorkers, ServiceWorkers, iframes, `MessageChannel` pipes between two
modules in the same tab. It is also the most primitive: `postMessage` fires and
forgets. There is no request, no correlation, no backpressure, no half-close,
and an exception on the far side simply never arrives.

The stream tier makes a port indistinguishable from any other transport in
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

### Legacy byte-stream tier

This is the tier Plan C removes. New code should use
[Streams over a port](#streams-over-a-port) instead.

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

## Streams over a port

`duplexOverPort(port, options)` runs one `Duplex` over one port;
`serveDuplexOverPort(port, handler, options)` is its serving half. Each
direction is one `callPort` per chunk on its own channel (`"in"` for the
caller's input, `"out"` for the handler's output), and the reply to a chunk
*is* the confirmation that the consumer pulled past it.

**One stream per port.** A stream port carries exactly one invocation — open
one port per call. Nothing enforces this: invoking the same `duplexOverPort`
result twice on one port makes both invocations cross-talk on the same two
channel names.

```js
import {
  duplexOverPort,
  multiplexPort,
  serveDuplexOverPort,
  structuredCodec,
} from "@statewalker/webrun-rpc";

const channel = new MessageChannel();
channel.port1.start();
channel.port2.start();

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
const client = multiplexPort(channel.port1, {
  codec: structuredCodec,
  side: "initiator",
});

const streamPort = await client.openPort({ kind: "stream" });
const call = duplexOverPort(streamPort, { maxMessageSize: client.maxMessageSize });

const parts = [];
for await (const chunk of call([new TextEncoder().encode("ping")])) {
  parts.push(new TextDecoder().decode(chunk));
}
console.log(parts.join("")); // "ping"

await client.close();
await server.close();
```

### `DuplexOverPortOptions`

| option | type | meaning |
| --- | --- | --- |
| `maxMessageSize` | `number` | Largest payload one chunk may carry, normally `PortMux.maxMessageSize`. Bodies are split to fit with `toChunks`. Unset means no limit and no splitting. |
| `timeout` | `number` | Inactivity timeout for the **whole stream**, in ms. See below. Unset — the default — means no timeout at all. |
| `log` | `(...args) => void` | Logging hook; defaults to a no-op. |

### Flow control: a window of one

Within one direction the next chunk is never sent until the previous one has
been delivered **and** pulled past by the consumer. There is no credit window
and no buffer ceiling to tune, because there is nothing to tune: **one open
port holds at most one chunk.** Over `multiplexPort` that composes into a
whole-mux bound of `maxPorts × one chunk`, because `maxPorts` caps concurrent
ports. `transferPortMux` has no `maxPorts` (see
[Transferring ports](#transferring-ports)), so the per-port bound is the same
but the mux-wide one is yours to impose by bounding how many ports you open.

A peer that sends a second chunk before the first is confirmed has that call
refused and **that port closed** — the penalty is scoped to the offending port
and every other port on the mux is untouched.

The honest cost, from the design's own numbers: single-stream throughput is
`chunk ÷ RTT`. In-process that is negligible. Over a 50 ms WAN round trip a
10 MiB body is **~43 s**, because it is 854 sequential round trips.
Concurrency does not come from pipelining one stream — it comes from running
many streams, which are genuinely independent because each owns its own port.

### The timeout

There is **no timeout by default**, and that is deliberate: a per-chunk
deadline fails a consumer that is merely slow, which is a bug rather than a
policy. `callPort` gained `NO_TIMEOUT` for the same reason, and the stream tier
uses it for every chunk call.

The `timeout` option is an inactivity timeout for the whole stream: any chunk
in either direction resets it, and elapsing aborts the stream.

**Know what you are buying if you set it.** The clock is only reset once a
chunk call *returns*, and that reply is withheld until the consumer has pulled
past the value. The inactivity clock therefore cannot distinguish "the peer is
slow" from "the peer is dead": with an explicit `timeout`, a consumer slower
than it **is** failed. The default of none is why a slow consumer is safe out
of the box.

### Cancellation

Layer 1's close is invisible to layer 2 (see
[Port multiplexing](#port-multiplexing)): a closed port drops its listeners
silently and is indistinguishable from a working port nobody is answering. So a
side that abandons a stream posts an out-of-band `STREAM_ABORT` notice on the
port — which is the only signal the peer can act on.

**Three routes post that notice; two do not.** The notice is posted from
exactly two places in the implementation — the teardown returned by
`serveDuplexOverPort`, and the caller's own `finally` as its generator unwinds
— and everything else that ends a stream simply aborts locally. Measured:

| what ends the stream | notice posted? | what the peer actually observes |
| --- | --- | --- |
| the caller stops iterating (`break`, `return`, `throw`) | **yes** | `STREAM_ABORT`; the handler unwinds through `iter.return()` |
| the caller's inactivity `timeout` elapses | **yes** — the abort rejects the caller's stream, and its `finally` posts on the way out | `STREAM_ABORT` |
| you call the teardown `serveDuplexOverPort` returned | **yes** | `STREAM_ABORT`; the caller's stream rejects with `the peer abandoned the stream` |
| the **serve side's** inactivity `timeout` elapses | **no** | nothing on the `out` half — a caller parked there waits forever. A caller still *sending* has its chunk calls answered `webrun-rpc: the stream is closed`, but `duplexOverPort` surfaces only the inbound half, so that rejection never reaches its consumer either |
| a **window violation** (a second unconfirmed chunk), on either side | **no** | the offender gets `response:error` on the channel it violated, naming the violation. Nothing else: the enforcer closes the port, and that close is exactly the layer 1 signal layer 2 cannot see. A peer parked on the other half waits forever |

So the notice is what makes a *cooperative* abandonment observable. It is not a
general liveness mechanism, and the two rows without one are a known gap rather
than a subtlety of the wording: **give the side that must not hang its own
`timeout`.** A caller with a `timeout` set detects both of the silent rows on
its own clock; a caller without one does not detect them at all.

**An abort unwinds a producing handler through `iter.return()`, not by
throwing into it.** A handler's `catch` never sees the abort reason; only its
`finally` runs. Put cleanup in `finally`.

## API

### Stream tier — exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `duplexOverPort(port, options?)` | function | Returns a `Duplex` running one stream on `port`. |
| `serveDuplexOverPort(port, handler, options?)` | function | Installs `handler` as the serving half. Returns an idempotent teardown that abandons the stream and notifies the peer. |
| `STREAM_ABORT` | constant | The `type` of the out-of-band notice a side posts when it abandons a stream. Exported because tests and adapters assert on it. |
| `DuplexOverPortOptions` | type | `maxMessageSize`, `timeout`, `log` — see [above](#duplexoverportoptions). |
| `NO_TIMEOUT` | constant | Pass as `callPort`'s `timeout` to install no deadline at all. |

### Legacy byte-stream tier — exports

Everything in this table goes away with `emulateMux` in Plan C.

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
| `CallPortOptions` | `timeout` (default 1000 ms; `NO_TIMEOUT`, or any value that is not a finite number above zero, installs no deadline), `channelName`, `log`, `newCallId`, `signal`. |
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
| `maxMessageSize` | `number` | Largest **payload** a chunk may carry, if the transport has a limit. Reported, not enforced. It bounds the payload, **not the frame**: the layer above chunks the payload to it and the envelope framing is added on top afterwards — measured at 124–126 bytes over `msgpackCodec`, with a modelled ceiling of 134. **Set this ~256 bytes below the transport's real limit**, or a full-size chunk overruns it (a 12 KiB setting was measured producing 12,413-byte frames). |

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

## Transferring ports

`transferPortMux(target, options)` is a second `PortMux` with the same
`openPort` / `close` / `maxMessageSize` shape, so the stream tier above it is
identical — but its ports are **real, transferred `MessagePort`s**. Each
`openPort` creates a `MessageChannel`, transfers one end to the peer over
`target`, and returns the other. There is no id table, no `maxPorts` and no
envelope overhead per message, because the platform does the multiplexing.

```ts
import { transferPortMux } from "@statewalker/webrun-rpc";

const mux = transferPortMux(worker, {
  onPort: (port, meta) => {
    // `meta` is `unknown` — layer 1 never inspects it, so you narrow it.
    if ((meta as { kind?: string })?.kind !== "stream") return false; // reject
    serveDuplexOverPort(port, handler);
  },
});
```

| option | type | meaning |
| --- | --- | --- |
| `onPort` | `(port, meta?) => boolean \| undefined` | Called when the peer transfers a port in. Return `false` to reject it — the port is closed and nothing further arrives on it. Any other return value, `undefined` included, accepts. **Without it, inbound ports are rejected**, matching `multiplexPort`. |
| `maxMessageSize` | `number` | Reported to the layer above, never enforced. A `MessagePort` normally has no limit. |

`PORT_TRANSFER` is the `type` of the envelope that carries a port to the peer.
A message with that `type` and no attached port is malformed and is dropped, so
a shared parent port is not corrupted.

**It needs structured clone with transferables**, so it exists in browsers,
workers and iframes and nowhere else — not over a byte transport. The caller
selects it explicitly rather than by capability sniffing: use `multiplexPort`
where the transport is one pipe of bytes.

What it buys over emulation: a transferred port can cross an origin or a worker
boundary and be handed to code that never saw `target`, which is what a relay
handing a live connection to a third party needs. An emulated port id is
meaningless outside its own mux.

`target` must be a full `MessageTarget`. Reaching a send-only `MessageSink` —
a `ServiceWorkerClient`, say — is a real use of port transfer but needs a
different entry point, and is not part of this interface.

**Caveat: the issued-port set never shrinks.** Every port `transferPortMux`
opens or accepts is retained until `close()`, and nothing removes a port from
that set when it closes. There is no `maxPorts` here for it to exhaust, so
nothing fails — the set just grows, holding dead `MessagePort` handles for as
long as the mux lives. Bounding it needs a per-port `close`-event listener, a
newer platform surface this implementation otherwise avoids; it is a known,
deliberately deferred gap rather than an oversight. In practice: **scope the
mux to the lifetime of the thing it multiplexes** — a worker, an iframe, a
connection — rather than making one process-wide mux and opening streams
through it forever.

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

The unmodified L0–L6 suite of
[`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance) runs
**twice**, 11 tests each, against two independent stacks:

| run | stack |
| --- | --- |
| `webrun-rpc (MessageChannel pair)` | the legacy tier — `connect` / `serve` over `emulateMux` |
| `webrun-rpc (multiplexPort + duplexOverPort)` | the stream tier — a virtual port per call |

Neither the suite nor the legacy run was changed to accommodate the new one.

```sh
pnpm --filter @statewalker/webrun-rpc test
```

L6's green on the stream-tier pair is an **integrity check only**. That pair
ignores `PairTuning`, because there is no credit window to shrink, and with
`maxMessageSize` unset the level's 256 KiB body crosses as exactly one chunk in
each direction. It says the body round-trips; it says nothing about flow
control. This stack's flow-control coverage is in
`tests/duplex-over-port-timeout.test.ts` and
`tests/duplex-over-port-hostile.test.ts`.

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |

No runtime dependencies outside the workspace, no peer dependencies. ESM only
(`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
