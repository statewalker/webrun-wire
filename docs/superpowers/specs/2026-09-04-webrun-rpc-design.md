# `webrun-rpc` — automatic client/server stubs over the port primitives

Date: 2026-09-04
Status: Draft — awaiting review

## Origin

The request was: port <https://github.com/statewalker-attik/webrun-ports> into
webrun-wire as a `webrun-rpc` package, convert it to TypeScript, check for
functional duplication with the other packages, and use the result to build
generic client/server adapters with `FilesApi` on top.

Investigation showed the port is already complete. What follows is what the
work turns out to be instead.

## Finding 1 — the port already happened

Every one of the twelve `webrun-ports` exports is present in webrun-wire, in
TypeScript:

| upstream `webrun-ports` | current home |
| --- | --- |
| `callPort`, `listenPort` | `webrun-streams-port/src/call-port.ts`, `listen-port.ts` |
| `callBidi`, `listenBidi` | `webrun-streams-port/src/call-bidi.ts`, `listen-bidi.ts` |
| `ioSend`, `ioHandle` | `webrun-streams-port/src/io-send.ts`, `io-handle.ts` |
| `send`, `recieve` | `webrun-streams-port/src/send.ts`, `recieve.ts` |
| `sendIterator`, `recieveIterator` | `webrun-streams/src/send-iterator.ts`, `recieve-iterator.ts` |
| `serializeError`, `deserializeError` | `webrun-streams/src/errors.ts` |

The two iterator helpers and the error codec were promoted into
`webrun-streams`, the transport-agnostic foundation, rather than staying in the
port package — correctly, since none of them mention a port. Upstream's
`@statewalker/utils` dependency was dropped; `recieveIterator` is built on the
local `newAsyncGenerator`. Upstream's four test files became six (34 tests).

The local code is a superset, not a transcription:

- `callPort` gained `AbortSignal` support and a port-close signal. Upstream
  hangs until its per-call timeout on a transport-level disconnect, and higher
  layers raise that timeout to roughly 24 days.
- `callPort` fixed an unhandled-rejection leak in its cleanup chain.
- `callBidi` cancels the inner iterator when the outer call rejects, so a
  failed call no longer hangs the consumer.
- `serializeError` fixed a real upstream bug: upstream writes
  `message: error`, assigning the `Error` object where `error.message` was
  intended.

**No porting work remains.** The rest of this document describes the work the
comparison actually surfaced.

## Finding 2 — three request/response RPC implementations

| # | implementation | package | mechanism |
| --- | --- | --- | --- |
| 1 | `callPort` / `listenPort` | `webrun-streams-port` | `callId` + `channelName` correlation on a shared port; timeout, `AbortSignal`, close-signal |
| 2 | `callChannel` / `handleChannelCalls` | `webrun-http-browser` (`src/core/data-calls.ts`) | a fresh `MessageChannel` per call, reply on `port1`; no timeout, no cancellation |
| 3 | `newRpcClient` / `newRpcServer` | `webrun-rpc-http` | service descriptors over `Request`/`Response` |

1 and 2 solve the same problem by different means, in the same repository, and
share the same `serializeError`/`deserializeError`. 3 is HTTP-shaped and stands
somewhat apart.

There are also two streaming tiers over a single `MessagePort`: the
`emulateMux` byte tier and the typed-value tier (`ioSend`/`ioHandle`,
`callBidi`/`listenBidi`). The `webrun-streams-port` README currently instructs
readers to "pick one per port", which documents the overlap rather than
resolving it.

## Finding 3 — the primitives are not generic

All fourteen signature sites in `webrun-streams-port` hardcode
`port: MessagePort`. The structural abstraction that would free them —
`MessageTarget` / `MessageSource` / `MessageSink` — already exists, but in
`webrun-http-browser/src/core/message-target.ts`, a layer *above*. That is why
implementation 2 above was born generic and implementation 1 was not: the
generic one was written in the layer that happened to hold the abstraction.

## Finding 4 — reflection over a class instance

The reference implementation in `statewalker-sandbox/packages/service-rpc`
builds its descriptor with `for (const fieldName in obj)`. Class prototype
methods are non-enumerable, so `for...in` over a class instance yields `[]`.
Verified:

```js
class MemFiles { async stats(p){} async *read(p){} async write(p,c){} }
const inst = new MemFiles();
[...(function*(){ for (const k in inst) yield k; })()]  // []
```

`FilesApi` implementations are classes (`MemFilesApi`), so that descriptor
generator cannot see them at all. The prototype walk in
`webrun-rpc-http/src/get-instance-methods.ts` — `Object.getOwnPropertyNames`
up the prototype chain, skipping `constructor` — returns
`["stats", "read", "write"]` and is the correct basis.

Separately, `service-rpc` classifies a method as streaming via
`fn instanceof AsyncGeneratorFunction`. `MemFilesApi` declares `async *read`
and `async *list`, so this happens to work today. But `FilesApi` promises
`AsyncIterable`, not `AsyncGenerator`: a backend returning an iterable from a
plain `async` method would be misclassified as unary, and only at runtime, only
on that backend. See Decision 1 for how this is handled.

`service-rpc` does already cover all four call shapes, including
client-streaming detected at runtime with `isAsyncIterable(arg)`. That shape
matters here, because `FilesApi.write(path, content: AsyncIterable)` is a
streaming *argument* — the shape most RPC layers omit.

## Finding 5 — both streaming tiers are stop-and-wait

This is the most consequential finding, and it corrects an assumption made
earlier in the design discussion.

`emulateMux`'s outbound pump sends one ≤MTU frame and then awaits its ACK
before sending the next (`webrun-streams/src/emulate-mux.ts`, `pumpOutbound`).
The code states the design in its own comment:

> Flow control is the peer holding one in-flight DATA per stream and waiting
> for its ACK — voluntary, and a hostile peer simply does not.

`maxStreamBuffer` is a receiver-side guard against a flooding peer, not a send
window. The ACK is emitted only after the consumer drains the chunk, so the
round-trip includes consumer processing time.

The typed-value tier has the same shape at a different granularity.
`webrun-streams-port/src/send.ts` documents it directly: "one `callPort`
round-trip per chunk", with the loop strictly sequential.

So both tiers have an effective send window of **1** — `emulateMux` per ≤64 KiB
frame, the RPC tier per value. Within a single logical stream, throughput is
round-trip-bound. A 100 MB transfer at 64 KiB per round trip is roughly 1600
sequential round-trips; at 30 ms RTT that is about 48 seconds of latency alone.

One mitigation already exists: the window is 1 *per stream*, and `emulateMux`
permits up to 256 concurrent streams. Concurrent ranged reads therefore scale
today; a single sequential read does not.

## Decisions

Recorded with the reasoning that produced them.

### 1. Descriptors by pure reflection, corrected at call time

Method discovery is fully automatic — no declarations. The descriptor is built
by prototype walk (Finding 4), and shape is guessed with
`instanceof AsyncGeneratorFunction`.

The guess is then corrected at runtime by two checks, which close the
`AsyncIterable`-vs-`AsyncGenerator` gap without reintroducing declarations:

- **Client:** if any argument exposes `Symbol.asyncIterator`, use the
  streaming path. This is what carries `FilesApi.write`.
- **Server:** if a method classified `method` actually returns a value
  exposing `Symbol.asyncIterator`, switch that call to the streaming path.

Reflection becomes a fast path rather than a contract, so a misclassification
degrades to a slower path rather than to a failure.

*Known limit:* a method added to the service after descriptor exchange is
invisible to the client. Acceptable for a fixed interface such as `FilesApi`.

### 2. No comlink

`service-rpc` uses comlink; `webrun-rpc` will not. The webrun-wire packages
carry essentially no runtime dependencies, `callPort`/`listenPort` already
perform comlink's request/response role with timeout, `AbortSignal` and
close-signal handling that comlink lacks, and `service-rpc` had already
disabled comlink's `AsyncGenerator` transfer handler for WebSocket
compatibility — routing all streaming through its own protocol instead, which
left comlink earning little.

### 3. `MessageTarget` lives in `webrun-streams-port`

Not promoted into `webrun-streams`. ADR-0004 establishes `Duplex` as the seam
of the byte-oriented foundation; adding a structured-clone message seam beside
it would put two different seams in one package. `MessageTarget` is a port
abstraction and belongs in the port package.

`webrun-http-browser` imports it from there instead of declaring its own copy.
This adds a `webrun-http-browser -> webrun-streams-port` dependency, which is
acyclic.

### 4. Flow control is fixed once, and shared

Rather than adding a send window to the RPC tier alone — which would create the
second flow-control implementation this investigation set out to avoid — the
windowing logic is extracted into `webrun-streams` and used by both
`emulateMux` and the RPC tier's `send`/`recieve`.

The change is a generalisation from a window of 1 to a window of N, with
in-order reassembly, bounded by the existing `maxStreamBuffer`. It
**preserves** end-to-end backpressure: ACK-after-drain still means a producer
cannot outrun its consumer; the window grants N units of slack instead of 1.
Defaulting N to 1 makes the first landing a strictly behaviour-preserving
refactor.

Ordering is carried differently in each tier, because each already has an
identifier to extend:

- `emulateMux` frames are already per-stream and arrive in transport order on a
  single channel, so a monotonic per-stream sequence number added to the DATA
  and ACK frames is sufficient to match an ACK to its frame once more than one
  is outstanding.
- The RPC tier correlates by `callId`, which is already unique per chunk
  because each chunk is its own `callPort` call. With a window greater than 1
  those calls may resolve out of order, so `recieve` buffers by an added
  per-channel sequence number and delivers in order.

The shared core owns the window accounting — how many units may be outstanding,
when a unit is released, and how a drained consumer returns credit. Each tier
supplies its own framing and its own transmit/acknowledge callbacks.

### 5. `webrun-rpc-http` is untouched

Whether it can become a transport binding of `webrun-rpc` is deferred until the
core exists and the shared abstraction has proven itself.

## Design

### Layering

```
webrun-streams        newAsyncGenerator, sendIterator/recieveIterator,
                      IteratorChunk, serializeError/deserializeError,
                      emulateMux, windowed flow-control core   [new]
      ▲
webrun-streams-port   MessageTarget/MessageSource/MessageSink  [moved in]
                      callPort/listenPort, callBidi/listenBidi,
                      ioSend/ioHandle, send/recieve
                      retyped MessagePort -> MessageTarget
      ▲
webrun-rpc            descriptor + automatic stub generation   [new]
```

### Public API

```ts
exposeService<T extends object>(target: MessageTarget, service: T): () => void;
newServiceClient<T extends object>(target: MessageTarget): Promise<Remote<T>>;
```

`Remote<T>` maps each method of `T`: a method returning `R` becomes one
returning `Promise<Awaited<R>>`, and a method returning `AsyncIterable<R>`
keeps that return type. Argument types are preserved.

The descriptor is pushed by the server as its first message on `exposeService`,
and `newServiceClient` resolves once it arrives. Pushing rather than requesting
avoids a round-trip and a race where the client asks before the server is
listening. `newServiceClient` therefore does not resolve until a server is
present; callers that need a bounded wait pass an `AbortSignal` through to the
underlying `callPort`. Nested plain objects recurse, producing a nested
`Remote`.

Call routing:

| shape | primitive |
| --- | --- |
| unary, no streaming arguments | `callPort` / `listenPort` |
| any streaming — in, out, or both | `callBidi` / `listenBidi` |

No new wire protocol is introduced; both primitives already exist, are
hardened, and are covered by tests.

### `FilesApi` over the generic stub

`FilesApi` needs no bespoke remote protocol:

```ts
const stop  = exposeService(port, memFiles);
const files = await newServiceClient<FilesApi>(port);

await files.write("/a.txt", chunks);
for await (const chunk of files.read("/a.txt", { start: 0, length: 100 })) {
  // ...
}
```

`read` and `list` are `async *` and classify as streams. `write` takes an
`AsyncIterable` and is caught by the client-side runtime check. The remaining
six methods are unary. A remote `FilesApi` package therefore reduces to wiring
over the generic stub rather than a hand-written protocol.

## Sequencing

Each step leaves the repository green and is independently revertable.

1. **Windowed flow-control core** in `webrun-streams`; `emulateMux` migrated
   onto it with the window defaulting to 1 (no behaviour change).
2. **`MessageTarget` consolidated** into `webrun-streams-port`;
   `webrun-http-browser` imports it rather than declaring it; the fourteen
   `MessagePort` signature sites retype to `MessageTarget`.
3. **RPC tier onto the shared window**, so `send`/`recieve` gain the same
   slack.
4. **`webrun-rpc`** — descriptor, `Proxy` client, server dispatcher.
5. **Remote `FilesApi`** as wiring over the stub.

`callChannel`/`handleChannelCalls` becomes a candidate to collapse onto
`callPort`/`listenPort` after step 2, subject to a behaviour-parity check:
it uses channel-per-call rather than `callId` correlation and has no timeout,
so the two are not drop-in equivalents.

Steps 1–3 (flow control and the `MessageTarget` consolidation) and steps 4–5
(`webrun-rpc` and remote `FilesApi`) form two natural implementation plans.
The first is a refactor of existing, tested behaviour; the second is new
surface built on top. They can be planned and reviewed separately, and the
first is worth landing on its own regardless of whether `webrun-rpc` proceeds —
single-stream throughput is a standing limitation of every adapter today.

## Verification

The flow-control change touches `emulateMux`, on which every transport adapter
depends. `webrun-streams-conformance` already defines L0–L5 as the shared
contract, run by six adapters — `-ws`, `-port`, `-webrtc`, `-peerjs`,
`-libp2p`, `-livekit` — plus the reference `makeLoopbackPair` self-test. Window
coverage is added there: the change is then proven against every transport at
once, and a regression surfaces in the adapter that broke rather than in a
single unit test.

Note that three of those runs are gated and will not exercise the change in a
plain `pnpm test`: `-webrtc` and `-peerjs` are browser-only, `-livekit`
additionally needs a running server, and `-libp2p`'s conformance run is opt-in
behind `WEBRUN_STREAMS_LIBP2P=1`. The ungated Node coverage is `-ws`, `-port`
and the loopback. The gated suites must be run deliberately before this change
lands.

Specifically:

- Conformance gains coverage for a window greater than 1, keeping the existing
  L0–L5 assertions intact (body sizes to 10 MiB, concurrency, half-close,
  mid-stream cancellation, error propagation, idempotent teardown).
- Backpressure remains asserted: a producer must not outrun a non-draining
  consumer, and `maxStreamBuffer` must still tear down the offending stream
  rather than the whole mux.
- `webrun-rpc` gets its own tests for descriptor generation over class
  instances, over nested objects, and for each of the four call shapes.

## Consequences

- One flow-control implementation instead of two, and single-stream throughput
  stops being round-trip-bound.
- The port primitives become transport-agnostic, so `webrun-rpc` works over
  `MessagePort`, `Worker`, `SharedWorker` and ServiceWorker bridges, and over
  anything adapted to `MessageTarget`.
- One fewer duplicated abstraction (`MessageTarget`), and a route to removing
  one of the three RPC implementations.
- `webrun-http-browser` gains a dependency on `webrun-streams-port`.
- A remote `FilesApi` costs wiring rather than a protocol.

## Out of scope

- Consolidating `webrun-rpc-http` (Decision 5).
- Reaching byte transports — WebSocket, WebRTC, libp2p, LiveKit — from
  `webrun-rpc`. That needs a `MessageTarget` synthesised over a `ByteChannel`
  with a codec, for which `webrun-msgpack` is the natural fit. Deliberately
  deferred: it is only worth designing once the windowed flow control makes
  network use viable.
- Moving `webrun-site-*` out of webrun-wire, tracked separately.
