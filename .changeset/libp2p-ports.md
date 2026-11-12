---
"@statewalker/webrun-streams-libp2p": patch
"@statewalker/webrun-rpc": patch
---

New `libp2pPortMux(options)` in `webrun-streams-libp2p`: native MessagePorts over libp2p. Each port is its own libp2p stream, multiplexed by yamux, framed by `messageTargetOverStream` and encoded by a value codec (`{ encode: serialize, decode: deserialize }` from `webrun-msgpack`). It is a `webrun-rpc` `PortMux` by shape: pass it to `overPorts`, and `webrun-rpc`'s `connect` / `serve` run each call on its own stream. The port stack's backpressure keeps a producer within one chunk of a consumer that stopped reading. With libp2p's own `connect` / `serve`, a producer gets tens of megabytes ahead and the stream is then aborted.

Native ports and emulated ports (`overPipe` on one `messageTargetOverStream`) both pass the conformance suite with L6 at a one-chunk bound. A port carries `closeSignal`, so a call on a dead stream fails. Ports reuse `connect()`'s early-stream gate. A refused port is aborted on both ends. The serving side gets `{ remotePeer, connection }`.

`messageTargetOverStream` now aborts its `signal` for a stream that ended before it was attached, for example a peer that reset the stream during protocol negotiation. Before, that signal never aborted. Its target also carries `closeSignal`.

`webrun-rpc`: `MessageTarget` gains the optional `closeSignal`, and `getPortCloseSignal` returns it when no signal was registered with `setPortCloseSignal`. A transport adapter can now supply a port's close signal by shape, without importing `webrun-rpc`.
