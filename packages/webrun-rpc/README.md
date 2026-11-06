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
| `overPipe(pipe, options: OverPipeOptions)` | A factory over one pipe via `multiplexPort`. Options: `codec`, `side`, `maxPorts`, `maxMessageSize`, `signal`, `window`, `frameSize`. |
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
| `PortMux` | `openPort(meta?, { signal }?)`, `close(reason?)`, `ports?()`, `maxMessageSize`. |
| `portBufferedAmount(port)`, `whenPortReady(port, below?)` | A windowed port's queued bytes, and a promise for room. See below. |
| `PortInfo`, `OpenPortOptions` | What `ports()` reports per port (`id`, `meta`, `openedAt`, `lastActivity`); `openPort`'s options. |
| `PortCodec`, `PortEnvelope` | The wire seam: `post(port, envelope, transfer?)`, `read(event)`, and optionally `encode(envelope)` / `decode(data)` for byte codecs (exact window sizes, frames). |
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

Without `window`, `multiplexPort` has no backpressure, acknowledgements, credit or buffer ceiling.
That matches `MessagePort` semantics; waiting strategies belong above, or in the opt-in window
described below. The one safety property it always holds: **a
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
| `signal` | The transport's life. On abort the mux closes with `signal.reason`; an already-aborted signal gives a closed mux. See below. |
| `window` | Per-port flow control in bytes, off when unset. See "A port with a window holds only its own bytes" below. |
| `frameSize` | Fair framing in bytes, off when unset; needs `window`. See "Large messages take turns with small ones" below. |
| `keepalive` | `{ intervalMs, misses? }`, off when unset: ping the peer and close the mux after `misses` unanswered pings from a peer that answered before. See "A port lives until its transport or its user lets go" below. |
| `onLeak` | Development aid, off when unset: called with a port's `PortInfo` when its consumer dropped it without `close()`, and the port is freed. See "A port lives until its transport or its user lets go" below. |

### A port with a window holds only its own bytes

Without a window, a port has no backpressure: a slow consumer turns into unbounded memory, and
every other port waits behind the shared queue. With `window: n`, each port this mux opens asks
for flow control in its `open`, and the peer's mux applies it to that port in both directions.
Each side may then have at most `n` bytes of a port's messages delivered to the other side and
not yet consumed. What exceeds the window waits in the port's send queue:

- `portBufferedAmount(port)` returns the queued bytes;
- `whenPortReady(port, below = 0)` resolves once at most `below` bytes are queued.

A sender that must not queue without bound awaits `whenPortReady` before posting more. It always
resolves on a later task, never synchronously: a producer loop with room to spare would otherwise
never yield, and the transport's own events (the credit that refills the window, the socket's
writes) would never run.

A message counts as consumed once every listener has returned, or, for a listener that returns a
promise, once it settles. A consumer that takes messages from its own queue returns a promise
that settles when it takes them. **A listener whose promise never settles keeps its port's window
spent for good**: correct for backpressure, and visible in `mux.ports()`, whose `unconsumed`
stays at the window (with `queued` and `outstanding` on the sending side).

Credit goes back in batches: at once from a quarter of the window, else on the next task. 10,000
small messages and their echoes take fewer than 200 credit envelopes.

**What a message costs.** When both ends' codecs implement `encode` / `decode`, as `msgpackCodec`
does, the window counts the encoded bytes, envelope included, and the message is encoded once,
when it is posted. Each end says so in its `open` or its ack (`exact: true`); if either cannot,
both count an estimate computed from the same value: byte length for `ArrayBuffer`s and typed
arrays, a string's length, an object's values 4 levels deep and at most 256 of them, and at least
64 bytes. Two ends counting different sizes would leak window on every message until the port
wedged. A message larger than the window is sent once nothing else is outstanding.

**Older peers.** A peer from before the window reads `window` in an `open` but never sends
credit, and a codec from before it drops `credit` envelopes. So neither end holds back until the
other has shown it reads credit: the responder acknowledges the window with a zero-byte `credit`
before `onPort` runs (so what `onPort` posts reaches the opener after it, counted the same way on
both ends), and the opener answers that ack with one of its own. Until then
each end counts bytes but holds nothing back, so a port to an older peer, or over an older codec,
keeps running without flow control, as it always did; `ports()` reports `window` only once it is
in force. A peer's `window` that is not a positive integer is ignored.

**Closing does not wait for credit.** A port closed with messages still queued sends them at once,
then its close, regardless of the window: a peer that stopped returning credit (a listener that
never settles) must still learn the port is closed, and nothing is kept for a port nobody holds.
A message that has to wait in the queue is copied when posted (`structuredClone`, or encoded at
once by a byte codec), as `postMessage` copies at once, so a caller reusing its buffer does not
change what is sent. `listenPort` counts a request as consumed when it reaches its handler, not
when the handler finishes, so a handler waiting on a later call on the same port does not hold
the window that call needs. The window is off by default: 256 KiB favours latency under load, 1-4 MiB favours bulk
throughput.

### Large messages take turns with small ones

All ports share one pipe, and a message leaves whole. So without more, a port sending 1 MiB holds
the pipe for the whole megabyte, and a 64-byte message on another port waits behind it: the
window bounds how much is in flight, not the order on the wire. With `frameSize: n`:

- every windowed port's messages, and every port's `close`, wait in a per-port queue, and the
  queues take turns, one item each, whenever the pipe has room (a port without a window posts its
  messages at once, as without `frameSize`);
- a message whose encoding is larger than `n` is split into `frame` envelopes of `n` bytes, which
  the peer reassembles before delivery.

A small message then waits for one frame, not for a whole large message. **It needs the pipe to
report when it is full**: `MessageTarget`'s optional `whenDrained()` (and `bufferedAmount`), which
`messageTargetOverStream` in `@statewalker/webrun-streams-libp2p` provides. A pipe without it,
such as a `MessagePort`, accepts everything at once, so the queues empty in one go and only the
frames of messages posted together interleave.

It also needs `window` and byte codecs (`encode` / `decode`) on both ends. A side frames only on a
port whose window is in force with exact sizes agreed (`exact: true` in the `open` and in its
acknowledgement), and accepts frames only there; a frame anywhere else is dropped. An older peer,
or one whose codec cannot decode, gets whole messages. A frame sequence buffers no more than the
same message sent whole would. If the pipe's `whenDrained()` rejects, the mux closes with that
error, so the ports waiting behind it fail instead of hanging. 16-64 KiB frames cost one small envelope each (about 15 bytes with
`msgpackCodec`).

`openPort(meta?)` allocates a port, announces it and returns the local end without waiting for the
peer to accept. That keeps layer 1 free of round trips: messages posted before a rejection are
dropped at the far end and the port goes inert. It is asynchronous because a natively multiplexed
transport cannot produce a port synchronously and both must share one shape. Its guard failures
are rejections, not synchronous throws: `RangeError: webrun-rpc: maxPorts (<n>) reached` and
`Error: webrun-rpc: the multiplexer is closed`. The `RangeError` goes on with the three commonest
`meta.kind`s among the open ports, `open ports by kind: http: 1000, ws: 24`, so a full table names
the consumer that filled it (`"?"` counts ports without a kind). A duplicate `open` id from the
peer is ignored rather than replacing a live port, and a local `openPort` skips ids the peer
already claimed with the wrong parity.

`PortEnvelope` is `{ type: "open", id, meta?, window?, exact? }`, `{ type: "message", id, payload }`,
`{ type: "close", id, reason? }`, with a window `{ type: "credit", id, bytes, exact? }`, with
`frameSize` `{ type: "frame", id, data, last? }`, and with `keepalive` `{ type: "ping", id }` /
`{ type: "pong", id }` (on `Number.MAX_SAFE_INTEGER`). The codecs' `read` accept only objects with a non-negative integer `id`
and one of those seven types, so other traffic on a shared port is
ignored.
`structuredCodec` passes envelopes through unencoded, so `ArrayBuffer`s move zero-copy through the
transfer list; it omits an empty transfer list because some implementations reject one.

### A port lives until its transport or its user lets go

A port leaves the table only when one side closes it or the mux closes. Nothing else frees it, and
a full table refuses every new port. So both lifetimes are wired in explicitly:

- **The transport.** A `MessagePort`, a terminated worker or a dead libp2p stream gives no close
  event, so the mux cannot notice by itself. Pass `signal` and abort it from whatever does notice
  (a worker's `exit`, a stream's `close`, a liveness lock): the mux closes with `signal.reason`,
  every port's close signal aborts with it, and calls in flight reject at once instead of hanging.
  `close(reason)` does the same by hand. A port opened from a close-signal listener while the mux
  closes is refused, and a transport `close()` that rejects on this path is swallowed rather than
  left as an unhandled rejection.
- **The user.** `openPort(meta, { signal })` closes the port when `signal` aborts, with
  `signal.reason` as the reason of the port's close signal; a signal already aborted rejects
  `openPort` with its reason and opens nothing. `transferPortMux` honours the signal too. Virtual
  ports are also disposable where the runtime defines `Symbol.dispose`, so
  `using port = (await mux.openPort()) as MessageTarget & Disposable` closes it on scope exit. The
  cast is needed because the declared type leaves `Symbol.dispose` out: naming it would require
  every consumer to compile with the `esnext.disposable` lib.

What aborts `signal` depends on the transport. A Node worker reports its death:

```ts
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./worker.js", import.meta.url));
const { port1, port2 } = new MessageChannel();
worker.postMessage({ port: port2 }, [port2]);
const exited = new AbortController();
worker.once("exit", (code) => exited.abort(new Error(`the worker exited (${code})`)));
const mux = multiplexPort(port1, { codec: structuredCodec, signal: exited.signal });
```

A browser realm (a tab, an iframe, a worker) reports nothing, but the browser releases its
[Web Locks](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) when it ends. The other realm
holds a lock for its whole life, and this side asks for the same lock, which it gets only then:

```ts
// In the other realm: a name of its own (realms of one origin share locks), and
// "ready" only from inside the callback, once the lock is really held.
const lock = `realm:${crypto.randomUUID()}`;
navigator.locks.request(lock, () => {
  port.postMessage({ ready: lock });
  return new Promise(() => {}); // held until this realm ends
});

// Here, on that message (`{ ready }`) — asked before the lock is held, it would be granted at once:
const gone = new AbortController();
navigator.locks.request(message.ready, () => gone.abort(new Error("the other realm is gone")));
const mux = multiplexPort(port, { codec: structuredCodec, signal: gone.signal });
```

Locks are per browser profile, so this works between realms of one origin, never across a
network. In Node 24 a worker's locks are not visible to the thread that started it (the parent's
request is granted while the worker holds the lock), so use `exit` there.

**When nothing reports the death, `keepalive` probes for it.** With
`keepalive: { intervalMs: 5000, misses: 3 }` the mux pings every 5 s, the peer answers, and
anything the peer sends counts as an answer. After 3 pings in a row with nothing back from a peer
that has answered before, the mux closes with `webrun-rpc: the peer did not answer 3 keepalive
pings, 5000 ms apart`, as if `signal` had aborted. The silence it takes is between `misses ×
intervalMs` and one interval more. That catches a realm that died with no lock to tell and one
that froze. It cannot tell a peer whose event loop is blocked for that long from a dead one, so
size the product above the longest pause you expect.

- **What counts as silence.** Misses are pings unanswered, not time since the last message, so
  timer jitter cannot turn a prompt answer into a miss, and `misses: 1` is usable. A tick taken
  while this end's own pipe reports a backlog (`bufferedAmount > 0`, as `messageTargetOverStream`
  does) is not counted: a ping stuck behind this end's own upload has not reached the peer.
- **Who is held to it.** Every current mux answers pings, whether or not it sets `keepalive`, so
  one end is enough, and the two ends' intervals need not match. An older peer never answers and
  is never closed for it. Nor is a peer that dies before its first answer: wire `signal` as well
  where the transport can report death.
- **What it does not catch.** A peer that keeps sending but stopped consuming is alive by this
  measure; the window (`window`) is what bounds that.
- **Wire.** `ping` and `pong` are envelopes of their own, sent on the largest safe integer id,
  which no port takes. An older mux whose codec passes unknown envelopes through reads them as a
  close of that id, and so closes nothing. The bundled codecs of older versions drop them.

The interval timer is `unref`'d in Node, so it never keeps a process alive. `intervalMs` must be in
(0, 2³¹ − 1] (past that, timers fire at once) and `misses` a positive integer, or `multiplexPort`
throws a `RangeError`.

`ports()` lists what is open, with each port's `meta`, `openedAt` and `lastActivity` (the last
message either way), for finding a consumer that never closes.

**A dropped port can be reported (`onLeak`).** Weak references cannot free leaks on their own:
the mux must deliver to every open port, and an abandoned port's listeners usually close over the
port, so it stays reachable from the table. What they can do is catch the ports nothing else
holds. The mux keeps only its own record of a port, never the consumer's object, so with
`onLeak` a port its consumer dropped without `close()` is reported once the collector reclaims it
(`onLeak(info)`, with its `meta`). What happens next depends on its listeners:

- **No listener left:** nothing can reach the port again, so it is freed on both ends as a close
  would free it. Its close signal aborts with `webrun-rpc: the port was dropped without close()`;
  the peer's port closes as on any close (`webrun-rpc: the peer closed the port`).
- **A listener left** (a subscription that keeps only its handler): the port is still receiving,
  so it is reported and left open. Hold the port, or close it, to silence the report.

A port whose own listener refers to it is never collected, so never reported; when the collector
runs is up to the runtime. It is a development aid: each port costs a `FinalizationRegistry`
entry.

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

`serve` forwards that `return()` to the handler's output at once, even while the handler is still
working on its first chunk, with or without `maxMessageSize` (whose chunker would queue it too). Its own tracking wrapper would otherwise queue it behind that pending
`next()`, as any async generator does. A handler that wraps its output to watch for `return()`
therefore sees the abandonment when it happens, not when it next yields:
`@statewalker/webrun-http-streams` aborts the served `Request.signal` that way.

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
