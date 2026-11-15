# @statewalker/webrun-streams

## 0.5.0

### Minor Changes

- e29084d: **Breaking:** the deprecated misspelt aliases are removed (#150). Import the correctly spelt names instead: `receiveIterator` (was `recieveIterator`) from webrun-streams, `receive` and `ReceiveOptions` (were `recieve` and `RecieveOptions`) from webrun-rpc, and `newInvocationChannel` (was `newInvokationChannel`) from webrun-http-browser. webrun-streams' dormant `flow-control.ts` stays until #153 is decided.
- a3429b4: One port-lifecycle module behind the WebRTC and libp2p native port muxes (#152).
  
  - `@statewalker/webrun-streams` adds `newNativePortMux`. It owns the codec over each channel's bytes, messages held until a port's first listener, close signals, accept and refuse, binding of the caller's signal, and close-all. It also adds the `ValueCodec`, `NativePort` and `NativeChannel` types.
  - `webrtcPortMux` and `libp2pPortMux` are built on it. Each supplies only how to open a channel, how inbound channels arrive, and the channel's bytes: the data channel goes through `newMessagePipe`, the stream through `messageTargetOverStream`.
  - `DataChannelPort` and `StreamPort` are now the shared `NativePort`.
  - libp2p now holds messages that arrive before a port's first listener, as WebRTC did.
  - A frame neither transport can decode now fails the port the same way on both. Over libp2p that still resets the stream.
  - `@statewalker/webrun-streams-conformance` adds `describePortMux`, the contract suite. It runs against an in-memory transport, against libp2p, and against WebRTC (in the browser suite).
- 98242dc: One pipe module behind the four `messageTargetOver*` adapters (#151).
  
  - `@statewalker/webrun-streams` adds `newMessagePipe(transport, options)`. It owns the listener set, delivery that a faulty listener cannot stop, the pipe's life, the byte check on `postMessage`, the frame ceiling, `bufferedAmount` / `whenDrained` and `close()`. A transport supplies only `send`, its buffered bytes, its drain wait and its close.
  - `messageTargetOverWebSocket`, `messageTargetOverPeerJs`, `messageTargetOverLiveKit` and `messageTargetOverByteChannel` are now built on it, and depend on `@statewalker/webrun-streams` at runtime. Each target now carries `closeSignal` and `maxMessageSize`. The WebSocket and byte-channel adapters gain an optional `maxFrameBytes` (unset by default, as before), and the WebSocket adapter an optional `maxMessageSize`.
  - `@statewalker/webrun-rpc`'s `overPipe` takes `signal` and `maxMessageSize` from the pipe's own `closeSignal` and `maxMessageSize` when they are not given, so `overPipe(target, { codec, side })` is enough.
  - `@statewalker/webrun-streams-conformance` adds `describeMessagePipe`, the pipe contract suite. It runs against an in-memory transport and against each adapter.
  
  Existing call sites keep working: adapters still return `{ target, signal, maxMessageSize }`.

### Patch Changes

- e4e6228: A WebRTC port no longer loses what the peer sends as soon as its data channel opens (a regression from #152, not yet released). A `NativeChannel` may now carry `ready`: `newNativePortMux` builds the port, which starts listening and holding messages, before it waits for the channel to open, as `webrtcPortMux` did before #152.

## 0.4.0

### Minor Changes

- cb56b7d: `recieveIterator` is renamed `receiveIterator` (source file `receive-iterator.ts`). The misspelt name stays exported as a `@deprecated` alias of the same function, so existing importers keep working.

### Patch Changes

- cb56b7d: `deserializeError` copies the payload key by key and skips `__proto__` and `constructor`, so a peer can no longer choose the prototype of the rejected error (it is always an `instanceof Error`).
- cb56b7d: `newAsyncGenerator(init, true)`: a queued `done(error?)` is no longer dropped when a value is pushed after it. The consumer now sees the completion and its error; the later value resolves `false`.

## 0.3.0

### Minor Changes

- e5e180b: **Breaking: `emulateMux` is removed (Plan C3).** Every transport now runs `webrun-rpc`'s port stack. Each adapter gives a pipe (`messageTargetOver…`), `overPipe` with `msgpackCodec` invents a port per call on it, and `webrun-rpc`'s `connect` / `serve` run one call per port. On that stack a producer stays at most one chunk ahead of its consumer; `emulateMux` buffered up to its 8 MiB window. The wire format changes, so both ends must upgrade together.
  
  - `webrun-streams`: `emulateMux`, `EmulateMuxOptions` and `ByteChannel` are gone. `newCreditLedger` / `newCreditGrantor` stay exported, dormant, as the mechanism for per-stream windowing (spec D13).
  - `webrun-streams-ws`, `-peerjs`, `-livekit`: the `emulateMux`-based `connect` / `serve` and `byteChannelFromWebSocket` / `byteChannelFromPeerJs` / `byteChannelFromLiveKit` are gone. Use `messageTargetOverWebSocket` / `messageTargetOverPeerJs` / `messageTargetOverLiveKit` with `overPipe` (see each README). None of the three has a runtime dependency left.
  - `webrun-rpc`: `byteChannelFromMessagePort` is gone; a `MessagePort` goes to `overPipe` directly.
  - `webrun-streams-signaling`: `ByteChannel` is now declared here, with the same shape, and the package has no runtime dependency. Import the type from this package instead of `webrun-streams`. New `messageTargetOverByteChannel(channel)` runs the port stack over a channel this package hands back, reporting 16 KiB − 256 as `maxMessageSize`.
  - `webrun-streams-conformance`: comments only. `PairTuning` is unchanged here, and every pair now ignores it until D17 redefines L6.
  - `webrun-http-streams`: comments only. Its peer-error slot test now runs on the port stack.
  
  `webrun-streams-signaling` also fixes `byteChannelFromRoom`, which never ended. It now closes when the room disconnects, when its participant leaves, or when a reliable publish fails, and it ignores packets that carry no participant. Before this, anything run over it (now the port stack) hung when the other end went away.

## 0.2.3

### Patch Changes

- a7d06aa: Module-level constants (text encoders, the close-signal table) are annotated pure, so bundlers drop them with the code that uses them.

## 0.2.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

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

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
