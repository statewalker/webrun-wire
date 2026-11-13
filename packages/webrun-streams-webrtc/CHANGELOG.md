# @statewalker/webrun-streams-webrtc

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
