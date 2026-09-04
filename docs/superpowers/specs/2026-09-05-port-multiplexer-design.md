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
  /** Allocate an id, send OPEN, return the local end immediately. */
  openPort(meta?: unknown): MessageTarget;
  /** Close every virtual port, then the underlying port. */
  close(): Promise<void>;
}

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
`Duplex` out. It owns chunk framing, the acknowledgement handshake, half-close, error propagation
and the per-stream timeout — everything `emulateMux` did per stream, minus multiplexing, minus
credit.

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

| adapter | port it exposes | codec | note |
| --- | --- | --- | --- |
| `-port` | the `MessagePort` itself | `structuredCodec` | `byteChannelFromMessagePort` is deleted. |
| `-ws` | socket wrapped as a port carrying `Uint8Array` | `msgpackCodec` | |
| `-livekit` | room + peer identity as a port carrying `Uint8Array` | `msgpackCodec` | 12 KiB payload ceiling still applies; see Risks. |
| `-peerjs` | `DataConnection` as a port carrying `Uint8Array` | `msgpackCodec` | `serialization: "raw"` as today. |
| `-webrtc` | one `RTCDataChannel` as a port carrying `Uint8Array` | `msgpackCodec` | Gains multiplexing it currently gets from channel-per-call. |
| `-libp2p` | one yamux stream as a port carrying `Uint8Array` | `msgpackCodec` | Native muxing becomes redundant; see Risks. |

`-webrtc` and `-libp2p` are the two that lose native multiplexing under this design. That is a real
trade and it is called out in Risks rather than assumed away.

---

## What this deletes

- `packages/webrun-streams/src/emulate-mux.ts` — the multiplexer, 572 lines. Deleted outright once
  layer 2 passes L0–L6 on `-ws` and `-port`. Not deprecated: the wire format breaks either way and
  Finding 3 of the RPC spec established there are no external consumers.
- `byteChannelFromMessagePort`, and `ByteChannel` as a public seam. It survives only as an
  implementation detail inside byte-transport adapters, if at all.
- `callBidi`'s `channelName` multiplexing.
- **Most of `docs/superpowers/plans/2026-09-04-credit-flow-control.md`.** Its credit design assumed
  a byte-level multiplexer that owns a window per stream. Layer 1 has no flow control, so
  `flow-control.ts` and `uint32.ts` lose their consumer. `flow-control.ts` may find a second life
  inside `duplexOverPort` if per-stream windowing beats ack-per-chunk, but that is **unproven and
  must not be assumed** — the ack mechanism (F4) is what this design specifies.

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

**R1. `-webrtc` and `-libp2p` lose native multiplexing.** Both currently get per-call channels from
the transport — an `RTCDataChannel` per call, a yamux stream per call — and would move to one
channel plus layer 1. That trades a battle-tested native muxer for ours, and for libp2p it discards
yamux's own credit-window flow control. **Open:** whether these two should instead expose their
native per-call primitive as a `PortMux` implementation, so layer 2 sees ports either way and no
emulation happens. This is the most likely place the design is wrong, and it should be settled
before layer 3 is planned.

**R2. Ack-per-chunk throughput is unmeasured against credit.** F4's mechanism costs one round trip
per chunk. The credit design it replaces was built precisely to avoid that. No measurement compares
them on a real transport. **Open:** benchmark `duplexOverPort` against the current `emulateMux` on
`-ws` before deleting the latter.

**R3. LiveKit's payload ceiling still applies.** Reliable data packets cap near 15 KiB and are
dropped rather than fragmented; the adapter currently defaults `mtu` to 12 KiB. Layer 1 has no MTU
concept, so **chunking must live somewhere** — most likely in the LiveKit codec or its port
wrapper. Unresolved, and it silently corrupted transfers when it was previously missed: a 1 MiB
body arrived as zero bytes with no error.

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
