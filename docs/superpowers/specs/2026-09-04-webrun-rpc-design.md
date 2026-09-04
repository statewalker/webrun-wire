# `webrun-rpc` — automatic client/server stubs over any transport

Date: 2026-09-04
Status: Draft — awaiting review
Supersedes: the 2026-09-04 first draft of this file, which scoped RPC to
`MessagePort` and placed `MessageTarget` in `webrun-streams-port`. Both are
reversed here; see Decisions 3 and 7.

## Origin

The request was: port <https://github.com/statewalker-attik/webrun-ports> into
webrun-wire as a `webrun-rpc` package, convert it to TypeScript, check for
functional duplication with the other packages, and use the result to build
generic client/server adapters with `FilesApi` on top.

Investigation showed the port is already complete. What follows is the work the
comparison surfaced instead.

## Requirements

1. **Automatic client/server stub generation.** Given an object, expose it; given
   a connection, get a typed client. No hand-written protocol per service.
2. **Works over binary transports, not only `MessagePort`.** WebSocket, WebRTC,
   libp2p and LiveKit are in scope, not deferred. This is a first-class
   requirement, not a later extension.
3. **Carries `FilesApi`.** Including `read`/`list` returning `AsyncIterable`,
   and `write` *taking* one — a streaming argument.
4. **No functional duplication** with the existing packages.
5. **Built red/green TDD.** Every behavioural change lands as a failing test
   first, then the code that makes it pass. This is existing house practice —
   `webrun-streams-signaling`'s README records "Built red/green TDD" — and it
   matters more than usual here: Plan 1 rewrites flow control that six adapters
   depend on, and the interesting cases (a stalled consumer, a peer that ignores
   credit, asymmetrically configured peers) are exactly the ones that are easy
   to believe are handled without ever having watched them fail.

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
`webrun-streams` — correctly, since none of them mention a port. Upstream's
`@statewalker/utils` dependency was dropped; `recieveIterator` is built on the
local `newAsyncGenerator`. Upstream's four test files became six (34 tests).

The local code is a superset, not a transcription:

- `callPort` gained `AbortSignal` support and a port-close signal. Upstream
  hangs until its per-call timeout on a transport-level disconnect, and
  `call-port.ts:49` notes that higher layers raise that timeout to ~24 days
  (`2147483647` ms).
- `callPort` fixed an unhandled-rejection leak in its cleanup chain.
- `callBidi` cancels the inner iterator when the outer call rejects.
- `serializeError` fixed a real upstream bug: upstream writes `message: error`,
  assigning the `Error` object where `error.message` was intended.

**No porting work remains.**

## Finding 2 — four request/response implementations

| # | implementation | location | mechanism |
| --- | --- | --- | --- |
| 1 | `callPort` / `listenPort` | `webrun-streams-port` | `callId` + `channelName` correlation; timeout, `AbortSignal`, close-signal |
| 2 | `callChannel` / `handleChannelCalls` | `webrun-http-browser/src/core/data-calls.ts` | fresh `MessageChannel` per call, reply on `port1`; no timeout, no cancellation |
| 3 | `newRpcClient` / `newRpcServer` | `webrun-rpc-http` | service descriptors over `Request`/`Response` |
| 4 | vendored `call-port.ts` etc. | `webrun-vcs/packages/utils/src/ports/` | a second copy of 1, unhardened |

Copy 4 is 632 LOC across twelve files. It lacks the hardening of 1 — no
`AbortSignal` in `call-port.ts`, no `close-signal.ts` — and it spells the
function `receive` where webrun-wire spells it `recieve`. It is **not exported**
from `webrun-vcs/packages/utils/src/index.ts` (the `@statewalker/vcs-utils`
package), and nothing outside `src/ports/` imports it; only its own test file
does. It is dead code, removable by deletion.

There are also two streaming tiers over one `MessagePort`: the `emulateMux`
byte tier and the typed-value tier. The `webrun-streams-port` README instructs
readers to "pick one per port", which documents the overlap rather than
resolving it.

## Finding 3 — no consumers, so no back-compat burden

No `package.json` in the assembly depends on `@statewalker/webrun-streams-port`
other than the package itself. Combined with copy 4 being dead code, the typed
RPC tier has **zero production consumers anywhere**.

This materially lowers the risk of every decision below: the tier can be moved,
renamed and restructured without a migration.

## Finding 4 — the RPC tier never transfers ports

Every `postMessage` in the RPC tier sends a plain object with **no transfer
list**:

```js
port.postMessage({ type: "request", channelName, callId, params });   // call-port.ts
port.postMessage({ callId, channelName, type, result, error });        // listen-port.ts
port.postMessage({ type: CANCEL_CHANNEL_TYPE, channelName });          // cancel-channel.ts
```

This is what makes Requirement 2 achievable. A protocol that transferred
`MessagePort`s could not cross a byte transport at all; this one can, given a
codec.

The only `MessagePort`-specific machinery in the tier is `close-signal.ts`, a
`WeakMap<MessagePort, AbortSignal>` that needs rekeying to `MessageTarget`.
`byte-channel.ts` and `connect-serve.ts` do need a real `MessagePort`, but they
belong to the Duplex tier, not the RPC tier.

Note that `port: MessagePort` appears at 14 signature sites, while `MessagePort`
appears 25 times in total — the retyping is larger than the signature count
alone suggests.

## Finding 5 — `Duplex`, not `ByteChannel`, is the universal seam

| adapter | exposes `byteChannelFrom*` | exposes `connect()` → `Duplex` |
| --- | --- | --- |
| `-ws`, `-port`, `-livekit`, `-peerjs` | yes | yes |
| `-webrtc`, `-libp2p` | **no** | yes |

The two natively-multiplexed transports expose no `ByteChannel`. A bridge built
on `ByteChannel` would reach four of six adapters and miss exactly the two
peer-to-peer ones. The bridge must therefore take a `Duplex`.

## Finding 6 — reflection over a class instance

`statewalker-sandbox/packages/service-rpc` builds its descriptor with
`for (const fieldName in obj)`. Class prototype methods are non-enumerable, so
`for...in` over a class instance yields `[]`. Verified:

```js
class MemFiles { async stats(p){} async *read(p){} async write(p,c){} }
const inst = new MemFiles();
[...(function*(){ for (const k in inst) yield k; })()]  // []
```

`FilesApi` implementations are classes (`MemFilesApi`), so that generator cannot
see them at all. The prototype walk in
`webrun-rpc-http/src/get-instance-methods.ts` — `Object.getOwnPropertyNames` up
the chain, skipping `constructor` — returns `["stats", "read", "write"]` and is
the correct basis.

`service-rpc` classifies streams via `fn instanceof AsyncGeneratorFunction`.
`MemFilesApi` declares `async *read` and `async *list`, so this works today. But
`FilesApi` promises `AsyncIterable`, not `AsyncGenerator`: a backend returning
an iterable from a plain `async` method would be misclassified. See Decision 1.

`service-rpc` does already cover all four call shapes, including
client-streaming detected at runtime with `isAsyncIterable(arg)` — the shape
`FilesApi.write` needs.

## Finding 7 — both streaming tiers are stop-and-wait

`emulateMux`'s outbound pump sends one ≤MTU frame and awaits its ACK before
sending the next (`webrun-streams/src/emulate-mux.ts`, `pumpOutbound`). Its own
comment states the design:

> Flow control is the peer holding one in-flight DATA per stream and waiting
> for its ACK — voluntary, and a hostile peer simply does not.

`maxStreamBuffer` is a receiver-side guard against a flooding peer, not a send
window. The ACK is emitted only after the consumer drains, so the round trip
includes consumer processing.

The typed tier has the same shape at a different granularity;
`webrun-streams-port/src/send.ts` documents "one `callPort` round-trip per
chunk", with a strictly sequential loop.

Both tiers therefore have an effective send window of **1** — `emulateMux` per
≤64 KiB frame, the RPC tier per value. Within one logical stream, throughput is
round-trip-bound: 100 MB at 64 KiB per round trip is ~1600 sequential round
trips, about 48 seconds of pure latency at 30 ms RTT.

One mitigation exists: the window is 1 *per stream*, and `DEFAULT_MAX_STREAMS`
is 256, so concurrent ranged reads already scale. A single sequential read does
not.

**Nothing is negotiated between peers.** `sendFrame(id, TYPE_OPEN)` carries no
payload; `mtu`, `maxStreamBuffer` and `maxStreams` are purely local
configuration and are never communicated. Each peer therefore has no idea what
the other's limits are. This is what rules out a sender-side window (Decision 8)
and it is why `OPEN` has to start carrying something under any design that
allows more than one frame in flight.

The reason the cap is needed at all is documented in the same code: the inbound
loop **cannot** block on consumer drainage, because it would then be unable to
process incoming `ACK` frames — and since our own sender is parked awaiting
exactly those ACKs, both directions deadlock. Pushes are therefore
fire-and-forget, which removes the natural brake and makes the cap the only
bound on a peer that ignores the ACK convention.

## Decisions

### 1. Descriptors by pure reflection, corrected at call time

Method discovery is fully automatic. The descriptor is built by prototype walk
(Finding 6); shape is guessed with `instanceof AsyncGeneratorFunction`.

The guess is corrected at runtime by two checks, closing the
`AsyncIterable`-vs-`AsyncGenerator` gap without reintroducing declarations:

- **Client:** if any argument exposes `Symbol.asyncIterator`, use the streaming
  path. This carries `FilesApi.write`.
- **Server:** if a method classified `method` actually returns a value exposing
  `Symbol.asyncIterator`, switch that call to the streaming path.

Reflection is a fast path, not a contract, so a misclassification degrades to a
slower path rather than a failure.

*Known limit:* a method added after descriptor exchange is invisible to the
client. Acceptable for a fixed interface such as `FilesApi`.

### 2. Value contract: msgpack-serialisable, on every transport

Arguments and results must be msgpack-serialisable: plain values plus
`Uint8Array`. **Not** supported, on any transport, including `MessagePort`
where the platform would allow them:

- `Map`, `Set`, `Date`, `RegExp`, cyclic references;
- transferables (`ArrayBuffer` transfer, port passing);
- object aliasing — `{a: x, b: x}` may arrive with `a !== b`.

The contract is deliberately the *narrower* of the two transports' capabilities
so that a service behaves identically over a port and over a socket. The
alternative — letting each transport carry what it natively can — permits a
service to work locally and corrupt data remotely, with the failure appearing
only when someone changes transport.

### 3. Encoding is per-transport; conformance runs both

Structured clone over a `MessageTarget` that is a real `MessagePort` — no
encode, no copy, `Uint8Array` passes natively. Msgpack only where bytes are
required.

The testing gap this creates (a `MessageChannel` test never exercises the
codec) is closed by Decision 9: RPC conformance runs over both a
`MessageChannel` **and** a msgpack-over-`Duplex` pair, so the codec is
exercised on every CI run.

### 4. No comlink

`service-rpc` uses comlink; `webrun-rpc` will not. The webrun-wire packages
carry essentially no runtime dependencies; `call`/`listen` already perform
comlink's request/response role with timeout, `AbortSignal` and close-signal
handling that comlink lacks; and `service-rpc` had already disabled comlink's
`AsyncGenerator` transfer handler for WebSocket compatibility, routing all
streaming through its own protocol — leaving comlink earning little.

### 5. Codec fixed to msgpack

`messageTargetFromDuplex(call)` takes no codec parameter. A plug point would
undermine Decision 2: JSON cannot carry `Uint8Array` without base64 inflation,
and `FilesApi` depends on that type more than any other. `webrun-msgpack`
already exists, has one dependency, and its 4-byte big-endian length prefix
makes the bridge transport-independent — `decodeMsgpack` reassembles across
chunk boundaries, so the same bridge works over a message-preserving WebSocket
and a boundary-free libp2p stream alike.

Pluggability can be added later if a real need appears; removing it cannot.

### 6. One `Duplex` stream per RPC session

`messageTargetFromDuplex(call)` opens a single bidirectional byte stream and
carries the whole session over it. RPC correlates concurrent calls itself, via
`callId` and `channelName`, exactly as it already does over a `MessagePort`.

Rejected alternative: one transport stream per call. It would use the
transport's native multiplexing, but it requires a `Connect` rather than a
`Duplex`, does not map onto `MessageTarget` at all — so the port and binary
paths would diverge into two designs — and it inherits the 256-stream cap.

Since the session rides one stream, single-stream throughput is what matters,
which is why Decision 8 is load-bearing rather than an optimisation.

### 7. The RPC tier moves to `webrun-rpc`; `MessageTarget` to `webrun-streams`

The typed RPC tier leaves `webrun-streams-port`, which becomes a pure transport
adapter (`byteChannelFromMessagePort`, `connect`/`serve`) consistent with its
siblings. This resolves the "two tiers in one package, pick one" overlap, and
stops binary-transport users depending on the `MessagePort` adapter.

`MessageTarget` / `MessageSource` / `MessageSink` move from
`webrun-http-browser/src/core/message-target.ts` **down into `webrun-streams`**,
where `webrun-rpc`, `webrun-http-browser` and `webrun-streams-port` can all use
them without depending on one another. It is a four-interface, zero-runtime-code
type module; it does not compete with `Duplex` as a transport seam, and
`webrun-streams` already holds non-`Duplex` utilities (jsonl, text, collectors,
`newAsyncGenerator`).

Finding 3 makes this free: there is nothing to migrate.

`MessagePort` is expected to satisfy `MessageTarget` structurally
(`postMessage`, `addEventListener`, `start`, `close`), so the port path should
need no adapter. To be confirmed when typing it; if the DOM overloads do not
line up, a thin `messageTargetFromMessagePort` is added.

### 8. Receiver-advertised credit, in one shared core

Rather than adding a send window to the RPC tier alone — which would create the
second flow-control implementation this investigation set out to avoid — the
flow-control logic is extracted into `webrun-streams` as a unit-agnostic core
that serves both `emulateMux` and the RPC tier.

**When each consumer is credited (amended 2026-09-04).** Plan 1 builds the core,
proves it against `emulateMux`, and exports it. The RPC tier is credited in
Plan 2, when it moves to `webrun-rpc` (Sequencing step 3) — not before. Two
independent measurements against a draft that migrated the tier in place found
that it removes **no** round trip (41 requests / 41 responses on both the old
and the new implementation, because `listenPort` replies unconditionally) and
that pipelining converts `callPort`'s 1000 ms *per-value* timeout into a
deadline for the whole window (40 values: 34/40 delivered at 60 ms per value,
26/40 at 80 ms, against 40/40 for the code as it stands). Since the tier is
moving to a new package regardless, it is credited once, against its final
shape, with that timeout question resolved there. The consequence to accept is
that the core's exported surface is frozen in Plan 1 having been proven against
one consumer; it is designed for both, and Plan 2 is where the second one tests
the shape.

**The mechanism is receiver-advertised credit, not a sender-side window.**

A sender-side window was considered and rejected. It requires the sender to
stay under the *receiver's* `maxStreamBuffer`, but that value is private
(Finding 7): `OPEN` carries no payload, so nothing is negotiated. A local
`window × mtu ≤ maxStreamBuffer` check compares a peer's own window against its
own buffer, while the frames land in the *other* peer's buffer — so two peers
on different configuration, or different defaults across versions, both pass
their local checks and still get streams torn down. It encodes a same-defaults
convention as if it were a guarantee.

Credit-based flow control removes the constraint instead of encoding it:

- The receiver advertises initial credit — naturally its `maxStreamBuffer`.
- The sender decrements credit by bytes sent and stops at zero.
- The receiver grants further credit as its consumer drains.

A sender then **cannot** overrun the receiver's buffer, because it was never
given permission to. `maxStreamBuffer` stops being a kill threshold for honest
peers and becomes the advertised window; the teardown path survives only as a
backstop against peers that ignore the protocol, which is what it was written
for.

**No new frame type is needed.** The two existing frames gain a 4-byte payload:

| frame | today | becomes |
| --- | --- | --- |
| `OPEN` (`0x01`) | empty | initial credit, uint32 big-endian |
| `ACK` (`0x03`) | bare signal | bytes granted, uint32 big-endian |

Two properties fall out rather than being designed in:

1. **Throughput is fixed by the same change.** Credit is cumulative bytes, not
   one-frame-at-a-time, so the per-frame round trip disappears — which was the
   whole objective.
2. **Auto-tuning becomes the receiver's business.** A receiver whose consumer is
   slow simply grants less. No negotiation protocol, no tuning knob to expose.

**Backpressure is preserved, at coarser granularity.** The end-to-end signal is
unchanged — `newAsyncGenerator`'s `next()` resolves only when the consumer pulls
again, and credit is granted from that signal. The difference is that a producer
may now run up to one credit window ahead of its consumer instead of exactly
zero. Bounded, still end-to-end, still no unbounded buffering.

**Grant policy:** credit is replenished in batches — when roughly half the
advertised window has been drained, **or when the receive queue empties below
that threshold, so the receiver never sits on credit it owes**.

Batching is what stops a grant per chunk *while the sender is stalled*, which is
the case that would otherwise reinvent the per-frame ACK. The empty-queue flush
costs an extra frame only when the consumer is keeping pace and the sender is
therefore not blocked — and without it a stream whose remaining traffic never
reaches the threshold can sit on credit indefinitely. This clause was added
after the first draft: the plan-level review found the batching rule alone
admitted that stall.

The shared core owns credit accounting: how much is outstanding, when it is
consumed, when a grant is emitted. Each tier supplies its own framing and its
own transmit/grant callbacks. The RPC tier correlates by `callId` (already
unique per chunk); with more than one chunk in flight those calls may resolve
out of order, so `receiveValues` buffers by an added per-channel sequence
number and delivers in order.

### 9. Names corrected during the move

Finding 3 makes this the cheapest it will ever be, and carrying a misspelling
into a new package would cement it.

| today | becomes |
| --- | --- |
| `callPort` | `call` |
| `listenPort` | `listen` |
| `callBidi` | `callStream` |
| `listenBidi` | `listenStream` |
| `ioSend` | `exchange` |
| `ioHandle` | `handleExchange` |
| `send` / `recieve` | `sendValues` / `receiveValues` |
| `recieveIterator` (in `webrun-streams`) | `receiveIterator` |

No deprecated aliases: 0.x semver permits the break, and every consumer is in
this repository and updated in the same change. `@statewalker/webrun-streams` is
published (0.1.0, 0.1.1), so `receiveIterator` is a breaking rename of a
published symbol; its only importers are
`webrun-http-browser/src/core/data-channels.ts` and tests.

**Public surface of `webrun-rpc`** is limited to six exports: `call`, `listen`,
`callStream`, `listenStream`, `exposeService`, `newServiceClient`. `exchange`,
`handleExchange`, `sendValues` and `receiveValues` stay internal — `callStream`
already composes them. Every exported name is a compatibility commitment, and
internals must stay free to change while the windowed flow control settles.

### 10. `webrun-rpc-http` untouched

Whether it can become a transport binding of `webrun-rpc` is deferred until the
core exists.

## Design

### Layering

```
webrun-streams        newAsyncGenerator, sendIterator/receiveIterator,
                      IteratorChunk, serializeError/deserializeError,
                      emulateMux, credit-based flow-control core   [new]
                      MessageTarget/MessageSource/MessageSink  [moved in]
      ▲                                    ▲
      │                                    │
webrun-streams-port   webrun-msgpack   webrun-http-browser
(pure adapter)              ▲          (imports MessageTarget)
                            │
                        webrun-rpc
                        call/listen, callStream/listenStream,
                        exposeService/newServiceClient,
                        messageTargetFromDuplex
```

`webrun-rpc` depends on `webrun-streams` and `webrun-msgpack`. It does **not**
depend on `webrun-streams-port`.

### Public API

```ts
exposeService<T extends object>(target: MessageTarget, service: T): () => void;
newServiceClient<T extends object>(target: MessageTarget): Promise<Remote<T>>;

messageTargetFromDuplex(call: Duplex): MessageTarget;
```

`Remote<T>` maps each method of `T`: one returning `R` becomes one returning
`Promise<Awaited<R>>`; one returning `AsyncIterable<R>` keeps that return type.
Argument types are preserved.

The descriptor is pushed by the server as its first message on `exposeService`;
`newServiceClient` resolves once it arrives. Pushing rather than requesting
avoids a round trip and a race where the client asks before the server listens.
`newServiceClient` therefore does not resolve until a server is present;
callers needing a bounded wait pass an `AbortSignal` through to `call`. Nested
plain objects recurse, producing a nested `Remote`.

Call routing:

| shape | primitive |
| --- | --- |
| unary, no streaming arguments | `call` / `listen` |
| any streaming — in, out, or both | `callStream` / `listenStream` |

No new wire protocol is introduced.

### Reaching a binary transport

Every adapter's `connect()` yields `{ call: Duplex }` (Finding 5), so one
bridge covers all of them:

```ts
import { connect } from "@statewalker/webrun-streams-ws";
import { messageTargetFromDuplex, newServiceClient } from "@statewalker/webrun-rpc";

const { call } = await connect({ url: "wss://example.com/rpc" });
const files = await newServiceClient<FilesApi>(messageTargetFromDuplex(call));
```

Substituting `-webrtc`, `-libp2p`, `-livekit`, `-peerjs` or `-port` changes only
the import. Over a `MessagePort` the bridge is unnecessary — the port is passed
directly, and structured clone applies (Decision 3).

Internally the bridge pushes outbound values into a `newAsyncGenerator` queue
feeding `encodeMsgpack`, whose frames go to the `Duplex` input; inbound bytes
run through `decodeMsgpack` and dispatch to `"message"` listeners. `postMessage`
is already fire-and-forget, so the queue matches its semantics.

### `FilesApi` over the generic stub

`FilesApi` needs no bespoke remote protocol:

```ts
const stop  = exposeService(target, memFiles);
const files = await newServiceClient<FilesApi>(target);

await files.write("/a.txt", chunks);
for await (const chunk of files.read("/a.txt", { start: 0, length: 100 })) {
  // ...
}
```

`read` and `list` are `async *` and classify as streams. `write` takes an
`AsyncIterable` and is caught by the client-side runtime check (Decision 1). The
remaining six methods are unary. A remote `FilesApi` package reduces to wiring.

## Sequencing

Each step leaves the repository green and is independently revertable.

1. **Credit-based flow-control core** in `webrun-streams`, with `emulateMux`
   migrated onto it and the core exported for later consumers; `OPEN` and `ACK`
   gain their uint32 payloads. Conformance passing at a small advertised credit
   and at the default, and across asymmetrically configured peers. The RPC tier
   is **not** touched here — neither its flow control nor its move; see
   Decision 8's amendment for the measurements behind that.
2. **`MessageTarget` moves** into `webrun-streams`; `webrun-http-browser`
   imports it rather than declaring it.
3. **RPC tier moves** to `webrun-rpc`, retyped from `MessagePort` to
   `MessageTarget` (14 signature sites, 25 mentions), renamed per Decision 9,
   and put on the shared credit core — including the `callPort` timeout
   question that pipelining raises. `webrun-streams-port` is left as a pure
   adapter.
4. **`messageTargetFromDuplex`** with the msgpack bridge.
5. **`webrun-rpc` stub layer** — descriptor, `Proxy` client, server dispatcher.
6. **Remote `FilesApi`** as wiring over the stub.

Steps 1–2 and 3–6 form two natural implementation plans. The first is a
refactor of existing tested behaviour and is **worth landing on its own even if
`webrun-rpc` never proceeds** — single-stream throughput is a standing
limitation of every adapter today, not something this design introduces.

`callChannel`/`handleChannelCalls` becomes a candidate to collapse onto
`call`/`listen` after step 3, subject to a behaviour-parity check: it uses
channel-per-call rather than `callId` correlation and has no timeout, so they
are not drop-in equivalents.

## Verification

**Test-first, throughout.** Each behaviour below is written as a failing test
before the implementation that satisfies it, and the failure is observed — a
test that has never been red proves nothing about the code that follows it. For
the migration of `emulateMux` this also means the existing L0–L5 suite stays
green at every commit, since it is the regression net for six adapters.

The flow-control change touches `emulateMux`, on which **four** of the six
adapters depend: `-ws`, `-port`, `-peerjs` and `-livekit`. `-webrtc` carries
`duplexOverDataChannel` and `-libp2p` uses native yamux multiplexing (Finding
5); neither imports `emulateMux`, and neither has an `mtu` or a
`maxStreamBuffer` to vary. `webrun-streams-conformance` defines the shared
contract, run by all six adapters plus the reference `makeLoopbackPair`
self-test. Window coverage is added there, so for the four it proves the credit
path and for the other two — and for the loopback — it proves the `Duplex` seam
still holds. Varying the window from conformance therefore means widening four
public parameter types, not six.

- Conformance runs at a small advertised credit (several frames' worth, so the
  sender stalls and resumes repeatedly) and at the default, keeping the existing
  L0–L5 assertions intact (body sizes to 10 MiB, concurrency, half-close,
  mid-stream cancellation, error propagation, idempotent teardown). The exact
  one-frame lock-step case is pinned by `webrun-streams`' own unit tests rather
  than by conformance, which would otherwise run the whole L0–L5 set twice for a
  property the unit tests pin more precisely.
- Backpressure stays asserted, at its new granularity: a producer must stall
  once it has exhausted its credit against a non-draining consumer, and must
  resume when credit is granted. A producer must never exceed advertised
  credit.
- `maxStreamBuffer` must still tear down a stream from a peer that **ignores**
  credit and floods anyway — the guard's original purpose — while never firing
  for a peer that honours it, at any configuration.
- Peers configured asymmetrically (differing `maxStreamBuffer`) must interoperate
  without spurious teardown. This is the case the rejected sender-side window
  got wrong, so it is asserted explicitly — in `webrun-streams`' own tests. It
  is **not** asserted in conformance: `PairTuning` is one object spread into both
  ends of a pair, so the suite cannot give the two peers different windows.
  Reshaping it to `{ initiator?, responder? }` is deferred to Plan 2.
- **`webrun-rpc` conformance runs over two transports** — a `MessageChannel`
  (structured clone) and a msgpack-over-`Duplex` pair — so Decision 3's
  divergence risk is covered in CI. A value-contract test asserts that
  `Map`/`Set`/`Date`/cycles are rejected on *both*, not silently accepted on the
  port path.
- `webrun-rpc` unit tests cover descriptor generation over class instances and
  nested objects, and each of the four call shapes.

**Gating caveat:** four of the six adapter runs do not exercise the change in a
plain `pnpm test`. `-webrtc` and `-peerjs` are browser-only, `-livekit`
additionally needs a running server, and `-libp2p`'s conformance run is opt-in
behind `WEBRUN_STREAMS_LIBP2P=1`. Ungated Node coverage is `-ws`, `-port` and
the loopback — which, since `-webrtc` and `-libp2p` do not use `emulateMux` at
all, means ungated coverage of the **credit path** is `-ws` and `-port`, and the
gated suites that would add to it are `-peerjs` and `-livekit`.

Of those, `-libp2p`'s gate works: `WEBRUN_STREAMS_LIBP2P=1 pnpm --filter
@statewalker/webrun-streams-libp2p test` runs and passes. The three browser
suites do **not** run today, and not because of their gate: their `test:browser`
scripts name a `vitest.browser.config.ts` that does not exist, and each of their
conformance files imports a `tests/make-<transport>-pair.ts` helper that does not
exist either. Plan 1 creates the configs; writing the pair helpers is separate
work. **Until it is done, `-webrtc`, `-peerjs` and `-livekit` have no executable
conformance run at all** — a statement earlier drafts of this section got wrong
in the other direction.

## Consequences

- One flow-control implementation instead of two, and single-stream throughput
  stops being round-trip-bound for every adapter.
- A sender can no longer overrun a receiver's buffer by construction, so
  `maxStreamBuffer` reverts to being purely a defence against peers that ignore
  the protocol. Peers on differing configuration interoperate.
- **Breaking wire format:** `OPEN` and `ACK` gain uint32 payloads. Old and new
  peers cannot interoperate. Finding 3 makes this the cheapest it will ever
  be.
- RPC works over every transport in the family, meeting Requirement 2.
- Two of the four request/response implementations are removed or made
  removable: copy 4 by deletion, copy 2 as a follow-up parity check.
- `MessageTarget` has one home.
- `webrun-streams-port` becomes a pure adapter, consistent with its siblings.
- A remote `FilesApi` costs wiring rather than a protocol.
- **Breaking:** `recieveIterator` → `receiveIterator` in the published
  `webrun-streams`, and the renames of Decision 9. All consumers are in-repo.
- `webrun-rpc` takes a dependency on `webrun-msgpack`.

## Follow-ups, not in this spec

- Deleting `webrun-vcs/packages/utils/src/ports/` and its tests (Finding 2).
  Different repository; dead code, so a deletion rather than a migration.
- Consolidating `webrun-rpc-http` (Decision 10).
- Collapsing `callChannel`/`handleChannelCalls` onto `call`/`listen`.
- Moving `webrun-site-*` out of webrun-wire — tracked separately.
