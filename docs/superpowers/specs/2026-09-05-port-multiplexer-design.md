# Port multiplexer design

**Status:** ratified in conversation, not yet planned
**Date:** 2026-09-05
**Supersedes:** the multiplexing half of `docs/superpowers/specs/2026-09-04-webrun-rpc-design.md`
Decision 8, and most of `docs/superpowers/plans/2026-09-04-credit-flow-control.md` (see
[What this deletes](#what-this-deletes)).

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

`PortMux` is an **interface**. `webrun-ports` ships the default implementation, which emulates
multiplexing over a single port. A transport that already multiplexes natively supplies its own
compatible implementation from its own package — `-libp2p` from `dialProtocol`/`node.handle`,
`-webrtc` from `createDataChannel`/`ondatachannel`, `-port` from `MessageChannel` transfer.
Emulation therefore happens only where the transport genuinely offers one pipe, and `webrun-ports`
never imports a transport's types.

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
`maxMessageSize?: number`; layer 2 chunks to it. LiveKit's mux reports 12 KiB, a `MessagePort`
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

### Envelopes

Layer 1 exchanges three envelope types. Their wire representation is the codec's business.

| type | fields | meaning |
| --- | --- | --- |
| `OPEN` | `id`, `meta?` | Peer is asked to accept a new port. `meta` is opaque to layer 1. |
| `MESSAGE` | `id`, `payload` | Ordinary traffic for an open port. |
| `CLOSE` | `id`, `error?` | Port is finished; `error` distinguishes fault from normal close. |

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

## Layer 3 — transports expose one port

Each adapter's job reduces to producing a single `MessageTarget`.

Each adapter supplies a `PortMux`: either the default emulated one over a single port, or its own
native implementation (D2).

| adapter | `PortMux` | mechanism | `maxMessageSize` |
| --- | --- | --- | --- |
| `-port` | native | `MessageChannel` + port transfer, the F2 pattern | none |
| `-webrtc` | native | `createDataChannel` / `ondatachannel` | **16 KiB** |
| `-libp2p` | native | `dialProtocol` / `node.handle`, yamux streams | none |
| `-ws` | emulated | one socket as a port carrying `Uint8Array`, `msgpackCodec` | none |
| `-livekit` | emulated | room + peer identity as a byte port, `msgpackCodec` | **12 KiB** |
| `-peerjs` | emulated | `DataConnection` as a byte port, `serialization: "raw"`, `msgpackCodec` | none |

`-webrtc`'s limit is not incidental: `duplex-over-data-channel.ts` already chunks to
`DC_MTU = 16 * 1024`, commented *"conservative across browsers"*, because a DataChannel message
above the negotiated maximum fails rather than fragmenting. A native `PortMux` must report it, or
the limit silently disappears when the chunking currently doing that job is deleted. `-peerjs`
rides on WebRTC too and its ceiling is **unverified** — it must be measured before that adapter is
migrated, not assumed absent.

The three native rows keep the flow control and scheduling their transports already provide —
yamux's credit window, the browser's DataChannel scheduling, the structured-clone queue — instead
of flattening it and re-emulating. `-port` also stops flattening a `MessagePort` to bytes, so
structured clone and zero-copy transfer survive.

Only `-ws`, `-livekit` and `-peerjs` are genuinely single-pipe transports, and only they run the
emulated multiplexer.

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

- **`@statewalker/webrun-ports`** (new, zero runtime dependencies) — layer 1: `multiplexPort`,
  `PortMux`, `PortCodec`, `structuredCodec`. The name is free; the previous package of that name was
  dissolved into `webrun-streams-port`.
- **`@statewalker/webrun-msgpack`** — gains `msgpackCodec`. It lives here, not in `webrun-ports`,
  because `webrun-ports` must keep zero runtime dependencies. The dependency runs
  `webrun-msgpack` -> `webrun-ports`, and it is **type-only**: the codec implements `PortCodec` and
  imports nothing from it at runtime, so no cycle and no runtime edge is created.
- **`@statewalker/webrun-rpc`** (new) — layer 2: the re-typed primitives and `duplexOverPort`.
- **`@statewalker/webrun-streams`** — keeps `Duplex`, `Connect`, `Serve`, `MessageTarget`,
  `newAsyncGenerator`, `sendIterator`/`recieveIterator`, error serialisation. Loses `emulateMux`.
- **`webrun-streams-*`** — each reduces to exposing one port.

Creating a package requires, in the same change: the directory under `packages/`, a README in the
house structure, a `tsconfig.json` extending `../../tsconfig.base.json`, a `rolldown.config.js`
using `externalsFrom(import.meta.url)`, an entry in `tsconfig.base.json`'s `paths`, a row in the
root `README.md` tables, and a changeset.

---

## Verification

**The conformance suite is the net.** L0–L6 must pass against every adapter at every stage of the
migration. Because `duplexOverPort` produces `Duplex` (D9), the suite needs no change to cover the
new stack — this is the single most valuable property of the design and the reason `Duplex` is
retained.

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

**Plan A — layer 1.** `webrun-ports` with `multiplexPort`, the codec interface, both codecs, and the
invariant tests. Consumes nothing, changes no adapter, deletes nothing. Independently valuable and
independently reviewable.

**Plan B — layer 2 on layer 1.** Move and re-type the primitives into `webrun-rpc`; build
`duplexOverPort`; fix F5 per D8; re-home the hostile suite. Ends with `-port` and `-ws` served by
the new stack and passing L0–L6, with `emulateMux` still present. Settles R2 by measurement before
Plan C commits.

**Plan C — layer 3 and the deletion.** Realign the remaining adapters, resolve R1 and R3, delete
`emulateMux`, `ByteChannel` and the credit modules that lose their consumer. Update every README,
`docs/adr/0004-duplex-as-seam.md`, and the root package tables; add changesets.

R1 must be resolved before Plan C is written, and R2 before `emulateMux` is deleted.
