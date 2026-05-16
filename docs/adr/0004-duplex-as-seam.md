# 4. `Duplex` is the canonical adapter seam

Date: 2026-05-16

## Status

Accepted. Supersedes [ADR-0002](./0002-message-port-as-seam.md).

## Context

ADR-0002 (accepted 2026-05-14) made the standard WHATWG `MessagePort` the canonical port seam for every adapter in the `webrun-port-*` family. Two days of work on top of that decision surfaced two structural costs of the seam:

1. **`MessagePort` is a library API, not a JavaScript language construct.** Two-sided cancellation and per-chunk backpressure must be layered on top via `AbortSignal` and `callBidi`'s timeout / callId machinery. The language already provides both for free through `AsyncIterable` + `AsyncGenerator`: consumer `.return()` on an output generator runs the producer's `finally`; producer `throw` propagates to the consumer's `for await`; `await iter.next()` is natural per-chunk backpressure.

2. **`bindBytesToPort`'s outbound queue serialises across logical messages.** [bind-bytes-to-port.ts:30-37](../../packages/webrun-port-core/src/bind-bytes-to-port.ts#L30-L37):
   ```ts
   pendingSend = pendingSend.then(async () => {
     for (const frame of encodeMessage(envelope, mtu)) transport.postChunk(frame);
   });
   ```
   The serial chain is mandatory because `FrameReassembler` requires the CONT-frame sequence of any single logical message to arrive contiguously on the wire. When `callBidi` on channel A ships a 1 MiB chunk, every other channel's frames wait behind it. Cross-stream head-of-line blocking, scaled by the largest individual chunk size, on every adapter built on `bindBytesToPort`.

A stream-shaped seam fixes (1) by construction and admits a frame protocol that fixes (2): every transport message is one self-contained `[streamId][type][payload]` frame, so frames from different streams interleave with no continuation invariant.

The deprecated `(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>` shape in [webrun-http/src/http-send-recieve.ts:50-78](../../packages/webrun-http/src/http-send-recieve.ts#L50-L78) was the original instinct in the codebase; this ADR validates it.

## Decision

The canonical adapter seam is:

```ts
type Duplex = (
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
) => AsyncGenerator<Uint8Array>;
```

Every transport adapter in the `webrun-streams-*` family exposes its public surface in terms of `Duplex` via symmetric factory shapes:

```ts
type Connect<P> = (params: P) => Promise<{ call: Duplex; close: () => Promise<void> }>;
type Serve<P>   = (params: P, handler: Duplex) => Promise<() => Promise<void>>;
```

Caller and handler have identical shape (`Duplex`), so an in-process unit test is `const caller = handler` — no transport, no fixture.

Multi-stream multiplexing is solved per-transport:

- **Native** for libp2p (`node.dialProtocol` / `node.handle` → yamux streams) and WebRTC (one `RTCDataChannel` per call, negotiated label).
- **Emulated** via `emulateMux` from `webrun-streams` for WS, LiveKit, PeerJS, and MessagePort. Wire format: `[varint streamId][1-byte type][payload]` with types `OPEN / DATA / ACK / END / ERROR / CLOSE`. HTTP/2-style even/odd stream-id allocation. Per-stream "one in-flight DATA per stream, await ACK" backpressure — ACKs interleave freely across streams, so cross-stream HoL is eliminated.

Per-call params (HTTP envelopes, RPC headers) travel in-band on the byte stream. The protocol layer chooses its envelope format. `webrun-http-streams` ships the canonical newline-delimited JSON envelope (`encodeMessage` / `decodeMessage`).

## Rationale

- **Language-native semantics.** `Duplex` inherits two-sided cancellation, backpressure, and error propagation directly from JS async generators. No `AbortSignal` plumbing, no `callId` map, no `setTimeout` per chunk.
- **Cross-stream HoL eliminated at the protocol level.** Each `emulateMux` DATA frame fits in one transport message (`≤ mtu - header`); the receiver dispatches by stream-id without continuation state.
- **Symmetric in-process testing.** The factory shape lets `caller = handler` work directly — collapses several layers of fixture infrastructure to nothing.
- **Per-transport optimisation where it matters.** libp2p inherits yamux's credit-window BP and HoL avoidance for free; WebRTC retains per-DataChannel `bufferedAmount` flow control; emulated transports get a uniform shared mux. The seam (`Duplex`) is the same; the implementation behind it can be native where the transport already does the work.
- **Established codebase pattern, un-deprecated.** The `Duplex` shape was already in [webrun-http/src/http-send-recieve.ts](../../packages/webrun-http/src/http-send-recieve.ts) behind a `@deprecated` tag — the legacy `newHttpServer` / `newHttpClient` signature was the right instinct, deprecated for the wrong reason. The new packages remove the deprecation.

## Consequences

- New package family `webrun-streams-*` exposes `Connect` / `Serve` on every adapter. Native multi-stream for libp2p and WebRTC; emulated mux for WS, LiveKit, PeerJS, MessagePort.
- New conformance suite `webrun-streams-conformance`'s `describeDuplexAdapter` asserts the contract at L0 (envelope round-trip), L1 (concurrent calls), L2 (half-close), L3 (mid-stream cancellation), L4 (error propagation with serialised stack), L5 (transport teardown). Reference loopback (`makeLoopbackPair`) self-validates the suite. **10/10 scenarios green** against the loopback, `MessageChannel` pair, in-process `emulateMux` pipe, and a real `WebSocketServer`.
- `webrun-http-streams` carries HTTP envelope handling over `Duplex`. `httpFetch(call, env, body?)` and `httpServe(handler)` are the new primitives; `fetchOverDuplex` / `serveFetchOverDuplex` bridge native `Request` / `Response`.
- Two bugs in `emulateMux` were caught by the conformance suite before any consumer integration: the inbound queue's cancellation hook fired on peer-initiated END (sending an unwanted CLOSE that tore down the still-active outbound half), and `teardownStream` nullified the awaiting ACK resolver before calling it. Both shipped fixes prove the value of the L0–L5 contract.
- The legacy `webrun-port-*` and `webrun-http-port` packages remain published and functional through the v1 cutover. ADR-0002's `MessagePort`-as-seam survives operationally for those packages; deletion is scheduled for a follow-up OpenSpec change after cross-workspace consumers (statewalker-apps demos, etc.) migrate.
- Native-vs-emulated mux divergence is documented, not hidden. libp2p `Duplex`s have credit-window BP and yamux-level HoL avoidance; emulated `Duplex`s have per-chunk ACK BP and serial inter-stream ordering at the transport queue level. Both pass the same `Duplex` contract but their throughput / latency characteristics differ.

## Alternatives considered

1. **Keep `MessagePort` as the canonical seam (status quo).** Rejected. ADR-0002's argument was strong on standards-conformance but didn't address cross-stream HoL or the `AbortSignal`-on-top-of-`callBidi` ergonomic cost; both surface in any real high-throughput multi-stream workload.
2. **`Duplex` + a multiplexer on top, but built using `callBidi` over `bindBytesToPort`.** Rejected. The serial CONT-frame requirement on the underlying byte stream re-introduces cross-stream HoL; the language-native ergonomic claim doesn't land if `callBidi`'s envelope machinery is still in the path. Fresh stream-level `emulateMux` was the only honest fix.
3. **One transport connection per logical call.** Rejected for WS / LiveKit because handshake cost makes it impractical, and acceptable only on libp2p / WebRTC where it's effectively what we do (`newStream` / `createDataChannel` per call).
4. **Yamux-style credit-window BP in `emulateMux` v1.** Deferred. Per-chunk ACK is simpler and matches the existing `ioSend` semantics; credit windows are strictly better for sustained high-throughput uploads but add real protocol complexity. Can be added in a v2 if measurement demands it.

[ADR-0003](./0003-site-handler-as-seam.md) (`SiteHandler` as canonical site/host seam) is unaffected — it sits one layer above the adapter seam. `DuplexSiteBuilder` in `webrun-http-streams` is a new platform host that takes a `SiteHandler` and runs it over a `Connect / Serve` pair; the `SiteHandler` itself doesn't change.
