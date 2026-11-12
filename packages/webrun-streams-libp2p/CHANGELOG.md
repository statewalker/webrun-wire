# @statewalker/webrun-streams-libp2p

## 0.3.0

### Minor Changes

- 35a41ba: `connect` / `serve` bound run-ahead past a stalled consumer: the inbound side reads through a
  queue that pauses the stream past `readHighWaterBytes` (default 64 KiB; yamux then withholds
  window updates), and `serve` waits for the handler to read its input queue down before reading
  more (input a handler never started to read is dropped once its output ended). Run-ahead is at
  most two of the receiving node's yamux windows plus about 256 KiB (2.00 MiB measured with
  `streamOptions.maxStreamWindowSize: 1 MiB`). A paused stream raises `maxReadBufferLength` to its
  window so yamux's default 16 MiB window no longer kills a slow consumer's stream; muxers that do
  not expose a window are read as before. New option
  `readHighWaterBytes` on `connect`, `serve` and `serveConnections`.

### Patch Changes

- 9ed3bc7: New `libp2pPortMux(options)` in `webrun-streams-libp2p`: native MessagePorts over libp2p. Each port is its own libp2p stream, multiplexed by yamux, framed by `messageTargetOverStream` and encoded by a value codec (`{ encode: serialize, decode: deserialize }` from `webrun-msgpack`). It is a `webrun-rpc` `PortMux` by shape: pass it to `overPorts`, and `webrun-rpc`'s `connect` / `serve` run each call on its own stream. The port stack's backpressure keeps a producer within one chunk of a consumer that stopped reading. With libp2p's own `connect` / `serve`, a producer gets tens of megabytes ahead and the stream is then aborted.
  
  Native ports and emulated ports (`overPipe` on one `messageTargetOverStream`) both pass the conformance suite with L6 at a one-chunk bound. A port carries `closeSignal`, so a call on a dead stream fails. Ports reuse `connect()`'s early-stream gate. The stream limits default to 1024, because every concurrent call is a stream and libp2p's own default of 32 would reset the 33rd. A refused port is aborted on both ends, and a call on it fails. An undecodable frame fails the port. The serving side gets `{ remotePeer, connection }`.
  
  `messageTargetOverStream` now aborts its `signal` for a stream that ended before it was attached, for example a peer that reset the stream during protocol negotiation. Before, that signal never aborted; it now aborts with `PeerGoneError`. Its target also carries `closeSignal`.
  
  `webrun-rpc`: `MessageTarget` gains the optional `closeSignal`, and `getPortCloseSignal` returns it when no signal was registered with `setPortCloseSignal`. A transport adapter can now supply a port's close signal by shape, without importing `webrun-rpc`.
  
  `webrun-rpc` also fixes a stream-tier bug. A port whose close signal had already aborted when `duplexOverPort` or `serveDuplexOverPort` got it left the stream waiting forever, because an `abort` listener added to an aborted signal never fires. A call on such a port now fails at once.
- Updated dependencies [e5e180b]
  - @statewalker/webrun-streams@0.3.0

## 0.2.0

### Minor Changes

- 74f7c80: A dead peer fails a call instead of hanging it or ending it cleanly.
  
  - A call's output throws `PeerGoneError` when the stream ends before both sides finished it (the peer died, the connection dropped, or a reset after the peer's side ended). A clean end now requires the peer's own close-write, so a truncated response no longer reads as a complete one.
  - A stream that fails mid-read (reset, aborted, its connection dropped) throws `PeerGoneError` with the libp2p error as `cause`, whenever it happens: match on `PeerGoneError` (or its `cause`) rather than libp2p's `StreamResetError`. Errors the peer sent are rethrown unchanged.
  - A call whose input is still open no longer waits for that input once the stream is dead.
  - New `messageTargetOverStream(stream)`: one stream as a message pipe for `multiplexPort` / `overPipe`, with a `signal` that closes the multiplexer when the stream or its connection dies.
  - The target delivers every message the peer sent before `signal` aborts, aborts the stream on a malformed length or one past `maxMessageBytes` (default 64 MiB), and reports `bufferedAmount` (the stream's write buffer) and `whenDrained()` (libp2p's `drain`, or `close`).
  - A serving side no longer logs a caller that sent its whole request and then stopped reading the response.

## 0.1.8

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

## 0.1.7

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.1.2

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

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
