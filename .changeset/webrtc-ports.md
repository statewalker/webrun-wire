---
"@statewalker/webrun-streams-webrtc": patch
---

New `webrtcPortMux(options)`: native MessagePorts over WebRTC. Each port is its own ordered, reliable data channel, labelled `webrun-port/…` and encoded by a value codec (`{ encode: serialize, decode: deserialize }` from `webrun-msgpack`). It is a `webrun-rpc` `PortMux` by shape: pass it to `overPorts`, and `webrun-rpc`'s `connect` / `serve` run each call on its own channel. The port stack keeps a producer within one chunk of a stalled consumer; this package's own `connect` / `serve` allow 4 MiB. The conformance suite passes over these ports with L6 at a one-chunk bound.

- Channels without the label are ignored.
- `maxMessageSize` defaults to 16 KiB − 256, and a message past 16 KiB fails the port with a `RangeError`.
- A port carries `closeSignal`, aborted on channel close or error, or on connection failure.
- A refused port is closed, so the call fails.
- Messages that arrive before a port's first listener are held for it.
