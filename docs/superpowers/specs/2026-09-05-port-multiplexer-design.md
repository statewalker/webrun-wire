# Port multiplexer design

**Status:** ratified in conversation, not yet planned
**Date:** 2026-09-05
**Supersedes:** the multiplexing half of `docs/superpowers/specs/2026-09-04-webrun-rpc-design.md`
Decision 8, and most of `docs/superpowers/plans/2026-09-04-credit-flow-control.md` (see
[What this deletes](#what-this-deletes)).

---

## The goal

**An isomorphic, protocol-independent communication layer.** The same stream and call semantics
over a worker `MessagePort`, a WebSocket, a WebRTC DataChannel, a libp2p stream or a LiveKit room,
with code above the seam that cannot tell which it is running on.

Every decision below is downstream of that. Where a transport offers a capability others lack, this
design takes it as a *performance* opportunity and never as a semantic one — otherwise code written
against the fast transport silently fails on the others, which is the failure isomorphism exists to
prevent.

---

## The problem

`packages/webrun-streams/src/emulate-mux.ts` is 572 lines in a single closure. It owns, at once:
frame encoding, stream-id allocation, the stream table, per-stream outbound scheduling, credit
flow control, handler lifecycle, half-close, error serialisation and teardown. Four adapters
embed it.

That concentration is not a style complaint. During the credit-flow-control work four defects were
found in adapters whose test suites had never executed, and every one of them lived in exactly this
kind of undifferentiated scope — a deadlock between an outbound pump and a handler's input, a
cancellation signal that was never sent, a suite-registration bug, and an MTU larger than the
transport could carry. Code that mixes five concerns hides bugs in the seams between them.

Underneath that is a structural problem: **the repository contains three separate multiplexers.**

| multiplexer | where | addresses streams by |
| --- | --- | --- |
| `emulateMux` | `webrun-streams/src/emulate-mux.ts` | varint stream id, over bytes |
| `callBidi` | `webrun-streams-port/src/call-bidi.ts` | `channelName` string, over one `MessagePort` |
| the platform's own | `MessagePort` transfer | not used for streams at all |

`webrun-streams-port` demonstrates the cost. `byteChannelFromMessagePort` flattens a `MessagePort`
to a byte pipe — its own doc says *"this adapter assumes the port carries only byte payloads"* —
discarding structured clone and port transfer, and then runs all 572 lines of `emulateMux` on top to
rebuild multiplexing the platform already provides.

Meanwhile the two adapters that never adopted `emulateMux` are the two that already had native
per-call channels: `-webrtc` opens an `RTCDataChannel` per call, `-libp2p` uses yamux. So of six
adapters, only **two** — `-ws` and `-livekit` — genuinely require an emulated multiplexer, and
`-peerjs` requires one only because opening a `DataConnection` per call is heavier than muxing.

---

## Findings

Each was established from the code or measured during the credit-flow-control work, not assumed.

**F1. `MessagePort` satisfies `MessageTarget` structurally, with zero diagnostics.** Verified in
commit `5dd9704` (Task 6 of the credit plan) and independently re-verified by its reviewer. The
open question in the RPC spec's Decision 7 — whether a `messageTargetFromMessagePort` adapter would
be needed — is answered: it is not. `MessageTarget` is therefore usable as the universal port
interface without wrapping the platform type.

**F2. Port-per-call already exists in this repository.** `webrun-http-browser/src/core/data-calls.ts`
`callChannel` creates a `MessageChannel` and transfers `port2` alongside the request. The mechanism
is in production one package away from the streams stack.

**F3. Layer 2 already exists, misplaced.** `webrun-streams-port` exports `callPort`, `listenPort`,
`callBidi`, `listenBidi`, `ioSend`, `ioHandle`, `send`, `recieve` — its barrel records them as
*"moved here from the deleted `webrun-ports` package"*. These are transport-agnostic stream and call
primitives living inside a transport adapter and typed against `MessagePort`, which is the only
reason they work on one transport.

**F4. `send` already implements ack-based backpressure.** It is `sendIterator` plus one `callPort`
round trip per chunk, and the reply is withheld until the consumer pulls past the value. The round
trip *is* the acknowledgement. This is the mechanism this design keeps.

**F5. That acknowledgement is on a 1000 ms timer, which conflates "slow" with "dead".**
`callPort`'s `timeout` defaults to 1000 ms. Because the reply is withheld until consumption, any
consumer slower than one second per value receives `Error: Call timeout` rather than backpressure.
Measured from the other direction during the credit work: pipelining the same calls converted the
per-value timeout into a deadline for the whole window — **34 of 40 values delivered at 60 ms per
value, 26 of 40 at 80 ms**, each truncating with `Error: Call timeout`, where the non-pipelined
code delivered 40/40.

**F6. Liveness detection independent of timers already exists.** `getPortCloseSignal` /
`setPortCloseSignal` in `webrun-streams-port/src/close-signal.ts` combine a pending call with the
port's transport-close signal, so a dead transport rejects immediately rather than waiting out the
timeout.

**F7. `newAsyncGenerator`'s `next()` returns `Promise<boolean>` that resolves only after the
consumer has processed the value.** Its own documentation states this. It is the acknowledgement
primitive a port-level stream needs, and it is already in `webrun-streams`.

**F8. Conformance is a working regression net, and it now runs in browsers.** `describeDuplexAdapter`
asserts L0–L6 against any `ConnectServePair`. As of the credit work: Node 683 passing / 5 skipped;
`-webrtc`, `-peerjs` and `-livekit` each 11/11 in chromium against, respectively, an in-page
`RTCPeerConnection` pair, a loopback PeerJS broker and a real `livekit-server`.

---

## Decisions

Ratified in conversation on 2026-09-05.

**D1. Everything in the stack is a port.** The universal interface is `MessageTarget` from
`@statewalker/webrun-streams` — `addEventListener("message")`, `removeEventListener`, optional
`start()`, `postMessage(message, transfer?)`, optional `close()`.

**D2. The multiplexer is a port transformer: one port in, many ports out.** Not
channel-to-ports. This makes it composable: a multiplexer over a virtual port yields further
virtual ports with no special case.

`PortMux` is an **interface**, and `openPort` **is a port factory** — the same concept a natively
multiplexed transport already provides. `webrun-rpc` ships the default implementation, which
emulates multiplexing over a single port; `-libp2p` and `-webrtc` are factories natively, from
`dialProtocol` and `createDataChannel`. Emulation happens only where the transport genuinely offers
one pipe, and no adapter imports anything from this repository to say so (see Layer 3).

**`openPort` is asynchronous**: `(meta?) => Promise<MessageTarget>`. A native factory cannot be
synchronous — `createDataChannel` needs a wait-for-open and `dialProtocol` is async — and the two
are only interchangeable if they share a shape. The emulated implementation returns an
already-resolved promise, so it still costs no round trip (D5's send-before-accept still holds).

**D3. A port sends and receives messages. Nothing else.** No confirmation, no backpressure, no
credit, no flow control, and no buffering ceiling at layer 1. This matches `MessagePort` semantics
exactly. Backpressure and waiting strategies belong above.

`maxPorts` is not an exception to this. It bounds the size of the id table — a structural resource,
the analogue of today's `maxStreams` — and never inspects, counts or delays a payload. Layer 1 may
refuse to *create* a port; it may never hold back a message on one that exists.

**D4. Port lifecycle is explicit.** `OPEN` and `CLOSE` control messages, with an accept callback on
the receiving side. A rejected port's subsequent messages are dropped.

**D5. Unaccepted and unread ports drop, never queue.** This is the invariant that keeps layer 1
memory-safe without giving it flow control: layer 1 never holds data on behalf of a consumer that
does not exist. It is load-bearing and must be tested, not merely documented.

**D6. The codec is pluggable, native where possible.** On a port whose messages are structured
(a real `MessagePort`), envelopes pass through unencoded, preserving zero-copy `ArrayBuffer`
transfer and the ability to carry real ports inside a payload. On a port whose messages are bytes
(WebSocket, LiveKit), envelopes encode to binary with msgpack.

**D7. One stream per port.** A stream *is* what runs on a port. `callBidi`'s `channelName`
allocation is deleted; it opens a virtual port instead. After this change the repository has one
multiplexer.

**D8. Stream timeouts are per stream and configurable, not per chunk.** Closing a port closes every
stream on it. An individual stream ends on its own timeout, or on an explicit close notification
from the peer. The explicit close is the normal path; the timeout is the backstop for a peer that
says nothing.

**D9. `Duplex` remains layer 2's output.** `Connect`/`Serve` and the entire L0–L6 conformance suite
therefore apply to the new stack unchanged, and are the regression net for the migration.

**D10. Message size is data, not a constant.** `PortMux` exposes an optional
`maxMessageSize?: number`, and a single-pipe adapter returns it beside its port
(`{ port, maxMessageSize? }`) rather than handing back a bare `MessagePort` that cannot carry it.
Layer 2 chunks to it. LiveKit's mux reports 12 KiB, a `MessagePort`
reports nothing, and no layer hardcodes another layer's limit. Fragmenting *below* the multiplexer
was rejected: a 10 MiB message would become ~800 transport packets that block every other port
behind them, reintroducing head-of-line blocking underneath the layer that exists to prevent it.

**D11. A stream is sequential; concurrency comes from having many streams.** Within one stream,
the next chunk is never sent until the previous one is delivered *and* confirmed — window of one.
Between streams there is no coupling at all, because each stream owns a separate virtual port and
layer 1 gives ports no shared state. This is what "clean backpressure" buys: the confirmation is
the only mechanism, and it cannot be gamed by pipelining.

**D12. Each stream uses `callPort` on its own virtual port** — never on the root port used for
multiplexing. The request is the chunk, the reply is the confirmation, and `callPort` already
exists and is tested. On a dedicated port with one call outstanding there is no `callId`
contention and no shared timeout, which is what made this unworkable on a shared port.

**D14. Calls share one control port; streams get a port each.** `callPort` already demultiplexes
concurrent calls on one port by `callId` — that is what the `callId` machinery is for — so a
one-shot call costs a request and a reply rather than `OPEN`/request/reply/`CLOSE`. Streams need
their own port because backpressure is per port (D11): two streams sharing one would throttle each
other. The initiator opens the single control port; `callPort`/`listenPort` on both ends make it
bidirectional. Layer 2 distinguishes the two kinds with a discriminator in `OPEN`'s `meta`
(`{ kind: "control" }` / `{ kind: "stream" }`), which layer 1 passes through without inspecting.

**D15. The receiver enforces the window; violation closes that virtual port.** A stream handler
checks that it has sent the confirmation for the previous chunk before accepting the next. A second
unconfirmed chunk is a protocol violation, not a resource question, so no byte ceiling and no
tunable threshold is needed. The penalty is scoped to the offending virtual port; the mux and every
other port are untouched.

This gives memory a *provable* bound rather than a configured one:

```
worst case  =  maxPorts  ×  one chunk  ≤  maxPorts × maxMessageSize
```

Layer 1 holds nothing (D3), drops for ports with no consumer (D5), and bounds port count
(`maxPorts`); layer 2 holds at most one chunk per open stream. There is nowhere left to accumulate.
`emulateMux` could not make this claim — its `maxStreamBuffer` was a guessed ceiling.

The 19-test hostile suite re-points at layer 2 with its questions intact, and "what happens under a
flood" gets a deterministic answer: the port closes on the second unconfirmed chunk.

**Consequence for D13.** A future windowed sender is, by this rule, a protocol violator against a
non-windowed receiver. Windowing must therefore advertise its window in `OPEN`'s `meta` so both
ends agree before the first chunk. That is a requirement on D13, recorded now while the reason is
visible.

**D16. Layer 2's payload contract is the msgpack-expressible subset.** Transferables are an
optimisation, never a semantic. `structuredCodec` skips encoding and moves `ArrayBuffer`s zero-copy
through the transfer list, so port transports are faster — but nothing layer 2 sends may depend on
a capability msgpack lacks.

This forbids something attractive: passing a live `MessagePort` inside a payload, which is how
`callChannel` hands over a capability today (F2). Layer 2 opens a virtual port and sends its id
instead, which behaves identically on every transport. Capability detection was rejected for the
same reason — two paths, unequally exercised, with the port-transport path better tested in
development and the byte path only in CI.

**D17. L6 is redefined around the confirmation, and `PairTuning` is reshaped.** L6 currently proves
flow control by asking for a small credit window (`PairTuning { mtu, maxStreamBuffer }`, 16 KiB
against a 256 KiB body). Under D11 there is no window to shrink, so that level would configure
something that no longer exists — and still pass, because a 256 KiB body completes fine one chunk
at a time. It would read as coverage while asserting nothing.

Redefined, L6 pins the property D11 actually creates: **the producer cannot run ahead of the
consumer.** A slow consumer, a body many times one chunk, and an assertion that chunks on the wire
never exceed chunks drained by more than one. It has a floor (the transfer completes) and a ceiling
(never more than one ahead), and it dies under the obvious mutation — delete the confirmation wait
and the sender races ahead immediately.

`PairTuning` becomes `{ maxMessageSize? }` or empty, since the transport now decides. This is a
breaking change to `webrun-streams-conformance`'s public API and touches every adapter's pair
factory.

**D18. Non-goal: reconnection.** A transport that drops takes every virtual port with it, and
nothing is resumed. Ports are not durable and carry no sequence numbers for replay. Stated so it is
a boundary rather than an oversight.

**D20. Adapters depend on nothing in this repository.** Their currency is `MessagePort`, a platform
type, and a plain function type. Structural typing does the rest. This is stronger than it sounds:
it means a transport package can be understood, versioned and published without reference to the
port or stream layers at all.

**D21. The caller decides where multiplexing comes from.** A natively multiplexed transport hands
back a factory; a single-pipe transport hands back one port and the caller wraps it with
`multiplexPort`. No adapter decides whether emulation is needed.

**D22. `webrun-streams-port` is renamed to `webrun-rpc`, not deleted.** Its transport role
evaporates — a `MessagePort` needs no adapter — leaving the transport-agnostic RPC tier it was
already carrying (`callPort`, `callBidi`, `listenPort`, `listenBidi`, `ioSend`, `ioHandle`, `send`,
`recieve`). That package becomes layer 1 + layer 2: `MessageTarget`, `PortMux`, `multiplexPort`, the
codecs, and the RPC primitives retyped from `MessagePort` to `MessageTarget`. `webrun-streams` keeps
only generic stream functionality — `Duplex`, `Connect`, `Serve`, error serialisation and the
async-iterator utilities — and loses `MessageTarget` and the port layer.

`Duplex`, `Connect` and `Serve` stay in `webrun-streams` and do **not** move: `webrun-http-streams`
consumes `Duplex` and touches nothing port-related, so moving it would make an HTTP-over-streams
package depend on an RPC package to describe a byte stream. The dependency runs one way,
`webrun-rpc` -> `webrun-streams`, because `duplexOverPort` returns a `Duplex`.

Since `@statewalker/webrun-streams-port` is published at 0.1.1, the npm rename needs a `major`
changeset or a deprecation stub — though no workspace package currently declares it as a dependency.

**D19. Exceeding `maxPorts` rejects the port, never the mux.** An `OPEN` beyond the limit is
answered with `CLOSE` carrying an error; existing ports are untouched. Ids are never reused within
a mux's lifetime; `maxPorts` bounds concurrency, not total opens, and a varint id space is large
enough that exhaustion is not a practical concern.

**D13. Per-stream windowing is deferred, deliberately.** Allowing several chunks in flight per
stream is a stated future step, not an omission. The cost of deferring is that single-stream
throughput is `chunk ÷ RTT`: negligible in-process, ~0.9 s for 10 MiB on a LAN WebSocket, and
**~43 s for 10 MiB over a 50 ms WAN round trip** (854 sequential round trips). Applications that
parallelise across streams are unaffected, because those streams genuinely run concurrently.

---

## Architecture

```
Layer 3   transport adapter    ->  exactly one port        (MessageTarget)
Layer 1   multiplexPort(port)  ->  many virtual ports      (MessageTarget)
Layer 2   stream / call        ->  runs on ONE port        (Duplex out)
```

A `MessagePort` enters at layer 3 as itself. A WebSocket enters as a port whose messages are
`Uint8Array`. Layer 1 does not know or care which it received; the codec does.

---

## Layer 1 — the port multiplexer

### Interface

```ts
export interface PortMuxOptions {
  /** How envelopes are placed on the underlying port. See Codec. */
  codec: PortCodec;
  /**
   * Called when the peer opens a port. Return a truthy accept to take it.
   * Returning false — or throwing — rejects: a CLOSE is sent back and every
   * subsequent message for that id is dropped.
   */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | void;
  /** Id parity. Initiator allocates even ids, responder odd. */
  side?: "initiator" | "responder";
  /** Ceiling on concurrently open virtual ports. Rejects OPEN beyond it. */
  maxPorts?: number;
}

export interface PortMux {
  /** Allocate a port, announce it, return the local end immediately. */
  openPort(meta?: unknown): MessageTarget;
  /** Close every virtual port, then release the underlying transport. */
  close(): Promise<void>;
  /**
   * Largest message this mux's ports can carry, if the transport imposes one.
   * Undefined means unlimited. Layer 2 chunks to it (D10); layer 1 never
   * inspects a payload's size itself.
   */
  readonly maxMessageSize?: number;
}

/** The default implementation: emulates multiplexing over a single port. */
export function multiplexPort(port: MessageTarget, options: PortMuxOptions): PortMux;
```

`openPort` returns synchronously and does not wait for the peer to accept. Messages posted before
acceptance are sent; if the peer rejects, they are dropped at the far end and the local port
receives a `CLOSE`. This keeps layer 1 free of round trips — a caller that needs confirmation
builds it at layer 2, where confirmation already exists.

**No close of any kind is observable at layer 1, and that constrains layer 2.** Found during Plan
A's implementation and sharpened by its final review: `MessageTarget` has no close event and no
`onclose`, and the port `openPort` returns exposes no queryable state. When a `CLOSE` envelope
arrives, layer 1 clears the port's listeners and makes `postMessage` a silent no-op — no error, no
event, no callback, and the envelope's `reason` is discarded rather than surfaced. A consumer at
this layer cannot distinguish a closed port from a working one, and this is true of an **orderly
peer close** just as much as of a rejection.

An earlier draft of this paragraph said a rejected port "never sends" a close. That was wrong — the
rejection path does post one, and two tests assert it arrives. The wrong reason concealed the real
problem, which is broader: the envelope is sent and correctly processed; it is simply never surfaced
to whoever holds the port.

This follows from D3 rather than contradicting it. A real `MessagePort` behaves the same way, and
adding a close event would make layer 1 something other than a port. **But it means D8's "explicit
close notification from the peer" cannot be layer 1's `CLOSE`** — layer 2 cannot see it. That
notification must be layer 2's own end-of-stream message, sent on the port *before* the port is
closed, with layer 1's `CLOSE` serving only as transport cleanup behind it.

Two requirements on Plan B follow, and both need tests:

- A stream must send its own end-of-stream message and not rely on layer 1's `CLOSE` being visible.
- A stream opened on a port the peer **rejects** gets no layer-2 message at all, because the peer's
  layer 2 never saw the port. For that case the per-stream timeout (D8) is the only signal. Plan B
  must test that such a stream fails rather than hanging forever.

### Envelopes

Layer 1 exchanges three envelope types. Their wire representation is the codec's business.

| type | fields | meaning |
| --- | --- | --- |
| `OPEN` | `id`, `meta?` | Peer is asked to accept a new port. `meta` is opaque to layer 1. |
| `MESSAGE` | `id`, `payload` | Ordinary traffic for an open port. |
| `CLOSE` | `id`, `reason?` | Port is finished. `reason` is opaque and layer 1 never inspects it — and, as implemented, never surfaces it either (see below). |

### Identity

Ids are integers. The initiator allocates even, the responder odd, so both ends may open
concurrently with no negotiation. This is the scheme `emulateMux` uses today and it is retained
because it works and is already understood.

An id is retired when both ends have seen `CLOSE`. Ids are not reused within the lifetime of a mux;
`maxPorts` bounds concurrency, not total opens.

### The codec

```ts
export interface PortCodec {
  /** Place one envelope on the underlying port. */
  post(port: MessageTarget, envelope: PortEnvelope): void;
  /** Recover an envelope from a message event, or undefined to ignore it. */
  read(event: MessageEvent): PortEnvelope | undefined;
}
```

Two implementations ship:

- **`structuredCodec`** — for ports whose messages are structured values. `post` calls
  `port.postMessage(envelope, transfer)`, so `ArrayBuffer`s transfer zero-copy and real
  `MessagePort`s may travel inside `payload`. `read` returns `event.data` when it has the envelope
  shape.
- **`msgpackCodec`** — for ports whose messages are bytes. Encodes to
  `[varint id][1-byte type][msgpack payload]` using `encodeMsgpack`/`decodeMsgpack` from
  `@statewalker/webrun-msgpack`. The header stays binary and outside msgpack so demultiplexing does
  not require decoding the payload.

The codec is the *only* place that knows the wire format. A third transport with different
constraints adds a codec, not a multiplexer.

### Invariants

These are the properties layer 1 guarantees, and each must have a test that fails without it.

1. **No flow control.** `postMessage` never blocks, never awaits, never applies credit.
2. **Drop, never queue, for ports with no consumer.** A `MESSAGE` for an id that was rejected, was
   never opened, or has been closed is discarded on arrival. Layer 1 holds no buffer on behalf of a
   consumer that does not exist. This is what makes D3 safe.
3. **Isolation.** One port's traffic, closure or failure does not affect another's.
4. **Ordering per port.** Messages on a single port are delivered in send order. Layer 1 provides no
   ordering guarantee *between* ports.
5. **Close is idempotent and bidirectional.** Closing either end delivers `CLOSE` to the other;
   closing twice is a no-op.
6. **Composability.** `multiplexPort` accepts a virtual port produced by another `multiplexPort`.

---

## Layer 2 — streams and calls

### What moves

The primitives in `webrun-streams-port/src` are re-typed from `MessagePort` to `MessageTarget` and
moved out of the transport adapter. Their logic is unchanged and their existing tests travel with
them: `callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`, `send`, `recieve`,
`cancel-channel`, `close-signal`.

### What changes

**`callBidi` opens a port.** It currently allocates a `channelName` string and multiplexes
sub-channels over one port. It instead calls `mux.openPort()` and runs the stream on the result.
The `channelName` option is removed, not deprecated — this is the change that reduces the repository
to one multiplexer (D7).

**Timeouts move from the chunk to the stream (D8).** A stream carries one configurable timeout.
**Its default is no timeout at all**, because the two signals that matter — an explicit peer close
and a port close — are both reliable, and any finite default reintroduces F5's defect at a
different threshold. A chunk acknowledgement has no deadline of its own: a slow consumer is
throttled, never failed. A caller who needs a bounded transfer sets one. A stream ends when

- the peer sends an explicit stream-close notification (the normal path), or
- its own timeout elapses with no progress at all, or
- its port closes, or
- the underlying transport closes, surfaced through the existing port-close signal (F6).

This is the direct fix for F5, and its regression test is a consumer deliberately slower than the
old 1000 ms default completing successfully.

**`duplexOverPort(port, options): Duplex`** is the adapter that satisfies D9. One port in, one
`Duplex` out. It owns chunk framing, half-close, error propagation and the per-stream timeout —
everything `emulateMux` did per stream, minus multiplexing, minus credit.

Its acknowledgement mechanism is `callPort` on that stream's own port (D12), one call per chunk,
one call outstanding at a time (D11). The request carries the chunk; the reply, withheld until the
consumer has pulled past the value, is the confirmation. No new stream protocol is introduced and
no `callId` demultiplexing is needed, because the port carries exactly one stream.

Chunks are sized to `mux.maxMessageSize` when the mux declares one (D10), using `toChunks` from
`webrun-streams`.

### The receive buffer ceiling

D5 covers ports with no consumer. It does not cover a port whose consumer is merely slow: those
messages are delivered, and layer 2 holds them.

Because the acknowledgement is withheld until the consumer pulls, a *cooperative* peer is
throttled to one outstanding chunk and cannot accumulate. A peer that ignores the protocol and
posts without waiting can. `emulateMux` defended this with `maxStreamBuffer` and a 19-test hostile
suite; under D3 that defence cannot live at layer 1.

**Resolution:** `duplexOverPort` carries a `maxBufferedBytes` ceiling. Exceeding it closes that
stream with an error and leaves every other port untouched. The hostile suite is re-pointed at
layer 2 rather than deleted, because its questions — what happens under a flood, an undrained
stream, exhausted ids — remain exactly right; only the layer that answers them changes.

---

## Layer 3 — transports expose port factories

**Adapters depend on nothing in this repository.** An adapter's currency is `MessagePort` — a
platform type — and a plain function type. Because a `MessagePort` satisfies `MessageTarget`
structurally (F1), `multiplexPort` accepts one with no import and no dependency edge. That keeps
every transport package's dependencies limited to its own transport library.

The common currency is a **port factory**, and each adapter exposes what it honestly is:

```ts
type PortFactory = (meta?: unknown) => Promise<MessagePort>;

// Natively multiplexed — each call is a real channel.
webrtcConnect(params) -> Promise<PortFactory>   // createDataChannel per call
libp2pConnect(params) -> Promise<PortFactory>   // dialProtocol per call

// Single pipe — one port, and that is all the transport has.
wsConnect(params)      -> Promise<{ port: MessagePort; maxMessageSize?: number }>
livekitConnect(params) -> Promise<{ port: MessagePort; maxMessageSize?: number }>
peerjsConnect(params)  -> Promise<{ port: MessagePort; maxMessageSize?: number }>
```

The **caller** composes. `multiplexPort(singlePort)` turns one port into a factory; a natively
multiplexed adapter already is one. So native muxing is preserved where the transport has it —
yamux's per-stream flow control, the browser's DataChannel scheduling — and emulation is added only
where there is genuinely one pipe. Nothing in an adapter decides that; the caller does.

This also collapses two concepts into one: `PortMux.openPort` **is** a port factory. A native
adapter and an emulated mux are interchangeable at the same seam.

| adapter | exposes | multiplexing | `maxMessageSize` |
| --- | --- | --- | --- |
| `-webrtc` | `PortFactory` | native — `createDataChannel` / `ondatachannel` | **16 KiB** |
| `-libp2p` | `PortFactory` | native — `dialProtocol` / `node.handle` | none |
| `-ws` | one port | caller adds `multiplexPort` | none |
| `-livekit` | one port | caller adds `multiplexPort` | **12 KiB** |
| `-peerjs` | one port | caller adds `multiplexPort` | **unverified — measure** |

**There is no `-port` adapter.** A `MessagePort` already satisfies `MessageTarget`, so there is
nothing to adapt: hand it to `multiplexPort` directly. `webrun-streams-port`'s transport role
evaporates, leaving only the RPC tier it was already carrying — which is why it is renamed to
`webrun-rpc` rather than deleted (D22).

`-webrtc`'s 16 KiB limit is not incidental: `duplex-over-data-channel.ts` already chunks to
`DC_MTU = 16 * 1024`, commented *"conservative across browsers"*, because a DataChannel message
above the negotiated maximum fails rather than fragmenting. It must be reported, or the limit
silently disappears when the chunking currently doing that job is deleted. `-peerjs` rides on WebRTC
too and its ceiling is **unverified** — measure it before migrating that adapter, because the
identical mistake on LiveKit delivered a 1 MiB body as **zero bytes** with no error on either side.

**Cost of bridging to a real `MessagePort`.** A single-pipe adapter creates a `MessageChannel` and
pumps between the transport and one end, so every message crosses a structured-clone hop and a
macrotask that a plain `MessageTarget` object would not incur. Measure it on `-ws` during Plan B
before committing the other two. In exchange, a transport-backed port is a genuine `MessagePort` and
can be **transferred into a worker or iframe** — a capability the `MessageTarget` shape cannot offer.

---

## What this deletes

- `packages/webrun-streams/src/emulate-mux.ts` — the multiplexer, 572 lines. Deleted outright once
  layer 2 passes L0–L6 on `-ws` and `-port`. Not deprecated: the wire format breaks either way and
  Finding 3 of the RPC spec established there are no external consumers.
- `byteChannelFromMessagePort`, and `ByteChannel` as a public seam. It survives only as an
  implementation detail inside byte-transport adapters, if at all.
- `callBidi`'s `channelName` multiplexing.
- **Most of `docs/superpowers/plans/2026-09-04-credit-flow-control.md`.** Its credit design assumed
  a byte-level multiplexer that owns a window per stream. Layer 1 has no flow control, and under
  D11/D13 layer 2 ships a window of one, so `flow-control.ts` and `uint32.ts` have **no consumer**
  in this design.

  They are kept, not deleted, and marked dormant. Per-stream windowing (D13) is a stated future
  step and `newCreditLedger`/`newCreditGrantor` are exactly its mechanism — the grantor is already
  the replenishment *policy* object, so windowing arrives as configuration rather than as new code.
  Deleting them would mean rewriting proven, mutation-tested code later. A dormant module with a
  README line saying so is cheaper and honest; an unused export that claims to be wired up is not.

What survives from that work and carries forward: the conformance suite including L6, the three
browser harnesses and the four adapter bugs they exposed, the hostile suite's questions, and
`MessageTarget` in `webrun-streams` (F1), which is the interface this entire design rests on.

---

## Packaging

- **`@statewalker/webrun-rpc`** (renamed from `webrun-streams-port`, D22) — layer 1 **and** layer 2:
  `MessageTarget`, `PortMux`, `multiplexPort`, `PortCodec`, `structuredCodec`, `duplexOverPort`, and
  the RPC primitives retyped from `MessagePort` to `MessageTarget`. Depends on `webrun-streams` for
  `Duplex` and the iterator utilities.

  A short-lived `@statewalker/webrun-ports` package existed during Plan A and was absorbed into
  `webrun-streams` (commit `24f2fc9`) because its central type lived there; Plan B moves that code
  on to `webrun-rpc`. Recorded so the two moves are not mistaken for indecision: the first fixed a
  package that could not define its own interface, the second gives the port layer a home that is
  not the generic stream package.
- **`@statewalker/webrun-msgpack`** — gains `msgpackCodec`. It lives here, not in `webrun-ports`,
  because `webrun-ports` must keep zero runtime dependencies. The dependency runs
  `webrun-msgpack` -> `webrun-ports`, and it is **type-only**: the codec implements `PortCodec` and
  imports nothing from it at runtime, so no cycle and no runtime edge is created.
- **`@statewalker/webrun-rpc`** (new) — layer 2: the re-typed primitives and `duplexOverPort`.
- **`@statewalker/webrun-streams`** — **generic stream functionality only**: `Duplex`, `Connect`,
  `Serve`, `newAsyncGenerator`, `sendIterator`/`recieveIterator`, `toChunks`, the iterator
  utilities and error serialisation. Loses `emulateMux` (Plan C) and loses `MessageTarget` and the
  port layer to `webrun-rpc` (Plan B). Zero dependencies.

  `Duplex`, `Connect`, `Serve` and `TransportClosedError` are currently **declared inside
  `emulate-mux.ts`** — the file Plan C deletes. Extract them into their own module before Plan C, so
  that plan removes an implementation rather than the seam every adapter imports.
- **`webrun-streams-*`** — each reduces to exposing a port or a port factory (Layer 3), depending on
  nothing in this repository. There is no `-port` adapter: a `MessagePort` needs none.

Creating a package requires, in the same change: the directory under `packages/`, a README in the
house structure, a `tsconfig.json` extending `../../tsconfig.base.json`, a `rolldown.config.js`
using `externalsFrom(import.meta.url)`, an entry in `tsconfig.base.json`'s `paths`, a row in the
root `README.md` tables, and a changeset.

---

## Verification

**The conformance suite is the net.** L0–L5 must pass against every adapter at every stage of the
migration, and because `duplexOverPort` produces `Duplex` (D9) they need no change to cover the new
stack. That is the most valuable property of the design and the reason `Duplex` is retained.

**L6 is the exception and must be rewritten before it is trusted (D17).** As written it configures a
credit window that this design removes, and it would keep passing — a body completes fine one chunk
at a time — so it would report coverage it no longer provides. Its replacement asserts the
one-chunk-ahead property, with a floor (the transfer completes) and a mutation that kills it
(delete the confirmation wait). Until that rewrite lands, L6's green is meaningless and must not be
cited as evidence the new flow control works.

**Layer 1 gets its own tests**, against a pair of in-memory ports, covering each invariant with a
mutation that turns it red:

- a rejected port's messages are dropped, and the sender is not blocked by the rejection;
- a message for an unknown, closed or never-opened id is dropped rather than queued;
- one port's failure does not disturb another's traffic;
- per-port ordering holds under interleaved sends;
- close is idempotent and reaches both ends;
- a mux over a virtual port works (composability, D2);
- `maxPorts` rejects rather than accumulating.

**Layer 2's regression test for F5** is a consumer deliberately slower than 1000 ms per value
completing a transfer. This fails on today's code and is the reason D8 exists.

**The hostile suite** moves to layer 2 and keeps its 19 questions.

**Browser suites stay green.** `-webrtc`, `-peerjs` and `-livekit` each run 11/11 in chromium and
must continue to; they are the only place the stack is exercised over a real transport.

**Standing rule, from six occurrences in this project:** an assertion that is only an upper bound or
an absence claim — "no more than N", "nothing follows", "no error", "the grep returns nothing" — is
satisfied by breaking the machinery outright. Every such assertion needs a floor asserting the
feature still works. Layer 1's drop-don't-queue tests are especially exposed to this, because
"nothing was delivered" is trivially true if nothing was ever sent.

---

## Risks and open questions

**R1. RESOLVED — native multiplexing is preserved.** `PortMux` is an interface (D2), so `-webrtc`,
`-libp2p` and `-port` supply native implementations and keep the flow control and scheduling their
transports already provide. Emulation is confined to genuinely single-pipe transports. The residual
risk is that implementations differ in their guarantees — yamux applies flow control, the emulated
one does not — so conformance, not inspection, is what establishes they are behaviourally
equivalent at the `Duplex` level.

**R2. Single-stream throughput is `chunk ÷ RTT`, by decision (D13).** This is not unmeasured; it is
the behaviour the credit work removed, reintroduced knowingly and confined to one stream. Measured
consequence: ~43 s for a 10 MiB body over a 50 ms round trip. Concurrency across streams is
unaffected. **Open:** whether any real workload moves a large body over a single high-RTT stream —
if so, D13's windowing stops being future work and becomes required. The `-livekit` browser suite
is the place to find out, since it runs against a real SFU.

**R3. RESOLVED — `maxMessageSize` on `PortMux` (D10).** LiveKit reports 12 KiB; layer 2 chunks to
it. No fragmentation exists below the multiplexer, so head-of-line blocking is not reintroduced.
The residual risk is that a transport limit is *wrong* rather than absent: the previous failure was
silent, so `-livekit` needs a test that a body many times `maxMessageSize` arrives intact rather
than as zero bytes.

**R4. `structuredCodec` and `msgpackCodec` are not interchangeable in what they can carry.**
Structured clone moves `ArrayBuffer`s zero-copy and can carry real `MessagePort`s; msgpack cannot.
A layer-2 primitive that relies on transferables therefore works on some transports and not others.
**Open:** whether layer 2 must restrict itself to the msgpack-expressible subset, or may
capability-detect.

**R5. This supersedes recently completed and reviewed work.** The 8-task credit plan landed 17
commits and is fully green. Proceeding means deleting most of it. The decision is deliberate, and
the surviving value (conformance, browser suites, four adapter fixes, `MessageTarget`) is real, but
it should be taken with the cost visible.

**R6. Nothing is pushed.** `origin/main` is at `2604507`; the credit work sits unpushed on `dev`.
Whether that lands before this begins is a separate decision.

---

## Sequencing

Three plans, each producing working software.

**Plan A — layer 1.** `webrun-ports`: the `PortMux` and `PortCodec` interfaces, the default emulated
`multiplexPort`, `structuredCodec`, and the invariant tests including a mux-over-a-virtual-port case
for composability (D2). `msgpackCodec` lands in `webrun-msgpack` with a type-only dependency, so
`webrun-ports` keeps zero runtime dependencies. Consumes nothing, changes no adapter, deletes
nothing.

**Plan B — layer 2 on layer 1.** Move and re-type the primitives into `webrun-rpc`; build
`duplexOverPort` on `callPort`-per-chunk (D12) with receiver-side window enforcement (D15); open one
control port for calls and one port per stream (D14); replace `callPort`'s 1000 ms default with the
per-stream timeout defaulting to none (D8, fixing F5); rewrite L6 and reshape `PairTuning` (D17);
re-home the hostile suite. Ends with `-port` and `-ws` on the new stack passing L0–L6, with
`emulateMux` still present.

The F5 regression test — a consumer deliberately slower than 1000 ms per value completing a
transfer — is this plan's headline assertion, because it fails on today's code.

**Plan C — layer 3 and the deletion.** Native `PortMux` implementations for `-port`, `-webrtc` and
`-libp2p`, each reporting its `maxMessageSize` (16 KiB for `-webrtc`; verify `-peerjs`'s before
migrating it). Migrate `-livekit` and `-peerjs` onto the emulated mux. Then delete `emulateMux`,
`byteChannelFromMessagePort` and `ByteChannel` as a seam; mark `flow-control.ts` and `uint32.ts`
dormant. Update every README, `docs/adr/0004-duplex-as-seam.md`, the root package tables, and add
changesets.

**Gates between plans.** R2's question — whether any real workload pushes a large body over a
single high-RTT stream — should be answered on the `-livekit` browser suite during Plan B, because
it runs against a real SFU and is the only place the ÷RTT cost is visible. If the answer is yes,
D13's windowing moves out of "future" and into Plan B, and `flow-control.ts` wakes up rather than
going dormant.

`-peerjs`'s message ceiling must be measured before Plan C migrates it. The LiveKit failure it
would otherwise repeat was silent: a 1 MiB body arriving as zero bytes with no error on either
side.
