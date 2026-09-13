# @statewalker/webrun-rpc

## 0.2.0

### Minor Changes

- ff650fc: Replace stop-and-wait flow control with credit-based flow control in `emulateMux`.

  **Wire format changed and is incompatible with peers predating this release.**
  OPEN and ACK frames now carry a uint32 credit payload. A peer running the old
  protocol cannot interoperate with one running this version; both sides of a
  connection must be upgraded together. `emulateMux` now costs one additional
  round trip per stream at open time, to establish the initial credit window.

  Every package that embeds `emulateMux` is bumped explicitly here — rather than
  left to the automatic "dependent" bump — because a dependent-only changelog
  entry does not mention a protocol break, and consumers need to see one:
  `@statewalker/webrun-rpc` (renamed from `@statewalker/webrun-streams-port`),
  `@statewalker/webrun-streams-ws`,
  `@statewalker/webrun-streams-peerjs`, and `@statewalker/webrun-streams-livekit`
  all embed the new wire format and gain a `mux` parameter on their connection
  params (`PortParams`, `ConnectWsParams`/`ServeWsParams`, and the peerjs/livekit
  equivalents). `@statewalker/webrun-streams-webrtc` and
  `@statewalker/webrun-streams-libp2p` multiplex natively and are unaffected;
  they still pick up the automatic dependent bump from
  `updateInternalDependencies: "minor"`.

  `@statewalker/webrun-streams` itself adds new exports (`newCreditLedger`,
  `CreditLedger`, `newCreditGrantor`, `CreditGrantor`) and two smaller behavior
  changes on the same minor: `emulateMux` now throws `RangeError` for
  `maxStreamBuffer < 1`, where it previously accepted it silently, and a
  window above `2^32 - 1` is now advertised as `2^32 - 1` instead of wrapping.

  `@statewalker/webrun-streams-conformance`'s `MakePair` gains a parameter, and
  adds a new L6 conformance level.

  `@statewalker/webrun-http-browser` is bumped explicitly rather than left to
  the dependent bump: `src/core/index.ts` re-exports
  `@statewalker/webrun-streams` in full (`export * from "@statewalker/webrun-streams"`),
  so the four new credit-ledger exports above, plus Task 6's four
  `MessageTarget` types, become public exports of this package too.

  The RPC tier (`webrun-rpc`'s send/receive) is unchanged here; its move from
  `webrun-streams-port` and its retyping to accept any `MessageTarget` are
  credited separately, in the `port-layer-to-webrun-rpc` changeset.

- 3c0f98a: Adds the stream tier and a second port multiplexer.

  `duplexOverPort(port, options)` runs one `Duplex` over one port, and
  `serveDuplexOverPort(port, handler, options)` is its serving half. Each
  direction is one `callPort` per chunk on its own channel; the reply is the
  confirmation and it is withheld until the consumer has pulled past the value,
  so a producer can never run more than one chunk ahead. Memory is bounded by
  construction rather than by a configured ceiling: at most one chunk per open
  port. A peer that sends a second unconfirmed chunk has its call refused and
  that port closed, leaving every other port untouched.

  The stream carries the timeout, and it defaults to **none**. `callPort` gains
  `NO_TIMEOUT` for the same reason: a per-chunk deadline fails a slow consumer,
  which is a bug, not a policy. The regression test is a consumer 1200 ms per
  chunk completing a transfer.

  `transferPortMux(target, options)` is a second `PortMux` whose ports are real
  transferred `MessagePort`s — one `MessageChannel` per `openPort`, one end
  handed to the peer. It needs structured clone with transferables, so it works
  in browsers, workers and iframes and not over byte transports; the caller picks
  it explicitly. Unlike an emulated port, a transferred one can cross a boundary
  and be used by code that never saw the parent port.

  Nothing is removed. `emulateMux`, `connect`/`serve` and the existing
  conformance run are unchanged, and the new stack is proven by a **second**
  conformance run over the same unmodified L0–L6 suite.

  **If you set `maxMessageSize`, leave a margin.** It bounds the **payload**, not
  the frame: `duplexOverPort` chunks to it and the envelope framing is added on
  top afterwards — measured at 123-128 bytes over `@statewalker/webrun-msgpack`'s
  `msgpackCodec`, and not constant, since the call id's length varies per chunk.
  Set it to a transport's exact ceiling and a full-size chunk overruns it, which
  on LiveKit means the body arrives as zero bytes with no error on either side.
  Use `transportLimit - 256`.

- c6dc18d: The port layer moves to `@statewalker/webrun-rpc`, renamed from
  `@statewalker/webrun-streams-port`.

  **Both packages are still on 0.x, where `minor` is the breaking channel, so
  these are declared `minor` and land as 0.2.0 — not `major`, which changesets
  would take straight to 1.0.0. The changes below are breaking regardless of the
  bump level; read them as such.**

  `webrun-rpc` breaks twice over: the npm package name changed, and `openPort`
  is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
  `structuredCodec` and the port envelope types, and its RPC primitives —
  `callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
  `send`, `recieve` — now accept any `MessageTarget` rather than only a
  `MessagePort`.

  `webrun-streams` breaks because it loses those exports. It keeps generic
  stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
  async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
  consumes it and touches nothing port-related.

  `webrun-http-browser` only repoints a one-line re-export, so it is a patch.

- 4f958b9: A port multiplexer, in the package that now defines its central type.

  `multiplexPort` turns one `MessageTarget` into many virtual ones, with explicit
  `open`/`close` lifecycle and an accept callback. Virtual ports are themselves
  `MessageTarget`s, so the multiplexer composes and a real `MessagePort` is
  substitutable for a virtual one.

  Layer 1 has no flow control by design — no backpressure, acknowledgements,
  credit or buffering ceiling — and a message for a port with no consumer is
  dropped rather than queued, so an unaccepted port cannot accumulate memory.

  `structuredCodec` ships here too; a byte codec belongs with
  `@statewalker/webrun-msgpack`. `@statewalker/webrun-streams`, which the
  multiplexer's virtual ports build on, keeps its zero runtime dependencies —
  `webrun-rpc` is the only package that depends on it.

### Patch Changes

- 2291ab3: Cancellation now reaches the producer, across every adapter.

  Nine defects, found by putting one unchanged HTTP site in front of a real
  Chromium and measuring what happened when a caller walked away. They formed a
  chain — each one hid the next, so none could be fixed alone.

  **Teardown that never reached the producer.** `duplexOverStream` awaited a
  `.return()` that is queued behind a pending `next()`, so it hung for ever;
  `emulateMux`'s outbound pump checked `closed` only _after_ a chunk arrived, so
  the producer leaked. Both acquire the iterator once and cancel without awaiting
  now. `framedOutbound` also stopped telling a _server's_ handler that its caller
  had gone — a regression introduced while fixing the first two, and caught by a
  test rather than by review.

  **Cancellation that stopped at the adapter.** `toReadableStream` had no `cancel`
  at all, so a cancelled response body never released the iterator feeding it; it
  also drained its whole source inside a single `pull`, which defeated the
  stream's own backpressure and left no point between chunks at which a
  cancellation could take effect. `fromReadableStream` never released its reader,
  so an early exit — `break`, `.return()`, an error — left the source stream
  uncancelled and its producer running. Between them they broke every abort path
  in the repo.

  **A transport with no cancellation message.** Closing a `MessagePort` does not
  notify its peer, so the ServiceWorker HTTP transport's teardown was invisible on
  the far side and a browser handler kept producing for the life of the page after
  its caller had gone. It sends one now, and the receiving channel releases what
  it is sending — without awaiting, because `.return()` on a parked generator is
  queued behind its own pending `next()`.

  **A worker url that could not be relative.** `new URL("/sw-worker.js")` with no
  base throws `Invalid URL` from a _constructor_, naming neither the option nor
  the value. A worker url is relative to the document that registers it, so it is
  resolved against `location.href` now.

  **A port stack that only accepted `MessagePort`.** `PortParams.port` and
  `byteChannelFromMessagePort` were narrowed to `MessagePort` though neither uses
  more than the `MessageTarget` surface they are otherwise written against. The
  narrowing shut out every virtual port — including one backed by a libp2p stream,
  which is how a mesh hands out ports at all. Found by `tsc`.

  A ServiceWorker _is_ told when its client aborts: `request.signal` never fires
  in Chromium, but the `ReadableStream` given to `respondWith` has its `cancel()`
  invoked. That measurement is what established these as transport defects rather
  than a platform limit, and it was taken with none of the code under suspicion.

  Regression tests live beside each fix: `readable-streams-cancel.test.ts`,
  `emulate-mux-cancel-input.test.ts`, `cancel-open-input.test.ts`,
  `cancel-server-handler.test.ts`, `http-cancel.test.ts` (which reproduces the
  browser leak with two plain `MessagePort`s and no ServiceWorker), and
  `sw-worker-url.test.ts`.

  Backpressure on the deprecated ServiceWorker transport is untouched and its
  deprecation note remains true: `sendStream`'s chunk sender still discards the
  promise it is given.

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

> Released as `@statewalker/webrun-streams-port` up to and including 0.1.1. The package was renamed
> in anticipation of the transport-agnostic RPC tier becoming its sole purpose; the transport role
> (`connect`, `serve`, `byteChannelFromMessagePort`) is still present and is removed in a later
> plan. Entries below that point describe the package under the old name.

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
