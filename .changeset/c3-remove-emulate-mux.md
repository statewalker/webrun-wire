---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-streams-ws": minor
"@statewalker/webrun-streams-peerjs": minor
"@statewalker/webrun-streams-livekit": minor
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-streams-signaling": minor
"@statewalker/webrun-streams-conformance": patch
"@statewalker/webrun-http-streams": patch
---

**Breaking: `emulateMux` is removed (Plan C3).** Every transport now runs `webrun-rpc`'s port stack. Each adapter gives a pipe (`messageTargetOver…`), `overPipe` with `msgpackCodec` invents a port per call on it, and `webrun-rpc`'s `connect` / `serve` run one call per port. On that stack a producer stays at most one chunk ahead of its consumer; `emulateMux` buffered up to its 8 MiB window. The wire format changes, so both ends must upgrade together.

- `webrun-streams`: `emulateMux`, `EmulateMuxOptions` and `ByteChannel` are gone. `newCreditLedger` / `newCreditGrantor` stay exported, dormant, as the mechanism for per-stream windowing (spec D13).
- `webrun-streams-ws`, `-peerjs`, `-livekit`: the `emulateMux`-based `connect` / `serve` and `byteChannelFromWebSocket` / `byteChannelFromPeerJs` / `byteChannelFromLiveKit` are gone. Use `messageTargetOverWebSocket` / `messageTargetOverPeerJs` / `messageTargetOverLiveKit` with `overPipe` (see each README). None of the three has a runtime dependency left.
- `webrun-rpc`: `byteChannelFromMessagePort` is gone; a `MessagePort` goes to `overPipe` directly.
- `webrun-streams-signaling`: `ByteChannel` is now declared here, with the same shape, and the package has no runtime dependency. Import the type from this package instead of `webrun-streams`. New `messageTargetOverByteChannel(channel)` runs the port stack over a channel this package hands back, reporting 16 KiB − 256 as `maxMessageSize`.
- `webrun-streams-conformance`: comments only. `PairTuning` is unchanged here, and every pair now ignores it until D17 redefines L6.
- `webrun-http-streams`: comments only. Its peer-error slot test now runs on the port stack.

`webrun-streams-signaling` also fixes `byteChannelFromRoom`, which never ended. It now closes when the room disconnects, when its participant leaves, or when a reliable publish fails, and it ignores packets that carry no participant. Before this, anything run over it (now the port stack) hung when the other end went away.
