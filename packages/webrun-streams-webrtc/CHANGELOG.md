# @statewalker/webrun-streams-webrtc

## 0.7.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [10c546a]
  - @statewalker/webrun-streams@0.7.0

## 0.6.2

### Patch Changes

- ae37e5a: `connect` / `serve`: a responder no longer loses its first frames in Chromium (statewalker/statewalker-root#51). When the caller's `open` event came before the responder's `datachannel` event, Chromium could drop what the responder sent before the caller's first frame reached it: a handler that failed at once lost its `ERROR`, and the caller waited for ever. The caller now sends a `HELLO` frame (0x04, ignored by every receiver) as soon as its channel opens, and the responder sends nothing before a frame of the caller's arrived, or `HELLO_FALLBACK_MS` (250 ms) for an older caller. Wire-compatible both ways.
- Updated dependencies [ae60cf6]
  - @statewalker/webrun-streams@0.6.2

## 0.6.1

### Patch Changes

- b50df8e: Security (statewalker/webrun-wire#195): a windowed native port no longer buffers up to the window
  its peer announces (up to 4 GiB) for a peer that stopped reading.
  
  - `@statewalker/webrun-streams`: a windowed native port runs at most min(the peer's window, its
    own window) ahead, and sends no data frame while its channel's pipe says it `needsDrain` (the
    frame waits in the port's queue, which `webrun-rpc`'s stream tier already waits on), so at most
    one frame goes past the transport's buffer. Credit for the peer is held back too while the
    transport needs to drain, and goes as one combined frame afterwards, so a peer that uploads and
    never reads cannot grow this end's write buffer with credit frames. `newNativePortMux` takes
    `drainTimeoutMs`: a write or credit that waited for drain longer fails the port and breaks its
    channel off (a quiet port is never timed out). 0 or `Infinity` means no bound; a negative value
    or `NaN` is a `RangeError`; values past 2^31 − 1 ms are clamped to that. `BytePipeTarget` and `MessagePipeTarget` gain an optional `needsDrain`, which
    `newMessagePipe` sets.
  - `@statewalker/webrun-streams-libp2p`: `messageTargetOverStream` exposes `needsDrain` (libp2p's
    `writableNeedsDrain`); `connect`, `serve`, `serveConnections` and `libp2pPortMux` reset a call's
    stream once a write has waited for drain longer than `drainTimeoutMs` (default 5 minutes; no
    longer deprecated, it now applies to the port protocol too; there, 0 or `Infinity` means no
    bound, while the deprecated protocol still drops at once on 0). A stalled caller announcing a 4 GiB
    window used to make the server hold the whole response (192 MiB in the regression test, 1 GiB in
    the original report); it now holds under 1 KiB and drops the call after the timeout.
  - `@statewalker/webrun-streams-webrtc`: `webrtcPortMux` honours its data channel's buffer
    (`PORT_DRAIN_LOW_WATER`, 256 KiB) on windowed ports and takes `drainTimeoutMs` (default
    `DEFAULT_PORT_DRAIN_TIMEOUT_MS`, 5 minutes). Holding data above 256 KiB buffered may lower
    throughput on links with a large bandwidth-delay product (unmeasured; #189).
- Updated dependencies [b50df8e]
  - @statewalker/webrun-streams@0.6.1

## 0.6.0

### Minor Changes

- d9dc580: Native ports get a per-port flow-control window (statewalker/webrun-wire#153). With `window` (bytes) on both ends, `libp2pPortMux` (protocol `windowProtocolOf(protocol)`, with fallback to `protocol`) and `webrtcPortMux` (data channel `protocol` `WINDOW_CHANNEL_PROTOCOL`, then the serving end's hello) agree a window per port: each end holds the peer's messages to the window it grants, and `webrun-rpc`'s stream tier pipelines chunks on such a port, up to the peer's window in flight, instead of waiting for each chunk's confirmation. A window is at least 64 KiB (`MIN_PORT_WINDOW`), so where the peer is known to speak it, a port pipelines up to that floor from its first message, with no round trip. Off by default; against a peer without it, a port runs as before. The window lives once, in `newNativePortMux` (`window` option, `NativeChannel.window`); `portFlow(port)` exposes its state, and `describePortWindow` in `webrun-streams-conformance` is its contract suite.

### Patch Changes

- Updated dependencies [d9dc580]
  - @statewalker/webrun-streams@0.6.0

## 0.5.0

### Minor Changes

- a3429b4: One port-lifecycle module behind the WebRTC and libp2p native port muxes (#152).
  
  - `@statewalker/webrun-streams` adds `newNativePortMux`. It owns the codec over each channel's bytes, messages held until a port's first listener, close signals, accept and refuse, binding of the caller's signal, and close-all. It also adds the `ValueCodec`, `NativePort` and `NativeChannel` types.
  - `webrtcPortMux` and `libp2pPortMux` are built on it. Each supplies only how to open a channel, how inbound channels arrive, and the channel's bytes: the data channel goes through `newMessagePipe`, the stream through `messageTargetOverStream`.
  - `DataChannelPort` and `StreamPort` are now the shared `NativePort`.
  - libp2p now holds messages that arrive before a port's first listener, as WebRTC did.
  - A frame neither transport can decode now fails the port the same way on both. Over libp2p that still resets the stream.
  - `@statewalker/webrun-streams-conformance` adds `describePortMux`, the contract suite. It runs against an in-memory transport, against libp2p, and against WebRTC (in the browser suite).

### Patch Changes

- e4e6228: A WebRTC port no longer loses what the peer sends as soon as its data channel opens (a regression from #152, not yet released). A `NativeChannel` may now carry `ready`: `newNativePortMux` builds the port, which starts listening and holding messages, before it waits for the channel to open, as `webrtcPortMux` did before #152.
- Updated dependencies [e29084d]
- Updated dependencies [a3429b4]
- Updated dependencies [98242dc]
- Updated dependencies [e4e6228]
  - @statewalker/webrun-streams@0.5.0

## 0.4.1

### Patch Changes

- 98d3f02: `webrtcPortMux`: a message posted on a port whose data channel is still connecting is now queued and sent, in order, when the channel opens, as a `MessagePort` queues it. Before, it was dropped without any error. A message over `maxFrameBytes` still throws `RangeError` at once, and a channel that closes before it opens drops the queue and aborts the port's `closeSignal`.

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- e86fe11: `serve`: a handler that reads its input no longer hangs when the caller cancels or the caller's input throws. The handler's input now ends with the error (its next read throws it instead of reporting a clean end) before the responder waits for its outbound pump, so the handler's `finally` runs (#124).
- e86fe11: `connect()`'s `close()` removes the `connectionstatechange` listener it added to the peer connection, so repeated `connect()` calls no longer accumulate listeners. The receiver now enforces `RECEIVE_WINDOW`: a peer that ignores credit and sends past the window fails the call (queued payload dropped, channel closed) instead of growing the inbound queue without bound (#148).
- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
  - @statewalker/webrun-streams@0.4.0

## 0.3.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- d700267: New `webrtcPortMux(options)`: native MessagePorts over WebRTC. Each port is its own ordered, reliable data channel, labelled `webrun-port/…` and encoded by a value codec (`{ encode: serialize, decode: deserialize }` from `webrun-msgpack`). It is a `webrun-rpc` `PortMux` by shape: pass it to `overPorts`, and `webrun-rpc`'s `connect` / `serve` run each call on its own channel. The port stack keeps a producer within one chunk of a stalled consumer; this package's own `connect` / `serve` allow 4 MiB. The conformance suite passes over these ports with L6 at a one-chunk bound.
  
  - Channels without the label are ignored.
  - `maxMessageSize` defaults to 16 KiB − 256, and a message past 16 KiB fails the port with a `RangeError`.
  - A port carries `closeSignal`, aborted on channel close or error, or on connection failure.
  - A refused port is closed, so the call fails.
  - Messages that arrive before a port's first listener are held for it.
  - On one connection, a caller mux leaves inbound ports to the serving mux, so both directions can call, and of several serving muxes the first takes each port.
  - This package's `serve()` now ignores port channels.
- Updated dependencies [e5e180b]
  - @statewalker/webrun-streams@0.3.0

## 0.2.0

### Minor Changes

- 67a481d: Flow control on each data channel. A sender waits while `bufferedAmount` is above 1 MiB (until `bufferedamountlow` at 256 KiB), and may have at most 4 MiB outstanding that the receiving consumer has not pulled; the receiver returns credit with a new `CREDIT` frame (0x03). A 100 MiB body no longer overflows the browser's send queue, and a slow reader stalls the sender instead of growing an unbounded queue. Wire change: both ends must run this version (an older peer never returns credit, so a newer sender stops after 4 MiB).

## 0.1.6

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
